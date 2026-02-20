/**
 * WorkflowManager — tracks workflow runs and their internal state.
 * Provides queryable snapshots of running/completed workflows.
 */

import { EventBus } from './events.js';
import { Workflow, type WorkflowSchema, type WorkflowEvent, type WorkflowResult } from './workflow.js';
import type { AgentEvent, TokenUsage } from './types.js';

export interface WorkflowRunInfo {
  id: string;
  name: string;
  description?: string;
  status: 'running' | 'completed' | 'error' | 'canceled';
  prompt: string;
  startedAt: number;
  finishedAt?: number;
  duration?: number;

  /** Main agent config snapshot. */
  main: {
    model: string;
    systemPrompt?: string;
    maxTurns?: number;
  };

  /** Available provider names. */
  providers: string[];
  defaultProvider: string;

  /** Tool names in the harness. */
  tools: string[];

  /** Delegation policy. */
  delegation: {
    enabled: boolean;
    maxConcurrent: number;
    allowedModels?: string[];
    maxTurnsPerAgent: number;
    inheritTools: boolean;
  };

  /** Sandbox config (if any). */
  sandbox?: {
    rootDir: string;
    network: string;
    autoApprove: boolean;
  };

  /** Agents spawned during this run. */
  agents: SubAgentInfo[];

  /** Aggregated token usage. */
  usage: TokenUsage;

  /** Final output (populated on completion). */
  output?: string;

  /** Recent events (ring buffer, last N). */
  recentEvents: WorkflowEvent[];

  /** Result (populated on completion). */
  result?: WorkflowResult;
}

export interface SubAgentInfo {
  name: string;
  model?: string;
  status: 'running' | 'completed' | 'error';
  spawnedAt: number;
  completedAt?: number;
  prompt?: string;
  output?: string;
  /** Event count from this sub-agent. */
  eventCount: number;
}

const MAX_RECENT_EVENTS = 200;

export class WorkflowManager {
  private runs = new Map<string, {
    info: WorkflowRunInfo;
    workflow: Workflow;
    schema: WorkflowSchema;
  }>();

  readonly bus = new EventBus<WorkflowEvent>();

  /** Register a workflow and start a run. Returns the run ID. */
  async startRun(schema: WorkflowSchema, prompt: string, options?: {
    signal?: AbortSignal;
  }): Promise<string> {
    const workflow = new Workflow(schema);
    // We need to intercept the run to capture the runId and track state.
    // Start the run and process events in background.
    const runPromise = this._executeRun(workflow, schema, prompt, options?.signal);

    // The runId is generated inside workflow.run(), so we get it from the first event.
    // We use a slightly different approach: pre-generate and patch.
    // Actually, let's just run and capture.
    return runPromise;
  }

  private async _executeRun(
    workflow: Workflow,
    schema: WorkflowSchema,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let runId = '';

    // We'll capture the first event to get the runId, then register the run.
    const gen = workflow.run(prompt, { signal });

    for await (const event of gen) {
      if (!runId && event.runId) {
        runId = event.runId;

        // Register the run
        const info: WorkflowRunInfo = {
          id: runId,
          name: schema.name,
          description: schema.description,
          status: 'running',
          prompt,
          startedAt: Date.now(),
          main: {
            model: schema.main.model,
            systemPrompt: schema.main.systemPrompt,
            maxTurns: schema.main.maxTurns,
          },
          providers: Object.keys(schema.providers),
          defaultProvider: schema.defaultProvider,
          tools: (schema.tools ?? []).map(t => t.name),
          delegation: {
            enabled: schema.delegation?.enabled !== false,
            maxConcurrent: schema.delegation?.maxConcurrent ?? 4,
            allowedModels: schema.delegation?.allowedModels,
            maxTurnsPerAgent: schema.delegation?.maxTurnsPerAgent ?? 20,
            inheritTools: schema.delegation?.inheritTools !== false,
          },
          sandbox: schema.sandbox ? {
            rootDir: schema.sandbox.rootDir,
            network: schema.sandbox.network ?? 'blocked',
            autoApprove: schema.sandbox.autoApprove ?? false,
          } : undefined,
          agents: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          recentEvents: [],
        };

        this.runs.set(runId, { info, workflow, schema });
      }

      const entry = this.runs.get(runId);
      if (!entry) continue;
      const info = entry.info;

      // Track events
      info.recentEvents.push(event);
      if (info.recentEvents.length > MAX_RECENT_EVENTS) {
        info.recentEvents.shift();
      }

      // Forward to bus
      this.bus.emit(event.type, event);

      // Track sub-agents
      if (event.type === 'agent:spawned' && event.agentName) {
        const data = event.data as { model?: string; task?: string } | undefined;
        info.agents.push({
          name: event.agentName,
          model: data?.model,
          status: 'running',
          spawnedAt: event.timestamp,
          prompt: data?.task,
          eventCount: 0,
        });
      }

      if (event.type === 'agent:completed' && event.agentName) {
        const agent = info.agents.find(a => a.name === event.agentName && a.status === 'running');
        if (agent) {
          agent.status = 'completed';
          agent.completedAt = event.timestamp;
          agent.output = (event.data as any)?.output;
        }
      }

      if (event.type === 'agent:event' && event.agentName) {
        const agent = info.agents.find(a => a.name === event.agentName);
        if (agent) agent.eventCount++;

        // Track usage from agent events
        const ae = event.data as AgentEvent | undefined;
        if (ae?.usage) {
          info.usage.inputTokens += ae.usage.inputTokens;
          info.usage.outputTokens += ae.usage.outputTokens;
        }
      }

      // Track completion
      if (event.result) {
        info.status = event.result.status;
        info.finishedAt = Date.now();
        info.duration = info.finishedAt - info.startedAt;
        info.output = event.result.output;
        info.usage = event.result.usage;
        info.result = event.result;
      }
    }

    return runId;
  }

  /** Get a workflow run's full state. */
  getRun(runId: string): WorkflowRunInfo | undefined {
    return this.runs.get(runId)?.info;
  }

  /** List all runs (optionally filter by status). */
  listRuns(status?: WorkflowRunInfo['status']): WorkflowRunInfo[] {
    const all = [...this.runs.values()].map(e => e.info);
    if (status) return all.filter(r => r.status === status);
    return all;
  }

  /** Get sub-agent details for a run. */
  getAgents(runId: string): SubAgentInfo[] {
    return this.runs.get(runId)?.info.agents ?? [];
  }

  /** Get recent events for a run. */
  getEvents(runId: string, limit?: number): WorkflowEvent[] {
    const events = this.runs.get(runId)?.info.recentEvents ?? [];
    if (limit) return events.slice(-limit);
    return events;
  }
}
