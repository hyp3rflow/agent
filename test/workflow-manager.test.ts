import { describe, it, expect } from 'vitest';
import { WorkflowManager } from '../src/workflow-manager.js';
import { createServer } from '../src/server.js';
import type { Provider, ProviderEvent } from '../src/types.js';
import type { WorkflowSchema } from '../src/workflow.js';

function mockProvider(responses: Array<{
  content?: string;
  toolCalls?: Array<{ id: string; name: string; input: string }>;
}>): Provider {
  let idx = 0;
  return {
    name: 'mock',
    async *stream(): AsyncIterable<ProviderEvent> {
      const r = responses[idx++] ?? { content: '' };
      if (r.content) yield { type: 'content_delta', content: r.content };
      if (r.toolCalls?.length) {
        for (const tc of r.toolCalls) {
          yield { type: 'tool_use_start', toolCall: { id: tc.id, name: tc.name, input: '' } };
          yield { type: 'tool_use_delta', content: tc.input };
          yield { type: 'tool_use_stop', toolCall: tc };
        }
      }
      yield {
        type: 'complete',
        response: {
          finishReason: r.toolCalls?.length ? 'tool_use' : 'end_turn',
          toolCalls: r.toolCalls ?? [],
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      };
    },
    async complete() { throw new Error('not implemented'); },
  };
}

function makeSchema(overrides?: Partial<WorkflowSchema>): WorkflowSchema {
  return {
    name: 'test-workflow',
    description: 'A test workflow',
    providers: { mock: mockProvider([{ content: 'Hello!' }]) },
    defaultProvider: 'mock',
    main: { model: 'mock-model', systemPrompt: 'You are helpful.' },
    ...overrides,
  };
}

describe('WorkflowManager', () => {
  it('startRun tracks workflow state', async () => {
    const wm = new WorkflowManager();
    const runId = await wm.startRun(makeSchema(), 'Say hello');

    expect(typeof runId).toBe('string');
    const run = wm.getRun(runId);
    expect(run).toBeDefined();
    expect(run!.name).toBe('test-workflow');
    expect(run!.status).toBe('completed');
    expect(run!.prompt).toBe('Say hello');
    expect(run!.output).toBe('Hello!');
    expect(run!.main.model).toBe('mock-model');
    expect(run!.providers).toContain('mock');
    expect(run!.usage.inputTokens).toBeGreaterThan(0);
  });

  it('listRuns returns all runs', async () => {
    const wm = new WorkflowManager();
    await wm.startRun(makeSchema(), 'Run 1');
    await wm.startRun(makeSchema(), 'Run 2');

    const runs = wm.listRuns();
    expect(runs).toHaveLength(2);
  });

  it('listRuns filters by status', async () => {
    const wm = new WorkflowManager();
    await wm.startRun(makeSchema(), 'OK run');
    await wm.startRun(makeSchema({
      providers: {},
      defaultProvider: 'missing',
    }), 'Error run');

    const completed = wm.listRuns('completed');
    expect(completed).toHaveLength(1);
    const errors = wm.listRuns('error');
    expect(errors).toHaveLength(1);
  });

  it('tracks sub-agents from delegation', async () => {
    let callCount = 0;
    const provider: Provider = {
      name: 'mock',
      async *stream(): AsyncIterable<ProviderEvent> {
        callCount++;
        if (callCount === 1) {
          const tc = { id: 'tc1', name: 'delegate', input: JSON.stringify({ name: 'coder', task: 'Write code' }) };
          yield { type: 'tool_use_start', toolCall: { id: tc.id, name: tc.name, input: '' } };
          yield { type: 'tool_use_delta', content: tc.input };
          yield { type: 'tool_use_stop', toolCall: tc };
          yield { type: 'complete', response: { finishReason: 'tool_use', toolCalls: [tc], usage: { inputTokens: 5, outputTokens: 5 } } };
        } else if (callCount === 2) {
          yield { type: 'content_delta', content: 'Code written' };
          yield { type: 'complete', response: { finishReason: 'end_turn', toolCalls: [], usage: { inputTokens: 5, outputTokens: 10 } } };
        } else {
          yield { type: 'content_delta', content: 'All done' };
          yield { type: 'complete', response: { finishReason: 'end_turn', toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 } } };
        }
      },
      async complete() { throw new Error('not implemented'); },
    };

    const wm = new WorkflowManager();
    const runId = await wm.startRun(
      makeSchema({ providers: { mock: provider }, delegation: { enabled: true } }),
      'Build feature',
    );

    const agents = wm.getAgents(runId);
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents[0].name).toBe('coder');
  });

  it('getEvents returns recent events', async () => {
    const wm = new WorkflowManager();
    const runId = await wm.startRun(makeSchema(), 'Test');

    const events = wm.getEvents(runId);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].runId).toBe(runId);

    const limited = wm.getEvents(runId, 2);
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('bus emits workflow events', async () => {
    const wm = new WorkflowManager();
    const received: string[] = [];
    wm.bus.on('*', (event) => received.push(event.type));

    await wm.startRun(makeSchema(), 'Test');
    expect(received).toContain('workflow:started');
    expect(received).toContain('workflow:completed');
  });
});

describe('Server — workflow endpoints', () => {
  async function setup() {
    const wm = new WorkflowManager();
    const runId = await wm.startRun(makeSchema(), 'Hello workflow');
    const app = createServer({ workflows: wm });
    return { wm, runId, app };
  }

  it('GET /workflows', async () => {
    const { app } = await setup();
    const res = await app.request('/workflows');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('test-workflow');
    expect(body[0].status).toBe('completed');
    // Summary should not include recentEvents
    expect(body[0].recentEvents).toBeUndefined();
  });

  it('GET /workflows/:id', async () => {
    const { app, runId } = await setup();
    const res = await app.request(`/workflows/${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(runId);
    expect(body.name).toBe('test-workflow');
    expect(body.prompt).toBe('Hello workflow');
    expect(body.main.model).toBe('mock-model');
    expect(body.providers).toContain('mock');
    expect(body.tools).toEqual([]);
    expect(body.delegation.enabled).toBe(true);
    expect(body.usage).toBeDefined();
  });

  it('GET /workflows/:id — 404', async () => {
    const { app } = await setup();
    const res = await app.request('/workflows/nonexistent');
    expect(res.status).toBe(404);
  });

  it('GET /workflows/:id/agents', async () => {
    const { app, runId } = await setup();
    const res = await app.request(`/workflows/${runId}/agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /workflows/:id/events', async () => {
    const { app, runId } = await setup();
    const res = await app.request(`/workflows/${runId}/events?limit=50`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].runId).toBe(runId);
  });

  it('GET /workflows/:id/config', async () => {
    const { app, runId } = await setup();
    const res = await app.request(`/workflows/${runId}/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.main.model).toBe('mock-model');
    expect(body.main.systemPrompt).toBe('You are helpful.');
    expect(body.defaultProvider).toBe('mock');
    expect(body.delegation.enabled).toBe(true);
  });

  it('GET /health includes workflow count', async () => {
    const { app } = await setup();
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.workflowRuns).toBe(1);
  });
});
