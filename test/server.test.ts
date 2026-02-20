import { describe, it, expect, beforeEach } from 'vitest';
import { AgentManager } from '../src/manager/manager.js';
import { createServer } from '../src/server/server.js';
import type { Provider, ProviderEvent, Message, ProviderOptions } from '../src/core/types.js';

function mockProvider(content: string): Provider {
  return {
    name: 'mock',
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: 'content_delta', content };
      yield {
        type: 'complete',
        response: {
          finishReason: 'end_turn',
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 10 },
        },
      };
    },
    async complete() { throw new Error('not implemented'); },
  };
}

describe('Server API', () => {
  let manager: AgentManager;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    manager = new AgentManager();
    app = createServer(manager);
  });

  const req = (path: string, init?: RequestInit) =>
    app.request(path, init);

  it('GET /health', async () => {
    const res = await req('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
  });

  it('GET /agents — empty', async () => {
    const res = await req('/agents');
    expect(await res.json()).toEqual([]);
  });

  it('register + list agents', async () => {
    const id = manager.register({
      name: 'test-agent',
      provider: mockProvider('hi'),
      model: 'mock-model',
    });

    const res = await req('/agents');
    const agents = await res.json();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(id);
    expect(agents[0].name).toBe('test-agent');
    expect(agents[0].status).toBe('idle');
  });

  it('GET /agents/:id', async () => {
    const id = manager.register({
      name: 'a1',
      provider: mockProvider('hi'),
      model: 'mock',
    });

    const res = await req(`/agents/${id}`);
    expect(res.status).toBe(200);
    const agent = await res.json();
    expect(agent.name).toBe('a1');
  });

  it('GET /agents/:id — 404', async () => {
    const res = await req('/agents/nonexistent');
    expect(res.status).toBe(404);
  });

  it('DELETE /agents/:id', async () => {
    const id = manager.register({
      name: 'rm-me',
      provider: mockProvider(''),
      model: 'mock',
    });

    const res = await req(`/agents/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const list = await (await req('/agents')).json();
    expect(list).toHaveLength(0);
  });

  it('POST /agents/:id/run + GET /runs', async () => {
    const id = manager.register({
      name: 'runner',
      provider: mockProvider('hello world'),
      model: 'mock',
    });

    const runRes = await req(`/agents/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'say hi' }),
    });
    expect(runRes.status).toBe(201);
    const { runId } = await runRes.json();
    expect(typeof runId).toBe('string');

    // Wait for run to complete
    await new Promise(r => setTimeout(r, 100));

    const runsRes = await req('/runs');
    const runs = await runsRes.json();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const run = runs.find((r: any) => r.id === runId);
    expect(run.status).toBe('completed');
  });

  it('GET /runs/:id', async () => {
    const id = manager.register({
      name: 'r2',
      provider: mockProvider('resp'),
      model: 'mock',
    });

    const { runId } = await (await req(`/agents/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test' }),
    })).json();

    await new Promise(r => setTimeout(r, 100));

    const res = await req(`/runs/${runId}`);
    expect(res.status).toBe(200);
    const run = await res.json();
    expect(run.events.length).toBeGreaterThan(0);
  });

  it('GET /agents/:id/session', async () => {
    const id = manager.register({
      name: 's1',
      provider: mockProvider('answer'),
      model: 'mock',
    });

    // No session yet
    const empty = await (await req(`/agents/${id}/session`)).json();
    expect(empty.messages).toEqual([]);

    // Run to create session
    await req(`/agents/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    await new Promise(r => setTimeout(r, 100));

    const session = await (await req(`/agents/${id}/session`)).json();
    expect(session.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].content).toBe('hello');
  });

  it('POST /agents/:id/run — missing prompt', async () => {
    const id = manager.register({
      name: 'np',
      provider: mockProvider(''),
      model: 'mock',
    });

    const res = await req(`/agents/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('GET /runs?agentId= filters', async () => {
    const id1 = manager.register({ name: 'a1', provider: mockProvider('1'), model: 'mock' });
    const id2 = manager.register({ name: 'a2', provider: mockProvider('2'), model: 'mock' });

    await req(`/agents/${id1}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p1' }),
    });
    await req(`/agents/${id2}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p2' }),
    });

    await new Promise(r => setTimeout(r, 100));

    const all = await (await req('/runs')).json();
    expect(all.length).toBe(2);

    const filtered = await (await req(`/runs?agentId=${id1}`)).json();
    expect(filtered.length).toBe(1);
    expect(filtered[0].agentId).toBe(id1);
  });
});
