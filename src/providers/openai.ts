import OpenAI from 'openai';
import type {
  Provider, ProviderOptions, ProviderEvent,
  Message, ToolCall, TokenUsage, FinishReason,
} from '../core/types.js';

export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    });
  }

  async *stream(messages: Message[], options: ProviderOptions): AsyncIterable<ProviderEvent> {
    const mapped = this.mapMessages(messages, options.systemPrompt);
    const tools = options.tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: options.model,
      messages: mapped,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
      ...(tools?.length ? { tools } : {}),
    };

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: FinishReason = 'end_turn';

    try {
      const stream = await this.client.chat.completions.create(params, { signal: options.signal });

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
          usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        }

        if (!choice) continue;

        if (choice.finish_reason) {
          finishReason = this.mapFinishReason(choice.finish_reason);
        }

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: 'content_delta', content: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
              yield {
                type: 'tool_use_start',
                toolCall: { id: tc.id ?? '', name: tc.function?.name ?? '', input: '' },
              };
            }
            const accum = toolCallAccum.get(idx)!;
            if (tc.id) accum.id = tc.id;
            if (tc.function?.name) accum.name = tc.function.name;
            if (tc.function?.arguments) {
              accum.args += tc.function.arguments;
              yield { type: 'tool_use_delta', content: tc.function.arguments };
            }
          }
        }
      }

      const toolCalls: ToolCall[] = [];
      for (const [, accum] of toolCallAccum) {
        const tc: ToolCall = { id: accum.id, name: accum.name, input: accum.args };
        toolCalls.push(tc);
        yield { type: 'tool_use_stop', toolCall: tc };
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

  private mapMessages(messages: Message[], systemPrompt?: string): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        if (msg.toolResults) {
          for (const tr of msg.toolResults) {
            result.push({
              role: 'tool' as const,
              content: tr.content,
              tool_call_id: tr.callId ?? '',
            });
          }
        } else {
          result.push({ role: 'tool' as const, content: msg.content, tool_call_id: '' });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        const assistantMsg: any = { role: 'assistant' };
        if (msg.content) assistantMsg.content = msg.content;
        if (msg.toolCalls?.length) {
          assistantMsg.tool_calls = msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.input },
          }));
        }
        if (!assistantMsg.content && !assistantMsg.tool_calls) assistantMsg.content = '';
        result.push(assistantMsg);
        continue;
      }

      // user
      if (msg.images?.length) {
        const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
        for (const img of msg.images) {
          const url = img.type === 'base64'
            ? `data:${img.mimeType};base64,${img.data}`
            : img.data;
          parts.push({ type: 'image_url', image_url: { url } });
        }
        if (msg.content) {
          parts.push({ type: 'text', text: msg.content });
        }
        result.push({ role: 'user', content: parts });
      } else {
        result.push({ role: 'user', content: msg.content });
      }
    }

    return result;
  }

  private mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'stop': return 'end_turn';
      case 'tool_calls': return 'tool_use';
      case 'length': return 'max_tokens';
      default: return 'end_turn';
    }
  }
}
