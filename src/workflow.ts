/**
 * Workflow — declarative execution boundary for agent orchestration.
 *
 * You define:
 *   - What the main agent looks like (model, system prompt)
 *   - Which providers are available (agents inside can pick)
 *   - Which tools are in the harness
 *   - Permission/sandbox constraints
 *   - Whether sub-agents can be spawned and how
 *
 * The workflow runtime handles the rest: agent creation, delegation,
 * sub-agent lifecycle, event routing, and teardown.
 */

import { nanoid } from 'nanoid';
import { Agent } from './agent.js';
import { AgentManager } from './manager.js';
import { EventBus } from './events.js';
import { InMemorySession } from './session.js';
import { Sandbox } from './sandbox.js';
import type {
  Provider,
  Tool,
  AgentEvent,
  Session,
  TokenUsage,
} from './types.js';
import type { SandboxConfig } from './sandbox.js';

// ─── Workflow Schema ───

export interface WorkflowSchema {
  /** Workflow name. */
  name: string;

  /** Description of what this workflow accomplishes. */
  description?: string;

  /** Main agent configuration — the entry point. */
  main: {
    model: string;
    systemPrompt?: string;
    /** Max turns for the main agent loop. */
    maxTurns?: number;
    temperature?: number;
  };

  /** Available providers. Key = provider name, agents reference by name. */
  providers: Record<string, Provider>;

  /** Default provider name (must exist in providers). */
  defaultProvider: string;

  /** Tools available in the harness. All agents in this workflow can use these. */
  tools?: Tool[];

  /** Sandbox constraints applied to all agents in this workflow. */
  sandbox?: SandboxConfig;

  /** Sub-agent policy — controls dynamic agent spawning inside the workflow. */
  delegation?: {
    /** Whether the main agent can spawn sub-agents. Default: true. */
    enabled?: boolean;
    /** Max concurrent sub-agents. Default: 4. */
    maxConcurrent?: number;
    /** Models sub-agents are allowed to use. undefined = same as main. */
    allowedModels?: string[];
    /** Max turns per sub-agent. Default: 20. */
    maxTurnsPerAgent?: number;
    /** Whether sub-agents inherit the main agent's tools. Default: true. */
    inheritTools?: boolean;
    /** Additional tools only available to sub-agents. */
    subAgentTools?: Tool[];
  };

  /** Hook: called before the workflow starts. Can modify the schema. */
  beforeRun?: (ctx: WorkflowContext) => void | Promise<void>;

  /** Hook: called after the workflow completes. */
  afterRun?: (ctx: WorkflowContext, result: WorkflowResult) => void | Promise<void>;

  /** Hook: called when a sub-agent is about to be spawned. Return false to block. */
  onSpawn?: (name: string, model: string, prompt: string) => boolean | Promise<boolean>;
}

// ─── Runtime Types ───

export interface WorkflowContext {
  /** Unique run ID. */
  runId: string;
  /** The workflow schema. */
  schema: WorkflowSchema;
  /** Shared state bag — agents can read/write. */
  state: Record<string, unknown>;
  /** The sandbox (if configured). */
  sandbox?: Sandbox;
  /** Event bus for this workflow run. */
  bus: EventBus<WorkflowEvent>;
}

export interface WorkflowResult {
  runId: string;
  status: 'completed' | 'error' | 'canceled';
  output: string;
  usage: TokenUsage;
  agentsSpawned: number;
  duration: number;
  error?: Error;
}

export interface WorkflowEvent {
  type: 'workflow:started' | 'workflow:completed' | 'workflow:error'
    | 'agent:spawned' | 'agent:completed' | 'agent:event';
  runId: string;
  agentName?: string;
  data?: unknown;
  timestamp: number;
}

// ─── Workflow Runtime ───

export class Workflow {
  private schema: WorkflowSchema;

  constructor(schema: WorkflowSchema) {
    this.schema = schema;
  }

  /**
   * Run the workflow with a prompt.
   * Returns an async generator of events, with the final event being the result.
   */
  async *run(prompt: string, options?: {
    signal?: AbortSignal;
    session?: Session;
    state?: Record<string, unknown>;
  }): AsyncGenerator<WorkflowEvent & { result?: WorkflowResult }> {
    const runId = nanoid(12);
    const bus = new EventBus<WorkflowEvent>();
    const sandbox = this.schema.sandbox ? new Sandbox(this.schema.sandbox) : undefined;
    const session = options?.session ?? new InMemorySession();

    const ctx: WorkflowContext = {
      runId,
      schema: this.schema,
      state: options?.state ?? {},
      sandbox,
      bus,
    };

    const startTime = Date.now();
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let agentsSpawned = 0;
    let output = '';

    yield {
      type: 'workflow:started',
      runId,
      data: { name: this.schema.name, prompt },
      timestamp: Date.now(),
    };

    // beforeRun hook
    if (this.schema.beforeRun) {
      await this.schema.beforeRun(ctx);
    }

    // Resolve default provider
    const mainProvider = this.schema.providers[this.schema.defaultProvider];
    if (!mainProvider) {
      const err = new Error(`Default provider "${this.schema.defaultProvider}" not found`);
      yield {
        type: 'workflow:error',
        runId,
        data: { error: err.message },
        timestamp: Date.now(),
        result: {
          runId, status: 'error', output: '', usage: totalUsage,
          agentsSpawned, duration: Date.now() - startTime, error: err,
        },
      };
      return;
    }

    // Build delegation tool — allows main agent to spawn sub-agents
    const delegationEnabled = this.schema.delegation?.enabled !== false;
    const extraTools: Tool[] = [];

    if (delegationEnabled) {
      extraTools.push(this.buildDelegationTool(ctx, mainProvider));
    }

    // Combine tools
    const allTools = [
      ...(this.schema.tools ?? []),
      ...extraTools,
    ];

    // Create main agent
    const mainAgent = new Agent({
      name: `${this.schema.name}:main`,
      provider: mainProvider,
      model: this.schema.main.model,
      systemPrompt: this.buildSystemPrompt(prompt),
      tools: allTools,
      maxTurns: this.schema.main.maxTurns,
      temperature: this.schema.main.temperature,
    });

    // Buffer events from ctx.bus (sub-agent spawns, completions, etc.)
    const busBuffer: (WorkflowEvent & { result?: WorkflowResult })[] = [];
    const unsubBus = ctx.bus.on('*', (event) => {
      busBuffer.push(event);
    });

    try {
      for await (const event of mainAgent.run(prompt, {
        session,
        signal: options?.signal,
      })) {
        // Drain bus buffer first (sub-agent events that fired during tool execution)
        while (busBuffer.length > 0) {
          yield busBuffer.shift()!;
        }

        // Forward agent events
        yield {
          type: 'agent:event',
          runId,
          agentName: 'main',
          data: event,
          timestamp: Date.now(),
        };

        if (event.type === 'message' && event.message?.role === 'assistant') {
          output = event.message.content;
        }

        if (event.usage) {
          totalUsage.inputTokens += event.usage.inputTokens;
          totalUsage.outputTokens += event.usage.outputTokens;
        }

        if (event.type === 'done') {
          const result: WorkflowResult = {
            runId,
            status: event.finishReason === 'canceled' ? 'canceled' : 'completed',
            output,
            usage: totalUsage,
            agentsSpawned,
            duration: Date.now() - startTime,
          };

          if (this.schema.afterRun) {
            await this.schema.afterRun(ctx, result);
          }

          yield {
            type: 'workflow:completed',
            runId,
            data: result,
            timestamp: Date.now(),
            result,
          };
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const result: WorkflowResult = {
        runId,
        status: 'error',
        output,
        usage: totalUsage,
        agentsSpawned,
        duration: Date.now() - startTime,
        error,
      };

      yield {
        type: 'workflow:error',
        runId,
        data: { error: error.message },
        timestamp: Date.now(),
        result,
      };
    } finally {
      // Drain remaining bus events
      while (busBuffer.length > 0) {
        yield busBuffer.shift()!;
      }
      unsubBus();
    }
  }

  private buildSystemPrompt(task: string): string {
    const parts: string[] = [];

    if (this.schema.main.systemPrompt) {
      parts.push(this.schema.main.systemPrompt);
    }

    if (this.schema.delegation?.enabled !== false) {
      parts.push(
        `You can delegate subtasks to specialized sub-agents using the "delegate" tool. ` +
        `Each sub-agent runs independently with its own conversation. ` +
        `Use delegation for parallel work, specialized tasks, or when a subtask needs focused attention. ` +
        `You receive the sub-agent's final response as the tool result.`
      );
    }

    if (this.schema.sandbox) {
      parts.push(
        `You are operating in a sandboxed environment. ` +
        `File operations are restricted to: ${this.schema.sandbox.rootDir}. ` +
        `Some commands may require permission approval.`
      );
    }

    return parts.join('\n\n');
  }

  private buildDelegationTool(ctx: WorkflowContext, fallbackProvider: Provider): Tool {
    const schema = this.schema;
    const delegation = schema.delegation ?? {};
    const maxConcurrent = delegation.maxConcurrent ?? 4;
    const maxTurns = delegation.maxTurnsPerAgent ?? 20;
    const allowedModels = delegation.allowedModels;
    const inheritTools = delegation.inheritTools !== false;
    let activeCount = 0;

    return {
      name: 'delegate',
      description:
        'Spawn a sub-agent to handle a subtask. The sub-agent runs independently and returns its result. ' +
        'Use this for parallel work, specialized tasks, or focused subtasks.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short name for the sub-agent (e.g. "researcher", "coder", "reviewer")',
          },
          task: {
            type: 'string',
            description: 'The task/prompt for the sub-agent. Be specific about what you need.',
          },
          model: {
            type: 'string',
            description: `Model to use. Available: ${Object.keys(schema.providers).join(', ')}. Leave empty for default.`,
          },
          provider: {
            type: 'string',
            description: `Provider to use. Available: ${Object.keys(schema.providers).join(', ')}. Leave empty for default.`,
          },
          systemPrompt: {
            type: 'string',
            description: 'Optional system prompt for the sub-agent. Defaults to a generic assistant prompt.',
          },
        },
        required: ['name', 'task'],
      },
      required: ['name', 'task'],

      async execute(input: string, toolCtx) {
        let params: { name: string; task: string; model?: string; provider?: string; systemPrompt?: string };
        try {
          params = JSON.parse(input);
        } catch {
          return { callId: '', content: 'Invalid JSON input', isError: true };
        }

        // Concurrency check
        if (activeCount >= maxConcurrent) {
          return {
            callId: '',
            content: `Cannot spawn sub-agent: max concurrent limit (${maxConcurrent}) reached. Wait for existing agents to finish.`,
            isError: true,
          };
        }

        // Model validation
        const model = params.model ?? schema.main.model;
        if (allowedModels && !allowedModels.includes(model)) {
          return {
            callId: '',
            content: `Model "${model}" not allowed. Allowed: ${allowedModels.join(', ')}`,
            isError: true,
          };
        }

        // Provider resolution
        const providerName = params.provider ?? schema.defaultProvider;
        const provider = schema.providers[providerName];
        if (!provider) {
          return {
            callId: '',
            content: `Provider "${providerName}" not found. Available: ${Object.keys(schema.providers).join(', ')}`,
            isError: true,
          };
        }

        // onSpawn hook
        if (schema.onSpawn) {
          const allowed = await schema.onSpawn(params.name, model, params.task);
          if (!allowed) {
            return { callId: '', content: 'Sub-agent spawn blocked by workflow policy', isError: true };
          }
        }

        // Build sub-agent tools
        const subTools: Tool[] = [];
        if (inheritTools && schema.tools) {
          subTools.push(...schema.tools);
        }
        if (delegation.subAgentTools) {
          subTools.push(...delegation.subAgentTools);
        }

        // Emit spawn event
        ctx.bus.emit('agent:spawned', {
          type: 'agent:spawned',
          runId: ctx.runId,
          agentName: params.name,
          data: { model, task: params.task },
          timestamp: Date.now(),
        });

        activeCount++;

        try {
          const subAgent = new Agent({
            name: `${schema.name}:${params.name}`,
            provider,
            model,
            systemPrompt: params.systemPrompt ?? `You are a focused sub-agent named "${params.name}". Complete the given task thoroughly and return your result.`,
            tools: subTools,
            maxTurns: maxTurns,
          });

          let lastContent = '';
          const subSession = new InMemorySession();

          for await (const event of subAgent.run(params.task, {
            session: subSession,
            signal: toolCtx.signal,
          })) {
            // Forward sub-agent events
            ctx.bus.emit('agent:event', {
              type: 'agent:event',
              runId: ctx.runId,
              agentName: params.name,
              data: event,
              timestamp: Date.now(),
            });

            if (event.type === 'message' && event.message?.role === 'assistant') {
              lastContent = event.message.content;
            }
          }

          ctx.bus.emit('agent:completed', {
            type: 'agent:completed',
            runId: ctx.runId,
            agentName: params.name,
            data: { output: lastContent.slice(0, 200) },
            timestamp: Date.now(),
          });

          return { callId: '', content: lastContent || '(no response from sub-agent)' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { callId: '', content: `Sub-agent error: ${msg}`, isError: true };
        } finally {
          activeCount--;
        }
      },
    };
  }
}

// ─── Helper: define a workflow from schema ───

export function defineWorkflow(schema: WorkflowSchema): Workflow {
  return new Workflow(schema);
}
