# Workflow

Workflows provide declarative multi-agent orchestration. Define a schema specifying the main agent, providers, tools, delegation policy, and sandbox constraints. The runtime handles agent creation, delegation, event routing, and teardown.

## defineWorkflow()

```typescript
import { defineWorkflow } from '@hrmm/agent';

const workflow = defineWorkflow(schema);
```

Returns a `Workflow` instance. Equivalent to `new Workflow(schema)`.

## WorkflowSchema

```typescript
interface WorkflowSchema {
  name: string;
  description?: string;
  main: {
    model: string;
    systemPrompt?: string;
    maxTurns?: number;
    temperature?: number;
  };
  providers: Record<string, Provider>;
  defaultProvider: string;
  tools?: Tool[];
  sandbox?: SandboxConfig;
  delegation?: DelegationConfig;
  beforeRun?: (ctx: WorkflowContext) => void | Promise<void>;
  afterRun?: (ctx: WorkflowContext, result: WorkflowResult) => void | Promise<void>;
  onSpawn?: (name: string, model: string, prompt: string) => boolean | Promise<boolean>;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Workflow identifier |
| `description` | `string?` | What this workflow does |
| `main` | `object` | Main agent config (model, prompt, turns, temperature) |
| `providers` | `Record<string, Provider>` | Named provider instances |
| `defaultProvider` | `string` | Key into `providers` for the default |
| `tools` | `Tool[]?` | Tools available to all agents |
| `sandbox` | `SandboxConfig?` | Sandbox constraints for the workflow |
| `delegation` | `object?` | Sub-agent spawning policy |
| `beforeRun` | `function?` | Hook before workflow starts |
| `afterRun` | `function?` | Hook after workflow completes |
| `onSpawn` | `function?` | Hook to approve/block sub-agent spawning |

### Delegation Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Allow sub-agent spawning |
| `maxConcurrent` | `number` | `4` | Max simultaneous sub-agents |
| `allowedModels` | `string[]?` | same as main | Models sub-agents can use |
| `maxTurnsPerAgent` | `number` | `20` | Turn limit per sub-agent |
| `inheritTools` | `boolean` | `true` | Sub-agents get the workflow's tools |
| `subAgentTools` | `Tool[]?` | — | Extra tools only for sub-agents |

When delegation is enabled, the main agent gets a `delegate` tool:

```
delegate({ name: "researcher", task: "Find X", model?: "...", provider?: "...", systemPrompt?: "..." })
```

## Workflow.run()

```typescript
async *run(prompt: string, options?: {
  signal?: AbortSignal;
  session?: Session;
  state?: Record<string, unknown>;
}): AsyncGenerator<WorkflowEvent & { result?: WorkflowResult }>
```

Returns an async generator of `WorkflowEvent` objects.

### WorkflowEvent

| Type | Fields | Description |
|------|--------|-------------|
| `workflow:started` | `runId`, `data: { name, prompt }` | Workflow begins |
| `workflow:completed` | `runId`, `data: WorkflowResult`, `result` | Workflow done |
| `workflow:error` | `runId`, `data: { error }`, `result` | Workflow errored |
| `agent:spawned` | `runId`, `agentName`, `data: { model, task }` | Sub-agent created |
| `agent:completed` | `runId`, `agentName`, `data: { output }` | Sub-agent finished |
| `agent:event` | `runId`, `agentName`, `data: AgentEvent` | Forwarded agent event |

### WorkflowResult

| Field | Type | Description |
|-------|------|-------------|
| `runId` | `string` | Run identifier |
| `status` | `'completed' \| 'error' \| 'canceled'` | Final status |
| `output` | `string` | Last assistant message content |
| `usage` | `TokenUsage` | Aggregated token usage |
| `agentsSpawned` | `number` | Total sub-agents created |
| `duration` | `number` | Wall-clock time (ms) |
| `error` | `Error?` | Error if status is `'error'` |

### WorkflowContext

Available in hooks:

| Field | Type | Description |
|-------|------|-------------|
| `runId` | `string` | Current run ID |
| `schema` | `WorkflowSchema` | The workflow schema |
| `state` | `Record<string, unknown>` | Shared mutable state bag |
| `sandbox` | `Sandbox?` | Sandbox instance if configured |
| `bus` | `EventBus<WorkflowEvent>` | Event bus for this run |

## Hooks

```typescript
const workflow = defineWorkflow({
  ...schema,
  beforeRun: async (ctx) => {
    ctx.state.startedBy = 'admin';
  },
  afterRun: async (ctx, result) => {
    console.log(`Completed in ${result.duration}ms, ${result.agentsSpawned} agents`);
  },
  onSpawn: async (name, model, prompt) => {
    // Block expensive models for trivial tasks
    if (model.includes('opus') && prompt.length < 100) return false;
    return true;
  },
});
```

## Example

```typescript
import { defineWorkflow } from '@hrmm/agent';
import { AnthropicProvider } from '@hrmm/agent/providers';
import { getDefaultTools } from '@hrmm/agent/tools';

const workflow = defineWorkflow({
  name: 'build-feature',
  providers: {
    sonnet: new AnthropicProvider(),
    haiku: new AnthropicProvider(),
  },
  defaultProvider: 'sonnet',
  main: {
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'You are a tech lead. Delegate implementation to sub-agents.',
    maxTurns: 30,
  },
  tools: getDefaultTools(),
  delegation: {
    enabled: true,
    maxConcurrent: 3,
    inheritTools: true,
  },
  sandbox: {
    rootDir: './project',
    autoApprove: true,
    network: 'blocked',
  },
});

for await (const event of workflow.run('Add user authentication to the API')) {
  if (event.type === 'agent:spawned') console.log(`🤖 ${event.agentName}`);
  if (event.result) console.log('Done:', event.result.status);
}
```
