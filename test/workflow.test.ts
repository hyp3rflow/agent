import { describe, it, expect } from 'vitest';
import { Workflow, defineWorkflow } from '../src/workflow/workflow.js';
import type { WorkflowSchema, WorkflowEvent, WorkflowResult } from '../src/workflow/workflow.js';
import type { Provider, ProviderEvent, Message, ProviderOptions, Tool, ToolContext, ToolResult } from '../src/core/types.js';

// ─── Mock Provider ───

function mockProvider(responses: Array<{
  content?: string;
  toolCalls?: Array<{ id: string; name: string; input: string }>;
}>): Provider {
  let callIdx = 0;
  return {
    name: 'mock',
    async *stream(): AsyncIterable<ProviderEvent> {
      const resp = responses[callIdx++] ?? { content: '' };
      if (resp.content) yield { type: 'content_delta', content: resp.content };
      if (resp.toolCalls?.length) {
        for (const tc of resp.toolCalls) {
          yield { type: 'tool_use_start', toolCall: { id: tc.id, name: tc.name, input: '' } };
          yield { type: 'tool_use_delta', content: tc.input };
          yield { type: 'tool_use_stop', toolCall: tc };
        }
      }
      yield {
        type: 'complete',
        response: {
          finishReason: resp.toolCalls?.length ? 'tool_use' : 'end_turn',
          toolCalls: resp.toolCalls ?? [],
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      };
    },
    async complete() { throw new Error('not implemented'); },
  };
}

function mockTool(name: string, fn: (input: string) => string): Tool {
  return {
    name,
    description: `Mock: ${name}`,
    parameters: { type: 'object', properties: {} },
    async execute(input: string): Promise<ToolResult> {
      return { callId: '', content: fn(input) };
    },
  };
}

async function collectWorkflow(wf: Workflow, prompt: string) {
  const events: WorkflowEvent[] = [];
  let result: WorkflowResult | undefined;
  for await (const event of wf.run(prompt)) {
    events.push(event);
    if (event.result) result = event.result;
  }
  return { events, result };
}

// ─── Tests ───

describe('Workflow', () => {
  it('simple workflow — text response', async () => {
    const wf = defineWorkflow({
      name: 'simple',
      providers: { anthropic: mockProvider([{ content: 'Hello from workflow!' }]) },
      defaultProvider: 'anthropic',
      main: { model: 'mock-model' },
    });

    const { events, result } = await collectWorkflow(wf, 'Say hello');

    expect(events[0].type).toBe('workflow:started');
    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('Hello from workflow!');
    expect(result?.usage.inputTokens).toBeGreaterThan(0);
  });

  it('workflow with tools', async () => {
    const provider = mockProvider([
      { toolCalls: [{ id: 'tc1', name: 'greet', input: '{"name":"world"}' }] },
      { content: 'Done greeting' },
    ]);

    const wf = defineWorkflow({
      name: 'tooled',
      providers: { mock: provider },
      defaultProvider: 'mock',
      main: { model: 'mock' },
      tools: [mockTool('greet', (input) => `Hello ${JSON.parse(input).name}!`)],
    });

    const { result } = await collectWorkflow(wf, 'Greet the world');
    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('Done greeting');
  });

  it('workflow with delegation (sub-agent)', async () => {
    // Main agent delegates, then responds with result
    // Call 0 (main): delegates to sub-agent
    // Call 1 (sub-agent): responds with research result
    // Call 2 (main): final response incorporating sub-agent result
    let callCount = 0;
    const provider: Provider = {
      name: 'mock',
      async *stream(messages: Message[]): AsyncIterable<ProviderEvent> {
        callCount++;
        if (callCount === 1) {
          // Main agent delegates
          const tc = { id: 'tc1', name: 'delegate', input: JSON.stringify({ name: 'researcher', task: 'Find info about TypeScript' }) };
          yield { type: 'tool_use_start', toolCall: { id: tc.id, name: tc.name, input: '' } };
          yield { type: 'tool_use_delta', content: tc.input };
          yield { type: 'tool_use_stop', toolCall: tc };
          yield { type: 'complete', response: { finishReason: 'tool_use', toolCalls: [tc], usage: { inputTokens: 10, outputTokens: 5 } } };
        } else if (callCount === 2) {
          // Sub-agent responds
          yield { type: 'content_delta', content: 'TypeScript is a typed superset of JavaScript.' };
          yield { type: 'complete', response: { finishReason: 'end_turn', toolCalls: [], usage: { inputTokens: 5, outputTokens: 15 } } };
        } else {
          // Main agent final response
          yield { type: 'content_delta', content: 'Research complete: TypeScript info gathered.' };
          yield { type: 'complete', response: { finishReason: 'end_turn', toolCalls: [], usage: { inputTokens: 15, outputTokens: 10 } } };
        }
      },
      async complete() { throw new Error('not implemented'); },
    };

    const wf = defineWorkflow({
      name: 'delegated',
      providers: { mock: provider },
      defaultProvider: 'mock',
      main: { model: 'mock' },
      delegation: { enabled: true, maxConcurrent: 2 },
    });

    const { events, result } = await collectWorkflow(wf, 'Research TypeScript');

    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('Research complete: TypeScript info gathered.');
    // Should have spawned a sub-agent
    const spawnEvents = events.filter(e => e.type === 'agent:event' && (e.data as any)?.type === 'toolCall');
    expect(spawnEvents.length).toBeGreaterThan(0);
  });

  it('delegation disabled — no delegate tool', async () => {
    const wf = defineWorkflow({
      name: 'no-delegation',
      providers: { mock: mockProvider([{ content: 'Done alone' }]) },
      defaultProvider: 'mock',
      main: { model: 'mock' },
      delegation: { enabled: false },
    });

    const { result } = await collectWorkflow(wf, 'Do it yourself');
    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('Done alone');
  });

  it('multiple providers available', async () => {
    const wf = defineWorkflow({
      name: 'multi-provider',
      providers: {
        fast: mockProvider([{ content: 'Fast response' }]),
        smart: mockProvider([{ content: 'Smart response' }]),
      },
      defaultProvider: 'fast',
      main: { model: 'mock' },
    });

    const { result } = await collectWorkflow(wf, 'Quick task');
    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('Fast response');
  });

  it('invalid default provider returns error', async () => {
    const wf = defineWorkflow({
      name: 'bad-provider',
      providers: {},
      defaultProvider: 'nonexistent',
      main: { model: 'mock' },
    });

    const { result } = await collectWorkflow(wf, 'Hello');
    expect(result?.status).toBe('error');
    expect(result?.error?.message).toContain('not found');
  });

  it('beforeRun and afterRun hooks fire', async () => {
    const hookLog: string[] = [];

    const wf = defineWorkflow({
      name: 'hooked',
      providers: { mock: mockProvider([{ content: 'ok' }]) },
      defaultProvider: 'mock',
      main: { model: 'mock' },
      beforeRun: (ctx) => { hookLog.push(`before:${ctx.runId}`); },
      afterRun: (ctx, result) => { hookLog.push(`after:${result.status}`); },
    });

    await collectWorkflow(wf, 'test');
    expect(hookLog).toHaveLength(2);
    expect(hookLog[0]).toMatch(/^before:/);
    expect(hookLog[1]).toBe('after:completed');
  });

  it('onSpawn hook can block delegation', async () => {
    let callCount = 0;
    const provider: Provider = {
      name: 'mock',
      async *stream(): AsyncIterable<ProviderEvent> {
        callCount++;
        if (callCount === 1) {
          const tc = { id: 'tc1', name: 'delegate', input: JSON.stringify({ name: 'blocked-agent', task: 'do stuff' }) };
          yield { type: 'tool_use_start', toolCall: { id: tc.id, name: tc.name, input: '' } };
          yield { type: 'tool_use_delta', content: tc.input };
          yield { type: 'tool_use_stop', toolCall: tc };
          yield { type: 'complete', response: { finishReason: 'tool_use', toolCalls: [tc], usage: { inputTokens: 5, outputTokens: 5 } } };
        } else {
          yield { type: 'content_delta', content: 'Spawn was blocked' };
          yield { type: 'complete', response: { finishReason: 'end_turn', toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 } } };
        }
      },
      async complete() { throw new Error('not implemented'); },
    };

    const wf = defineWorkflow({
      name: 'spawn-blocked',
      providers: { mock: provider },
      defaultProvider: 'mock',
      main: { model: 'mock' },
      onSpawn: () => false, // Block all spawns
    });

    const { result } = await collectWorkflow(wf, 'Try delegating');
    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('Spawn was blocked');
  });

  it('shared state between hooks', async () => {
    const wf = defineWorkflow({
      name: 'stateful',
      providers: { mock: mockProvider([{ content: 'result' }]) },
      defaultProvider: 'mock',
      main: { model: 'mock' },
      beforeRun: (ctx) => { ctx.state.startedAt = Date.now(); },
      afterRun: (ctx) => {
        expect(ctx.state.startedAt).toBeDefined();
        expect(typeof ctx.state.startedAt).toBe('number');
      },
    });

    await collectWorkflow(wf, 'test');
  });

  it('defineWorkflow is a convenience helper', () => {
    const wf = defineWorkflow({
      name: 'test',
      providers: { mock: mockProvider([]) },
      defaultProvider: 'mock',
      main: { model: 'mock' },
    });
    expect(wf).toBeInstanceOf(Workflow);
  });
});
