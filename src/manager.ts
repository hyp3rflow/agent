import { nanoid } from 'nanoid';
import { Agent } from './agent.js';
import { EventBus } from './events.js';
import { InMemorySession } from './session.js';
import { Sandbox } from './sandbox.js';
import type { SandboxConfig } from './sandbox.js';
import type {
  AgentConfig, AgentEvent, RunOptions, Session, TokenUsage,
} from './types.js';

export interface AgentInfo {
  id: string;
  name: string;
  model: string;
  status: 'idle' | 'running' | 'error';
  createdAt: number;
  lastActiveAt: number;
  totalRuns: number;
  totalTokens: TokenUsage;
  currentRunId?: string;
}

export interface RunInfo {
  id: string;
  agentId: string;
  status: 'running' | 'completed' | 'error' | 'canceled';
  prompt: string;
  startedAt: number;
  finishedAt?: number;
  events: AgentEvent[];
  usage?: TokenUsage;
}

export interface ManagerEvent {
  type: 'agent:registered' | 'agent:removed' | 'agent:status'
    | 'run:started' | 'run:event' | 'run:completed';
  agentId: string;
  runId?: string;
  data?: unknown;
}

export interface RegisterOptions {
  sandbox?: SandboxConfig;
}

export class AgentManager {
  private agents = new Map<string, { agent: Agent; config: AgentConfig; info: AgentInfo; sandbox?: Sandbox }>();
  private runs = new Map<string, RunInfo>();
  private sessions = new Map<string, Session>();
  readonly bus = new EventBus<ManagerEvent>();

  register(config: AgentConfig, options?: RegisterOptions): string {
    const id = nanoid(12);
    const agent = new Agent(config);
    const info: AgentInfo = {
      id,
      name: config.name,
      model: config.model,
      status: 'idle',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      totalRuns: 0,
      totalTokens: { inputTokens: 0, outputTokens: 0 },
    };
    const sandbox = options?.sandbox ? new Sandbox(options.sandbox) : undefined;
    this.agents.set(id, { agent, config, info, sandbox });
    this.bus.emit('agent:registered', { type: 'agent:registered', agentId: id });
    return id;
  }

  remove(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    this.agents.delete(agentId);
    this.bus.emit('agent:removed', { type: 'agent:removed', agentId });
    return true;
  }

  getAgent(agentId: string) {
    return this.agents.get(agentId);
  }

  listAgents(): AgentInfo[] {
    return [...this.agents.values()].map(e => ({ ...e.info }));
  }

  getRun(runId: string): RunInfo | undefined {
    return this.runs.get(runId);
  }

  listRuns(agentId?: string): RunInfo[] {
    const all = [...this.runs.values()];
    if (agentId) return all.filter(r => r.agentId === agentId);
    return all;
  }

  getSession(agentId: string): Session | undefined {
    return this.sessions.get(agentId);
  }

  getSandbox(agentId: string): Sandbox | undefined {
    return this.agents.get(agentId)?.sandbox;
  }

  async startRun(agentId: string, prompt: string, options?: Partial<RunOptions>): Promise<string> {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent not found: ${agentId}`);

    const runId = nanoid(12);
    const session = this.sessions.get(agentId) ?? new InMemorySession();
    this.sessions.set(agentId, session);

    const run: RunInfo = {
      id: runId,
      agentId,
      status: 'running',
      prompt,
      startedAt: Date.now(),
      events: [],
    };
    this.runs.set(runId, run);

    entry.info.status = 'running';
    entry.info.currentRunId = runId;
    entry.info.lastActiveAt = Date.now();
    entry.info.totalRuns++;

    this.bus.emit('run:started', { type: 'run:started', agentId, runId });
    this.bus.emit('agent:status', { type: 'agent:status', agentId, data: { status: 'running' } });

    // Run in background
    (async () => {
      try {
        for await (const event of entry.agent.run(prompt, { session, ...options })) {
          run.events.push(event);
          this.bus.emit('run:event', { type: 'run:event', agentId, runId, data: event });

          if (event.type === 'done') {
            run.status = event.finishReason === 'canceled' ? 'canceled' : 'completed';
            run.finishedAt = Date.now();
            if (event.usage) {
              run.usage = event.usage;
              entry.info.totalTokens.inputTokens += event.usage.inputTokens;
              entry.info.totalTokens.outputTokens += event.usage.outputTokens;
            }
          }
        }
      } catch (err) {
        run.status = 'error';
        run.finishedAt = Date.now();
        run.events.push({
          type: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      } finally {
        entry.info.status = 'idle';
        entry.info.currentRunId = undefined;
        entry.info.lastActiveAt = Date.now();
        this.bus.emit('run:completed', { type: 'run:completed', agentId, runId, data: { status: run.status } });
        this.bus.emit('agent:status', { type: 'agent:status', agentId, data: { status: 'idle' } });
      }
    })();

    return runId;
  }

  cancelRun(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry?.info.currentRunId) return;
    const session = this.sessions.get(agentId);
    if (session) entry.agent.cancel(session.id);
  }
}
