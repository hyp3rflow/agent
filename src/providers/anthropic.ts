import Anthropic from '@anthropic-ai/sdk';
import type {
  Provider, ProviderOptions, ProviderEvent,
  Message, ToolCall, TokenUsage, FinishReason,
} from '../types.js';

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    });
  }

  async *stream(messages: Message[], options: ProviderOptions): AsyncIterable<ProviderEvent> {
    const mapped = this.mapMessages(messages);
    const tools = options.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
    }));

    const params: Anthropic.Messages.MessageCreateParamsStreaming = {
      model: options.model,
      max_tokens: options.maxTokens ?? 8192,
      messages: mapped,
      stream: true as const,
      ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
      ...(tools?.length ? { tools } : {}),
    };

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: ToolCall[] = [];
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';
    let finishReason: FinishReason = 'end_turn';

    try {
      const stream = this.client.messages.stream(params, { signal: options.signal });

      for await (const event of stream) {
        if (event.type === 'message_start') {
          const msg = (event as any).message;
          if (msg?.usage) {
            usage.inputTokens = msg.usage.input_tokens ?? 0;
            usage.outputTokens = msg.usage.output_tokens ?? 0;
            if (msg.usage.cache_read_input_tokens) usage.cacheReadTokens = msg.usage.cache_read_input_tokens;
            if (msg.usage.cache_creation_input_tokens) usage.cacheCreationTokens = msg.usage.cache_creation_input_tokens;
          }
        } else if (event.type === 'message_delta') {
          const delta = (event as any).usage;
          if (delta?.output_tokens) usage.outputTokens = delta.output_tokens;
          const stopReason = (event as any).delta?.stop_reason;
          if (stopReason) finishReason = this.mapStopReason(stopReason);
        } else if (event.type === 'content_block_start') {
          const block = (event as any).content_block;
          if (block?.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolInput = '';
            yield { type: 'tool_use_start', toolCall: { id: block.id, name: block.name, input: '' } };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = (event as any).delta;
          if (delta?.type === 'text_delta') {
            yield { type: 'content_delta', content: delta.text };
          } else if (delta?.type === 'thinking_delta') {
            yield { type: 'thinking_delta', content: delta.thinking };
          } else if (delta?.type === 'input_json_delta') {
            currentToolInput += delta.partial_json;
            yield { type: 'tool_use_delta', content: delta.partial_json };
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolId) {
            const tc: ToolCall = { id: currentToolId, name: currentToolName, input: currentToolInput };
            toolCalls.push(tc);
            yield { type: 'tool_use_stop', toolCall: tc };
            currentToolId = '';
            currentToolName = '';
            currentToolInput = '';
          }
        }
      }

      yield {
        type: 'complete',
        response: { finishReason, toolCalls, usage },
      };
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async complete(messages: Message[], options: ProviderOptions) {
    let content = '';
    const toolCalls: ToolCall[] = [];
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: FinishReason = 'end_turn';

    for await (const event of this.stream(messages, options)) {
      if (event.type === 'content_delta') content += event.content ?? '';
      if (event.type === 'complete' && event.response) {
        toolCalls.push(...event.response.toolCalls);
        usage = event.response.usage;
        finishReason = event.response.finishReason;
      }
      if (event.type === 'error') throw event.error;
    }

    return { content, toolCalls, usage, finishReason };
  }

  private mapMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
    const result: Anthropic.Messages.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue; // system handled via systemPrompt

      if (msg.role === 'assistant') {
        const blocks: Anthropic.Messages.ContentBlockParam[] = [];
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            let input: unknown = {};
            try { input = JSON.parse(tc.input); } catch { /* empty */ }
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
          }
        }
        result.push({ role: 'assistant', content: blocks.length ? blocks : msg.content });
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results → user message with tool_result blocks
        const blocks: Anthropic.Messages.ToolResultBlockParam[] = [];
        if (msg.toolResults) {
          for (const tr of msg.toolResults) {
            blocks.push({
              type: 'tool_result',
              tool_use_id: tr.callId ?? '',
              content: tr.content,
              ...(tr.isError ? { is_error: true } : {}),
            });
          }
        }
        if (blocks.length) {
          result.push({ role: 'user', content: blocks });
        } else {
          result.push({ role: 'user', content: msg.content });
        }
        continue;
      }

      // user message
      const blocks: Anthropic.Messages.ContentBlockParam[] = [];
      if (msg.images) {
        for (const img of msg.images) {
          if (img.type === 'base64') {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: img.data,
              },
            });
          } else {
            blocks.push({
              type: 'image',
              source: { type: 'url', url: img.data },
            });
          }
        }
      }
      if (msg.content) {
        blocks.push({ type: 'text', text: msg.content });
      }
      result.push({ role: 'user', content: blocks.length ? blocks : msg.content });
    }

    return result;
  }

  private mapStopReason(reason: string): FinishReason {
    switch (reason) {
      case 'end_turn': return 'end_turn';
      case 'tool_use': return 'tool_use';
      case 'max_tokens': return 'max_tokens';
      default: return 'end_turn';
    }
  }
}
