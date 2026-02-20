# @hrmm/agent

Minimal TypeScript agent framework with streaming LLM, tool execution, workflows, and sandboxing.

## Features

- **Agent loop** — Streaming responses, automatic tool execution, configurable max turns
- **Providers** — Anthropic and OpenAI with streaming + tool call support
- **Built-in tools** — bash, file-read/write/edit, ls, grep, glob, fetch, 7 git tools
- **Sub-agents** — Wrap any agent as a tool with `agent.asTool()`
- **Workflows** — Declarative multi-agent orchestration with delegation, hooks, and sandbox constraints
- **WorkflowManager** — Track workflow runs, sub-agent lifecycle, and events
- **AgentManager** — Multi-agent lifecycle, run tracking, event bus
- **Sandbox** — Path confinement, command allowlist/banlist, permission grant/deny, network policy
- **MCP** — stdio JSON-RPC client for Model Context Protocol servers
- **Server** — Hono REST API + SSE for agents, runs, workflows, and sandbox management
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

## Workflows

Declarative multi-agent orchestration with automatic delegation:

```typescript
import { defineWorkflow } from '@hrmm/agent';
import { AnthropicProvider } from '@hrmm/agent/providers';
import { getDefaultTools } from '@hrmm/agent/tools';

const workflow = defineWorkflow({
  name: 'code-review',
  description: 'Review and improve code',
  providers: { anthropic: new AnthropicProvider() },
  defaultProvider: 'anthropic',
  main: { model: 'claude-sonnet-4-20250514', systemPrompt: 'You are a senior engineer.' },
  tools: getDefaultTools(),
  delegation: {
    enabled: true,
    maxConcurrent: 4,
    allowedModels: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250514'],
    inheritTools: true,
  },
  sandbox: { rootDir: '/home/user/project', autoApprove: true },
});

for await (const event of workflow.run('Review src/ for bugs')) {
  if (event.type === 'agent:spawned') console.log(`🤖 Spawned: ${event.agentName}`);
  if (event.result) console.log(`✓ ${event.result.status} (${event.result.agentsSpawned} agents)`);
}
```

## WorkflowManager

Track workflow runs and their internal state:

```typescript
import { WorkflowManager } from '@hrmm/agent';

const wm = new WorkflowManager();
const runId = await wm.startRun(schema, 'Review the codebase');

// Query state
const run = wm.getRun(runId);       // WorkflowRunInfo
const agents = wm.getAgents(runId); // SubAgentInfo[]
const events = wm.getEvents(runId); // WorkflowEvent[]
const all = wm.listRuns('running');  // filter by status

// Real-time events
wm.bus.on('*', (event) => console.log(event.type, event.agentName));
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

manager.bus.on('*', (event) => console.log(event.type, event.agentId));

const runId = await manager.startRun(id, 'Explain quicksort');
const agents = manager.listAgents();
const runs = manager.listRuns();
```

## Sandbox

Confine agent operations with path, command, and network restrictions:

```typescript
const id = manager.register(agentConfig, {
  sandbox: {
    rootDir: '/home/user/project',
    allowedCommands: ['*'],
    bannedCommands: ['curl', 'wget', 'sudo'],
    network: 'restricted',
    allowedHosts: ['api.github.com'],
    autoApprove: false,
  },
});

const sandbox = manager.getSandbox(id);
sandbox.onPermissionRequest = (req) => {
  sandbox.grantPermission(req.id);
};
```

## Sub-Agents

Compose agents by wrapping one as a tool for another:

```typescript
const researcher = new Agent({ name: 'researcher', provider, model, systemPrompt: 'Research topics.' });
const lead = new Agent({
  name: 'lead', provider, model,
  tools: [researcher.asTool({ name: 'research', description: 'Research a topic' })],
});

for await (const event of lead.run('Research TypeScript 5.7 features')) { /* ... */ }
```

## REST Server

Serve agents and workflows over HTTP with SSE:

```typescript
import { AgentManager, WorkflowManager, createServer } from '@hrmm/agent';
import { serve } from '@hono/node-server';

const manager = new AgentManager();
const workflows = new WorkflowManager();
const app = createServer({ manager, workflows });

serve({ fetch: app.fetch, port: 7777 });
```

Or standalone: `pnpm tsx src/serve.ts --port 7777`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health + counts |
| **Agents** | | |
| GET | `/agents` | List agents |
| GET | `/agents/:id` | Agent detail |
| DELETE | `/agents/:id` | Remove agent |
| POST | `/agents/:id/run` | Start run `{ prompt }` |
| POST | `/agents/:id/cancel` | Cancel run |
| GET | `/agents/:id/session` | Session messages |
| GET | `/agents/:id/events` | SSE stream (per-agent) |
| GET | `/agents/:id/sandbox` | Sandbox status |
| PATCH | `/agents/:id/sandbox` | Update sandbox config |
| POST | `/agents/:id/sandbox/permissions/:permId/grant` | Grant permission |
| POST | `/agents/:id/sandbox/permissions/:permId/deny` | Deny permission |
| GET | `/runs` | List all runs |
| GET | `/runs/:id` | Run detail with events |
| GET | `/events` | SSE stream (global) |
| **Workflows** | | |
| GET | `/workflows` | List workflow runs |
| GET | `/workflows/:id` | Workflow run detail |
| GET | `/workflows/:id/agents` | Sub-agents in run |
| GET | `/workflows/:id/events` | Run events (polling) |
| GET | `/workflows/:id/config` | Workflow config snapshot |
| GET | `/workflows/:id/stream` | SSE stream (per-run) |
| GET | `/workflows/stream` | SSE stream (all workflows) |

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

const tools = await MCP.connect('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
agent.use(tools); // Add MCP tools to any agent
```

## Sessions

```typescript
import { InMemorySession, PersistentSession } from '@hrmm/agent';

// In-memory (default)
const session = new InMemorySession();

// File-persisted
const session = PersistentSession.load('session-1', './data/sessions');
```

## Documentation

Detailed API docs in [`docs/`](./docs/):

- [Agent](./docs/agent.md) — Agent class, configuration, events, asTool(), use()
- [Providers](./docs/providers.md) — AnthropicProvider, OpenAIProvider, Provider interface
- [Tools](./docs/tools.md) — Built-in tools, defineTool(), Tool interface
- [Workflow](./docs/workflow.md) — WorkflowSchema, delegation, hooks, defineWorkflow()
- [Manager](./docs/manager.md) — AgentManager, WorkflowManager
- [Sandbox](./docs/sandbox.md) — SandboxConfig, permissions, path/command/network validation
- [Server](./docs/server.md) — Full endpoint reference, ServerOptions, SSE
- [Git Workflow](./docs/git-workflow.md) — Git lifecycle config, 7 git tools
- [MCP](./docs/mcp.md) — MCP client usage
- [Sessions](./docs/sessions.md) — InMemorySession, PersistentSession

## Development

```bash
pnpm install
pnpm run build     # tsc
pnpm run test      # vitest (66 tests)
pnpm run dev       # tsc --watch
```

## License

MIT
