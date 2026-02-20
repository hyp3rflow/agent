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
import { Agent } from '../core/agent.js';
import { AgentManager } from '../manager/manager.js';
import { EventBus } from '../core/events.js';
import { InMemorySession } from '../core/session.js';
import { Sandbox } from '../sandbox/sandbox.js';
import type {
  Provider,
  Tool,
  AgentEvent,
  Session,
  TokenUsage,
} from '../core/types.js';
import type { SandboxConfig } from '../sandbox/sandbox.js';
import { gitTools as builtinGitTools } from '../tools/git.js';

// ─── Git Workflow Config ───

export interface GitWorkflowConfig {
  /** Path to the git repository root. Defaults to sandbox.rootDir or cwd. */
  repoDir?: string;

  /** Branch strategy when a workflow run starts. */
  branch?: {
    /** Create a new branch for this run. The name can include {runId}, {name}, {date} placeholders. */
    create?: string;
    /** Base ref to branch from (default: current HEAD). */
    from?: string;
    /** Switch to an existing branch instead of creating. */
    checkout?: string;
  };

  /** Auto-commit strategy. */
  commit?: {
    /** When to auto-commit: 'on-complete' (default), 'per-iteration', 'never'. */
    strategy?: 'on-complete' | 'per-iteration' | 'never';
    /** Commit message template. Supports {name}, {runId}, {status} placeholders. */
    messageTemplate?: string;
    /** Whether to stage all changes or only tracked files. Default: true (all). */
    stageAll?: boolean;
  };

  /** Auto-push after commit. */
  push?: {
    /** Enable auto-push. Default: false. */
    enabled?: boolean;
    /** Remote name. Default: 'origin'. */
    remote?: string;
    /** Set upstream on first push. Default: true. */
    setUpstream?: boolean;
  };

  /** Stash uncommitted changes before starting, restore on error. Default: false. */
  stashBeforeRun?: boolean;

  /** Include git tools (status, diff, log, commit, branch, push, stash) automatically. Default: true. */
  includeGitTools?: boolean;
}

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

  /** Git workflow configuration — branch strategy, auto-commit, auto-push. */
  git?: GitWorkflowConfig;

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

// ─── Git Helpers ───

function resolveGitDir(schema: WorkflowSchema): string {
  return schema.git?.repoDir ?? schema.sandbox?.rootDir ?? process.cwd();
}

function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

async function execGit(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('close', (code) => resolve({ ok: code === 0, output: out.trim() }));
    proc.on('error', (err) => resolve({ ok: false, output: err.message }));
  });
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

    // ─── Git lifecycle: setup ───
    const gitConf = this.schema.git;
    const gitDir = resolveGitDir(this.schema);
    let gitStashed = false;

    if (gitConf) {
      // Stash uncommitted changes if requested
      if (gitConf.stashBeforeRun) {
        const { ok } = await execGit(['stash', 'push', '-m', `tycoon-run-${runId}`], gitDir);
        if (ok) gitStashed = true;
      }

      // Branch setup
      if (gitConf.branch?.create) {
        const branchName = expandTemplate(gitConf.branch.create, {
          runId, name: this.schema.name, date: new Date().toISOString().slice(0, 10),
        });
        const args = ['checkout', '-b', branchName];
        if (gitConf.branch.from) args.push(gitConf.branch.from);
        await execGit(args, gitDir);
        ctx.state._gitBranch = branchName;
      } else if (gitConf.branch?.checkout) {
        await execGit(['checkout', gitConf.branch.checkout], gitDir);
        ctx.state._gitBranch = gitConf.branch.checkout;
      }
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

    // Combine tools — include git tools if git config present and not opted out
    const includeGit = gitConf && gitConf.includeGitTools !== false;
    const allTools = [
      ...(this.schema.tools ?? []),
      ...(includeGit ? builtinGitTools : []),
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
          // ─── Git lifecycle: commit/push on completion ───
          if (gitConf && gitConf.commit?.strategy !== 'never') {
            const commitMsg = expandTemplate(
              gitConf.commit?.messageTemplate ?? 'chore({name}): run {runId} — {status}',
              { runId, name: this.schema.name, status: 'completed' },
            );
            const stageAll = gitConf.commit?.stageAll !== false;
            if (stageAll) await execGit(['add', '-A'], gitDir);
            // Only commit if there are changes
            const { ok: hasChanges } = await execGit(['diff', '--cached', '--quiet'], gitDir);
            if (!hasChanges) {
              await execGit(['commit', '-m', commitMsg], gitDir);
              if (gitConf.push?.enabled) {
                const remote = gitConf.push.remote ?? 'origin';
                const pushArgs = ['push'];
                if (gitConf.push.setUpstream !== false && ctx.state._gitBranch) {
                  pushArgs.push('-u', remote, ctx.state._gitBranch as string);
                } else {
                  pushArgs.push(remote);
                }
                await execGit(pushArgs, gitDir);
              }
            }
          }

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
      // Restore stash on error
      if (gitStashed) {
        await execGit(['stash', 'pop'], gitDir);
      }
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

    if (this.schema.git) {
      const g = this.schema.git;
      const gitParts = [`You are working in a git repository at: ${resolveGitDir(this.schema)}.`];
      gitParts.push(`Git tools (git_status, git_diff, git_log, git_commit, git_branch, git_push, git_stash) are available.`);
      if (g.branch?.create) gitParts.push(`A feature branch will be created automatically for this run.`);
      if (g.commit?.strategy === 'on-complete') gitParts.push(`Changes will be auto-committed on completion.`);
      if (g.commit?.strategy === 'per-iteration') gitParts.push(`Commit your work incrementally as you make progress.`);
      if (g.push?.enabled) gitParts.push(`Commits will be auto-pushed to remote.`);
      parts.push(gitParts.join(' '));
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
