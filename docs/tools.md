# Tools

Tools give agents the ability to interact with the environment. Each tool has a JSON Schema for its parameters and an `execute` function.

## Tool Interface

```typescript
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
  readonly required?: string[];
  execute(input: string, context: ToolContext): Promise<ToolResult>;
}
```

### ToolContext

Passed to every tool execution:

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Current session ID |
| `agentName` | `string` | Owning agent's name |
| `signal` | `AbortSignal` | Cancellation signal |
| `workingDirectory` | `string?` | Agent's configured working directory |

### ToolResult

| Field | Type | Description |
|-------|------|-------------|
| `callId` | `string?` | Matched to the tool call ID |
| `content` | `string` | Result text |
| `isError` | `boolean?` | Whether this is an error result |
| `metadata` | `string?` | Optional metadata |

## defineTool()

Helper to create tools with type safety:

```typescript
import { defineTool } from '@hrmm/agent';

const myTool = defineTool({
  name: 'my_tool',
  description: 'Does something useful',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input' },
    },
  },
  required: ['input'],
  async execute(input, context) {
    const { input: text } = JSON.parse(input);
    return { content: `Processed: ${text}` };
  },
});
```

## Built-in Tools

Import individually or as a set:

```typescript
import { getDefaultTools, getReadOnlyTools } from '@hrmm/agent/tools';
import { bashTool, fileReadTool, grepTool } from '@hrmm/agent/tools';

// All 8 tools
const tools = getDefaultTools();

// Read-only subset (file_read, ls, grep, glob, fetch)
const safe = getReadOnlyTools();
```

### bash

Shell command execution.

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | `string` | Shell command to run |
| `timeout` | `number?` | Timeout in ms (default: 60000) |

- Output capped at 30K characters
- Runs in `workingDirectory` if set
- Supports cancellation via AbortSignal

### file_read

Read file contents.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | File path |
| `offset` | `number?` | Start line (1-indexed) |
| `limit` | `number?` | Max lines to read |

### file_write

Write content to a file.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | File path |
| `content` | `string` | Content to write |

- Auto-creates parent directories

### file_edit

Find-and-replace in a file.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | File path |
| `old_string` | `string` | Exact text to find |
| `new_string` | `string` | Replacement text |

### ls

Directory listing.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | Directory path |
| `depth` | `number?` | Max depth (default: 3) |

### grep

Search files with regex.

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | `string` | Regex pattern |
| `path` | `string?` | Search root |
| `include` | `string?` | File glob filter |

- Uses ripgrep (`rg`) when available, falls back to `grep -r`

### glob

File pattern matching.

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | `string` | Glob pattern |
| `cwd` | `string?` | Base directory |

### fetch

HTTP fetch.

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | `string` | URL to fetch |
| `method` | `string?` | HTTP method (default: GET) |
| `headers` | `object?` | Request headers |
| `body` | `string?` | Request body |

- Response truncated to 30K characters

## Adding Tools to Agents

```typescript
// At construction
const agent = new Agent({ ...config, tools: [bashTool, myTool] });

// At runtime (chainable)
agent.use(myTool);
agent.use([tool1, tool2]);
```
