# MCP Client

Connect to [Model Context Protocol](https://modelcontextprotocol.io) servers via stdio.

## Usage

```typescript
import { MCP } from '@hrmm/agent';

const mcp = new MCP('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
await mcp.connect();

// List available tools
const tools = await mcp.listTools(); // Tool[] compatible with Agent

// Call a tool directly
const result = await mcp.callTool('read_file', { path: '/tmp/test.txt' });

// Use with an agent
const agent = new Agent({
  name: 'with-mcp',
  provider,
  model,
  tools: [...builtinTools, ...tools],
});

// Cleanup
mcp.disconnect();
```

## API

| Method | Returns | Description |
|--------|---------|-------------|
| `new MCP(command, args)` | `MCP` | Create client (doesn't connect yet) |
| `connect()` | `Promise<void>` | Spawn process + JSON-RPC initialize |
| `listTools()` | `Promise<Tool[]>` | Get tools (Agent-compatible) |
| `callTool(name, args)` | `Promise<ToolResult>` | Execute a tool |
| `disconnect()` | `void` | Kill the subprocess |

## Protocol

Uses JSON-RPC 2.0 over stdio:
- `initialize` — Handshake with capabilities
- `tools/list` — List available tools
- `tools/call` — Execute a tool with arguments

Tools returned by `listTools()` implement the `Tool` interface and can be passed directly to `Agent.tools` or `WorkflowSchema.tools`.
