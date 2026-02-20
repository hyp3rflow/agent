import { nanoid } from 'nanoid';
import { InMemorySession } from './session.js';
import type {
  AgentConfig,
  AgentEvent,
  ImageContent,
  Message,
  ProviderEvent,
  RunOptions,
  Session,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from './types.js';

const DEFAULT_MAX_TURNS = 50;

export class Agent {
  readonly name: string;
  private config: AgentConfig;
  private tools: Map<string, Tool>;
  private abortControllers = new Map<string, AbortController>();

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.config = config;
    this.tools = new Map();
    if (config.tools) {
      for (const tool of config.tools) {
        this.tools.set(tool.name, tool);
      }
    }
  }

  use(toolOrTools: Tool | Tool[]): this {
    const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  async *run(content: string, options: RunOptions = {}): AsyncGenerator<AgentEvent> {
    const session = options.session ?? new InMemorySession();
    const images = options.images ?? [];
    yield* this.loop(session, content, images, options);
  }

  cancel(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }

  isBusy(sessionId?: string): boolean {
    if (sessionId) return this.abortControllers.has(sessionId);
    return this.abortControllers.size > 0;
  }

  asTool(options?: { description?: string; name?: string }): Tool {
    const agent = this;
    const toolName = options?.name ?? `agent_${this.name}`;
    const toolDesc = options?.description ?? `Sub-agent: ${this.name}`;

    return {
      name: toolName,
      description: toolDesc,
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt to send to the sub-agent' },
        },
        required: ['prompt'],
      },
      required: ['prompt'],
      async execute(input: string, context: ToolContext): Promise<ToolResult> {
        try {
          const parsed = JSON.parse(input);
          const prompt = typeof parsed === 'string' ? parsed : parsed.prompt;
          let lastContent = '';

          const subSession = new InMemorySession();
          for await (const event of agent.run(prompt, {
            session: subSession,
            signal: context.signal,
          })) {
            if (event.type === 'message' && event.message?.role === 'assistant') {
              lastContent = event.message.content;
            }
          }

          return { callId: '', content: lastContent || '(no response)' };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { callId: '', content: message, isError: true };
        }
      },
    };
  }

  private async *loop(
    session: Session,
    content: string,
    images: ImageContent[],
    options: RunOptions,
  ): AsyncGenerator<AgentEvent> {
    const maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;
    const controller = new AbortController();
    const sessionId = session.id;
    this.abortControllers.set(sessionId, controller);

    // Link external signal
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const emit = (event: AgentEvent): void => {
      this.config.onEvent?.(event);
      options.onEvent?.(event);
    };

    try {
      // Add user message
      const userMsg: Message = {
        id: nanoid(),
        role: 'user',
        content,
        images: images.length > 0 ? images : undefined,
        timestamp: Date.now(),
      };
      session.addMessage(userMsg);

      for (let turn = 0; turn < maxTurns; turn++) {
        if (controller.signal.aborted) {
          yield { type: 'done', finishReason: 'canceled' };
          return;
        }

        // Build tool definitions
        const toolDefs: ToolDefinition[] = [];
        for (const tool of this.tools.values()) {
          toolDefs.push({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            required: tool.required,
          });
        }

        // Stream from provider
        let assistantContent = '';
        let finishReason: AgentEvent['finishReason'] = 'end_turn';
        const toolCalls: ToolCall[] = [];
        let currentToolInput = '';
        let currentToolCall: ToolCall | null = null;
        let usage: AgentEvent['usage'] = undefined;

        try {
          for await (const event of this.config.provider.stream(
            session.getMessages(),
            {
              model: this.config.model,
              systemPrompt: this.config.systemPrompt,
              maxTokens: this.config.maxTokens,
              temperature: this.config.temperature,
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              signal: controller.signal,
            },
          )) {
            if (controller.signal.aborted) break;

            switch (event.type) {
              case 'thinking_delta':
                yield { type: 'thinking', content: event.content };
                emit({ type: 'thinking', content: event.content });
                break;

              case 'content_delta':
                assistantContent += event.content ?? '';
                yield { type: 'content', content: event.content };
                emit({ type: 'content', content: event.content });
                break;

              case 'tool_use_start':
                currentToolCall = event.toolCall ?? null;
                currentToolInput = '';
                break;

              case 'tool_use_delta':
                currentToolInput += event.content ?? '';
                break;

              case 'tool_use_stop':
                if (currentToolCall) {
                  const tc: ToolCall = {
                    id: currentToolCall.id,
                    name: currentToolCall.name,
                    input: currentToolInput,
                  };
                  toolCalls.push(tc);
                  yield { type: 'toolCall', toolCall: tc };
                  emit({ type: 'toolCall', toolCall: tc });
                  currentToolCall = null;
                  currentToolInput = '';
                }
                break;

              case 'complete':
                if (event.response) {
                  finishReason = event.response.finishReason;
                  usage = event.response.usage;
                  // Merge any tool calls from complete event
                  for (const tc of event.response.toolCalls) {
                    if (!toolCalls.find((t) => t.id === tc.id)) {
                      toolCalls.push(tc);
                      yield { type: 'toolCall', toolCall: tc };
                      emit({ type: 'toolCall', toolCall: tc });
                    }
                  }
                }
                break;

              case 'error':
                yield { type: 'error', error: event.error };
                emit({ type: 'error', error: event.error });
                break;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) {
            yield { type: 'done', finishReason: 'canceled' };
            return;
          }
          const error = err instanceof Error ? err : new Error(String(err));
          yield { type: 'error', error };
          emit({ type: 'error', error });
          yield { type: 'done', finishReason: 'error' };
          return;
        }

        // Save assistant message
        const assistantMsg: Message = {
          id: nanoid(),
          role: 'assistant',
          content: assistantContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          model: this.config.model,
          timestamp: Date.now(),
          usage,
        };
        session.addMessage(assistantMsg);
        yield { type: 'message', message: assistantMsg };
        emit({ type: 'message', message: assistantMsg });

        // If no tool calls, we're done
        if (toolCalls.length === 0 || finishReason !== 'tool_use') {
          yield { type: 'done', finishReason, usage };
          return;
        }

        // Execute tool calls
        const context: ToolContext = {
          sessionId: session.id,
          agentName: this.name,
          signal: controller.signal,
          workingDirectory: this.config.workingDirectory,
        };

        const results = await this.executeToolCalls(toolCalls, context);

        // Save tool results as a tool message
        const toolMsg: Message = {
          id: nanoid(),
          role: 'tool',
          content: results.map((r) => r.content).join('\n\n'),
          toolResults: results,
          timestamp: Date.now(),
        };
        session.addMessage(toolMsg);

        for (const result of results) {
          yield { type: 'toolResult', toolResult: result };
          emit({ type: 'toolResult', toolResult: result });
        }

        // Loop continues — provider will see tool results and respond
      }

      // Exceeded max turns
      yield { type: 'done', finishReason: 'max_tokens' };
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    context: ToolContext,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const tc of toolCalls) {
      if (context.signal.aborted) {
        results.push({ callId: tc.id, content: 'Canceled', isError: true });
        continue;
      }

      const tool = this.tools.get(tc.name);
      if (!tool) {
        results.push({
          callId: tc.id,
          content: `Unknown tool: ${tc.name}`,
          isError: true,
        });
        continue;
      }

      try {
        const result = await tool.execute(tc.input, context);
        results.push({ ...result, callId: tc.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ callId: tc.id, content: message, isError: true });
      }
    }

    return results;
  }
}
