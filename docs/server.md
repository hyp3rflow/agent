# Server

Hono-based REST API with SSE for real-time events. Serves both AgentManager and WorkflowManager endpoints.

## Setup

```typescript
import { AgentManager, WorkflowManager, createServer } from '@hrmm/agent';
import { serve } from '@hono/node-server';

const manager = new AgentManager();
const workflows = new WorkflowManager();

// Both managers (full API)
const app = createServer({ manager, workflows });

// Agent manager only (legacy compat)
const app = createServer(manager);

serve({ fetch: app.fetch, port: 7777 });
```

### ServerOptions

| Field | Type | Description |
|-------|------|-------------|
| `manager` | `AgentManager?` | Enables agent/run/sandbox endpoints |
| `workflows` | `WorkflowManager?` | Enables workflow endpoints |

Both are optional — only provided managers get routes.

## Standalone Server

```bash
pnpm tsx src/serve.ts --port 7777
```

Starts with an empty `AgentManager`. Access via `globalThis.__agentManager` to register agents.

## Endpoints

### Health

| Method | Path | Response |
|--------|------|----------|
| GET | `/health` | `{ ok, uptime, agents, workflowRuns }` |

### Agent Endpoints (requires `manager`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents` | List all agents → `AgentInfo[]` |
| GET | `/agents/:id` | Agent detail → `AgentInfo` |
| DELETE | `/agents/:id` | Remove agent |
| POST | `/agents/:id/run` | Start run. Body: `{ prompt }` → `{ runId }` (201) |
| POST | `/agents/:id/cancel` | Cancel active run |
| GET | `/agents/:id/session` | Session messages → `{ id, messages }` |

### Run Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/runs` | List runs. Query: `?agentId=...` |
| GET | `/runs/:id` | Run detail with serialized events |

### Sandbox Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents/:id/sandbox` | Sandbox status → `SandboxStatus` |
| PATCH | `/agents/:id/sandbox` | Update sandbox config |
| POST | `/agents/:id/sandbox/permissions/:permId/grant` | Grant permission |
| POST | `/agents/:id/sandbox/permissions/:permId/deny` | Deny permission |

### SSE Streams (Agent)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents/:id/events` | Per-agent event stream |
| GET | `/events` | Global event stream (all agents) |

Events are `ManagerEvent` objects serialized as JSON. Keepalive ping every 15s.

### Workflow Endpoints (requires `workflows`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/workflows` | List runs. Query: `?status=running`. Returns summaries. |
| GET | `/workflows/:id` | Full run state (without `recentEvents`) |
| GET | `/workflows/:id/agents` | Sub-agents for a run → `SubAgentInfo[]` |
| GET | `/workflows/:id/events` | Recent events. Query: `?limit=100` |
| GET | `/workflows/:id/config` | Workflow config snapshot (main, providers, tools, delegation, sandbox) |

### SSE Streams (Workflow)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/workflows/:id/stream` | Per-run event stream |
| GET | `/workflows/stream` | Global workflow event stream |

Events are `WorkflowEvent` objects. Keepalive ping every 15s.

## Error Responses

All errors return JSON: `{ error: string }` with appropriate HTTP status codes (400, 404).
