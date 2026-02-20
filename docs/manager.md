# AgentManager & WorkflowManager

## AgentManager

Manages multiple agents with run tracking, sessions, sandboxing, and real-time events.

```typescript
import { AgentManager } from '@hrmm/agent';

const manager = new AgentManager();
```

### register(config, options?)

Register an agent. Returns a unique agent ID.

```typescript
const id = manager.register({
  name: 'coder',
  provider: new AnthropicProvider(),
  model: 'claude-sonnet-4-20250514',
  tools: getDefaultTools(),
}, {
  sandbox: { rootDir: '/project', autoApprove: true },
});
```

**RegisterOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `sandbox` | `SandboxConfig?` | Sandbox constraints for this agent |

### remove(agentId)

Remove a registered agent. Returns `boolean`.

### getAgent(agentId)

Returns `{ agent, config, info, sandbox? }` or `undefined`.

### listAgents()

Returns `AgentInfo[]`.

### AgentInfo

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique ID |
| `name` | `string` | Agent name |
| `model` | `string` | Model identifier |
| `status` | `'idle' \| 'running' \| 'error'` | Current status |
| `createdAt` | `number` | Registration timestamp |
| `lastActiveAt` | `number` | Last activity timestamp |
| `totalRuns` | `number` | Cumulative run count |
| `totalTokens` | `TokenUsage` | Cumulative token usage |
| `currentRunId` | `string?` | Active run ID |

### startRun(agentId, prompt, options?)

Start a run in the background. Returns `runId`.

```typescript
const runId = await manager.startRun(id, 'Build a REST API');
```

### cancelRun(agentId)

Cancel the active run for an agent.

### getRun(runId) / listRuns(agentId?)

Query run state.

### RunInfo

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Run ID |
| `agentId` | `string` | Owning agent |
| `status` | `'running' \| 'completed' \| 'error' \| 'canceled'` | Status |
| `prompt` | `string` | Input prompt |
| `startedAt` | `number` | Start timestamp |
| `finishedAt` | `number?` | End timestamp |
| `events` | `AgentEvent[]` | All events from the run |
| `usage` | `TokenUsage?` | Final token usage |

### getSession(agentId) / getSandbox(agentId)

Access the session or sandbox for an agent.

### Event Bus

```typescript
manager.bus.on('*', (event: ManagerEvent) => { ... });
manager.bus.on('run:started', (event) => { ... });
```

**ManagerEvent types:**

| Type | Description |
|------|-------------|
| `agent:registered` | Agent added |
| `agent:removed` | Agent removed |
| `agent:status` | Status changed (idle/running/error) |
| `run:started` | Run began |
| `run:event` | Agent event within a run |
| `run:completed` | Run finished |

---

## WorkflowManager

Tracks workflow runs and their internal state (sub-agents, events, usage).

```typescript
import { WorkflowManager } from '@hrmm/agent';

const wm = new WorkflowManager();
```

### startRun(schema, prompt, options?)

Start a workflow run. Returns `runId`. The run executes in the background.

```typescript
const runId = await wm.startRun(schema, 'Review the codebase', { signal });
```

### getRun(runId)

Returns `WorkflowRunInfo` or `undefined`.

### listRuns(status?)

List all runs, optionally filtered by status (`'running' | 'completed' | 'error' | 'canceled'`).

### getAgents(runId)

Returns `SubAgentInfo[]` for a run.

### getEvents(runId, limit?)

Returns recent `WorkflowEvent[]` (ring buffer, max 200).

### WorkflowRunInfo

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Run ID |
| `name` | `string` | Workflow name |
| `description` | `string?` | Workflow description |
| `status` | `'running' \| 'completed' \| 'error' \| 'canceled'` | Status |
| `prompt` | `string` | Input prompt |
| `startedAt` / `finishedAt` / `duration` | `number` | Timing |
| `main` | `{ model, systemPrompt?, maxTurns? }` | Main agent config snapshot |
| `providers` | `string[]` | Available provider names |
| `defaultProvider` | `string` | Default provider name |
| `tools` | `string[]` | Tool names |
| `delegation` | `object` | Delegation policy snapshot |
| `sandbox` | `object?` | Sandbox config snapshot |
| `agents` | `SubAgentInfo[]` | Sub-agents spawned |
| `usage` | `TokenUsage` | Aggregated usage |
| `output` | `string?` | Final output |
| `result` | `WorkflowResult?` | Final result |
| `recentEvents` | `WorkflowEvent[]` | Event ring buffer |

### SubAgentInfo

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Sub-agent name |
| `model` | `string?` | Model used |
| `status` | `'running' \| 'completed' \| 'error'` | Status |
| `spawnedAt` / `completedAt` | `number` | Timing |
| `prompt` | `string?` | Task given |
| `output` | `string?` | Final output (truncated) |
| `eventCount` | `number` | Events from this agent |

### Event Bus

```typescript
wm.bus.on('*', (event: WorkflowEvent) => { ... });
wm.bus.on('agent:spawned', (event) => { ... });
```

Forwards all `WorkflowEvent` types from managed runs.
