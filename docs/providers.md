# Providers

Providers connect the agent to LLM APIs. Each provider implements the `Provider` interface with `stream()` and `complete()` methods.

## Provider Interface

```typescript
interface Provider {
  readonly name: string;
  stream(messages: Message[], options: ProviderOptions): AsyncIterable<ProviderEvent>;
  complete(messages: Message[], options: ProviderOptions): Promise<{
    content: string;
    toolCalls: ToolCall[];
    usage: TokenUsage;
    finishReason: FinishReason;
  }>;
}
```

### ProviderOptions

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Model identifier |
| `systemPrompt` | `string` | System prompt |
| `maxTokens` | `number` | Max output tokens |
| `temperature` | `number` | Sampling temperature |
| `tools` | `ToolDefinition[]` | Available tools |
| `signal` | `AbortSignal` | Cancellation signal |

### ProviderEvent

| Type | Fields | Description |
|------|--------|-------------|
| `thinking_delta` | `content` | Extended thinking text |
| `content_delta` | `content` | Response text |
| `tool_use_start` | `toolCall` | Tool call begins (id + name) |
| `tool_use_delta` | `content` | Tool input JSON chunk |
| `tool_use_stop` | `toolCall` | Tool call complete |
| `error` | `error` | Provider error |
| `complete` | `response` | Final response with usage, tool calls, finish reason |

## AnthropicProvider

```typescript
import { AnthropicProvider } from '@hrmm/agent/providers';

const provider = new AnthropicProvider({
  apiKey: 'sk-...',    // default: ANTHROPIC_API_KEY env
  baseUrl: '...',      // optional custom endpoint
});
```

- Uses `@anthropic-ai/sdk`
- Supports streaming, tool use, extended thinking, image content (base64 + URL)
- Default max tokens: 8192
- Maps `tool` messages to `tool_result` blocks in user messages (per Anthropic format)

## OpenAIProvider

```typescript
import { OpenAIProvider } from '@hrmm/agent/providers';

const provider = new OpenAIProvider({
  apiKey: 'sk-...',    // default: OPENAI_API_KEY env
  baseUrl: '...',      // optional (e.g., for Azure, local models)
});
```

- Uses `openai` SDK
- Supports streaming with `stream_options: { include_usage: true }`
- Maps tool calls via `function` calling format
- Image content via `image_url` parts

## Custom Providers

Implement the `Provider` interface:

```typescript
const customProvider: Provider = {
  name: 'custom',
  async *stream(messages, options) {
    // yield ProviderEvent objects
    yield { type: 'content_delta', content: 'Hello' };
    yield { type: 'complete', response: { finishReason: 'end_turn', toolCalls: [], usage: { inputTokens: 0, outputTokens: 1 } } };
  },
  async complete(messages, options) {
    // collect from stream
  },
};
```
