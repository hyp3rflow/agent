# @hrmm/agent

Minimal TypeScript agent framework with streaming LLM, tool execution, sub-agents, and sandboxing.

## Features

- **Agent loop** — Streaming responses, automatic tool execution, configurable max turns
- **Providers** — Anthropic and OpenAI with streaming + tool call support
- **Built-in tools** — bash, file-read, file-write, file-edit, ls, grep, glob, fetch
- **Sub-agents** — Wrap any agent as a tool with `agent.asTool()`
- **AgentManager** — Multi-agent lifecycle, run tracking, event bus
- **Sandbox** — Path confinement, command allowlist/banlist, permission grant/deny, network policy
- **MCP** — stdio JSON-RPC client for Model Context Protocol servers
- **Server** — Hono REST API + SSE real-time events
- **Sessions** — In-memory and file-based persistence

## Install

```bash
pnpm add @hrmm/agent
```

## Quick Start

```typescript
import { Agent } from '@hrmm/agent';
import { AnthropicProvider } from '@hrmm/agent/providers';
import { getDefaultTools } from '@hrmm/agent/tools';

const agent = new Agent({
  name: 'coder',
  provider: new AnthropicProvider(),
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You are a helpful coding assistant.',
  tools: getDefaultTools(),
});

for await (const event of agent.run('Create a hello world server')) {
  if (event.type === 'content') process.stdout.write(event.content ?? '');
  if (event.type === 'toolCall') console.log(`\n🔧 ${event.toolCall?.name}`);
  if (event.type === 'done') console.log(`\n✓ ${event.finishReason}`);
}
```

## Agent Manager

Manage multiple agents with run tracking and real-time events:

```typescript
import { AgentManager } from '@hrmm/agent';
import { AnthropicProvider } from '@hrmm/agent/providers';

const manager = new AgentManager();

const id = manager.register({
  name: 'worker',
  provider: new AnthropicProvider(),
  model: 'claude-sonnet-4-20250514',
});

// Listen to events
manager.bus.on('*', (event) => console.log(event.type, event.agentId));

// Start a run
const runId = await manager.startRun(id, 'Explain quicksort');

// Check status
const agents = manager.listAgents();  // [{ id, name, status, totalRuns, ... }]
const runs = manager.listRuns();      // [{ id, agentId, status, events, ... }]
```

## Sandbox

Confine agent operations to a directory with command and network restrictions:

```typescript
import { AgentManager } from '@hrmm/agent';

const manager = new AgentManager();

const id = manager.register(agentConfig, {
  sandbox: {
    rootDir: '/home/user/project',
    allowedCommands: ['*'],
    bannedCommands: ['curl', 'wget', 'sudo'],
    network: 'restricted',
    allowedHosts: ['api.github.com'],
    autoApprove: false, // require permission for non-readonly commands
  },
});

// Grant/deny permissions via manager
const sandbox = manager.getSandbox(id);
sandbox.onPermissionRequest = (req) => {
  console.log(`Permission requested: ${req.description}`);
  sandbox.grantPermission(req.id);
};
```

## Sub-Agents

Compose agents by wrapping one as a tool for another:

```typescript
const researcher = new Agent({
  name: 'researcher',
  provider,
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You research topics and return summaries.',
});

const lead = new Agent({
  name: 'lead',
  provider,
  model: 'claude-sonnet-4-20250514',
  tools: [researcher.asTool({ name: 'research', description: 'Research a topic' })],
});

for await (const event of lead.run('Research and summarize TypeScript 5.7 features')) {
  // lead delegates to researcher automatically
}
```

## REST Server

Serve the agent manager over HTTP with SSE for real-time events:

```typescript
import { AgentManager, createServer } from '@hrmm/agent';
import { serve } from '@hono/node-server';

const manager = new AgentManager();
const app = createServer(manager);

serve({ fetch: app.fetch, port: 7777 });
```

Or use the standalone entry:

```bash
pnpm tsx src/serve.ts --port 7777
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server status |
| GET | `/agents` | List agents |
| GET | `/agents/:id` | Agent detail |
| DELETE | `/agents/:id` | Remove agent |
| POST | `/agents/:id/run` | Start run `{ prompt }` |
| POST | `/agents/:id/cancel` | Cancel run |
| GET | `/agents/:id/session` | Session messages |
| GET | `/agents/:id/events` | SSE stream (per-agent) |
| GET | `/agents/:id/sandbox` | Sandbox status |
| PATCH | `/agents/:id/sandbox` | Update sandbox config |
| POST | `/agents/:id/sandbox/permissions/:id/grant` | Grant permission |
| POST | `/agents/:id/sandbox/permissions/:id/deny` | Deny permission |
| GET | `/runs` | List all runs |
| GET | `/runs/:id` | Run detail with events |
| GET | `/events` | SSE stream (all) |

## Built-in Tools

| Tool | Description |
|------|-------------|
| `bash` | Shell execution with timeout (60s), output cap (30K chars) |
| `file_read` | Read files with line numbers, offset/limit |
| `file_write` | Write files with auto-mkdir |
| `file_edit` | Surgical find/replace |
| `ls` | Tree listing with depth limit |
| `grep` | Regex search via ripgrep with fallback |
| `glob` | File pattern matching |
| `fetch` | HTTP fetch with truncation |

## MCP

Connect to Model Context Protocol servers:

```typescript
import { MCP } from '@hrmm/agent';

const mcp = new MCP('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
await mcp.connect();

const tools = await mcp.listTools(); // Tool[]
const result = await mcp.callTool('read_file', { path: '/tmp/test.txt' });

mcp.disconnect();
```

## Development

```bash
pnpm install
pnpm run build     # tsc
pnpm run test      # vitest (43 tests)
pnpm run dev       # tsc --watch
```

## License

MIT
