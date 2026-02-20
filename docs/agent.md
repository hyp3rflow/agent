# Agent

The `Agent` class is the core execution loop. It takes a prompt, streams LLM responses, executes tool calls, and loops until the model stops or max turns is reached.

## Constructor

```typescript
import { Agent } from '@hrmm/agent';

const agent = new Agent({
  name: 'coder',
  provider: new AnthropicProvider(),
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You are a coding assistant.',
  tools: getDefaultTools(),
  maxTurns: 50,
  maxTokens: 8192,
  temperature: 0.7,
  workingDirectory: '/home/user/project',
  onEvent: (event) => console.log(event.type),
});
```

### AgentConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Agent identifier |
| `provider` | `Provider` | required | LLM provider instance |
| `model` | `string` | required | Model identifier |
| `systemPrompt` | `string` | — | System prompt prepended to conversations |
| `tools` | `Tool[]` | `[]` | Tools available to the agent |
| `maxTurns` | `number` | `50` | Max tool-use loops before stopping |
| `maxTokens` | `number` | — | Max tokens per LLM call (provider default) |
| `temperature` | `number` | — | Sampling temperature |
| `workingDirectory` | `string` | — | Passed to tools via `ToolContext` |
| `onEvent` | `(event: AgentEvent) => void` | — | Global event callback |

## Methods

### `run(content, options?)`

```typescript
async *run(content: string, options?: RunOptions): AsyncGenerator<AgentEvent>
```

Runs the agent loop. Yields `AgentEvent` objects as the conversation progresses.

**RunOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `signal` | `AbortSignal` | Cancel the run |
| `session` | `Session` | Session for message persistence (default: new `InMemorySession`) |
| `images` | `ImageContent[]` | Images to attach to the user message |
| `onEvent` | `(event: AgentEvent) => void` | Per-run event callback |

### `use(toolOrTools)`

```typescript
use(toolOrTools: Tool | Tool[]): this
```

Add tools at runtime. Chainable.

```typescript
agent.use(bashTool).use([grepTool, lsTool]);
```

### `cancel(sessionId)`

```typescript
cancel(sessionId: string): void
```

Abort a running session by its ID.

### `isBusy(sessionId?)`

```typescript
isBusy(sessionId?: string): boolean
```

Check if the agent has active runs. Pass `sessionId` to check a specific session.

### `asTool(options?)`

```typescript
asTool(options?: { description?: string; name?: string }): Tool
```

Wraps the agent as a `Tool` for use by another agent. The tool accepts a `{ prompt }` input, runs the agent on a fresh session, and returns the final assistant message.

```typescript
const researchTool = researcher.asTool({
  name: 'research',
  description: 'Research a topic and return a summary',
});

const lead = new Agent({ ...config, tools: [researchTool] });
```

## Events

The `AgentEvent` type covers all events emitted during a run:

| Type | Fields | Description |
|------|--------|-------------|
| `thinking` | `content` | Extended thinking delta (Anthropic) |
| `content` | `content` | Text content delta |
| `toolCall` | `toolCall` | Tool call detected |
| `toolResult` | `toolResult` | Tool execution result |
| `message` | `message` | Complete message added to session |
| `done` | `finishReason`, `usage` | Run completed |
| `error` | `error` | Error occurred |

**FinishReason values:** `end_turn`, `tool_use`, `max_tokens`, `stop`, `canceled`, `error`

## Execution Flow

1. User message added to session
2. Stream LLM response → yield `thinking`, `content`, `toolCall` events
3. Save assistant message → yield `message`
4. If tool calls present: execute tools → yield `toolResult` → loop to step 2
5. If no tool calls or max turns: yield `done`
