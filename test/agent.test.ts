import { describe, it, expect } from 'vitest';
import { Agent } from '../src/agent.js';
import { InMemorySession } from '../src/session.js';
import type {
  Provider, ProviderOptions, ProviderEvent, Message,
  Tool, ToolContext, ToolResult, AgentEvent,
} from '../src/types.js';

// --- Mock Provider ---
function mockProvider(responses: Array<{
  content?: string;
  toolCalls?: Array<{ id: string; name: string; input: string }>;
}>): Provider {
  let callIdx = 0;
  return {
    name: 'mock',
    async *stream(messages: Message[], options: ProviderOptions): AsyncIterable<ProviderEvent> {
      const resp = responses[callIdx++] ?? { content: '' };
      if (resp.content) {
        yield { type: 'content_delta', content: resp.content };
      }
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
    async complete() {
      throw new Error('not implemented');
    },
  };
}

// --- Mock Tool ---
function mockTool(name: string, fn: (input: string) => string): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
    async execute(input: string, _ctx: ToolContext): Promise<ToolResult> {
      return { callId: '', content: fn(input) };
    },
  };
}

// --- Helpers ---
async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// --- Tests ---
describe('Agent', () => {
  it('simple text response', async () => {
    const agent = new Agent({
      name: 'test',
      provider: mockProvider([{ content: 'Hello!' }]),
      model: 'mock-model',
    });

    const events = await collectEvents(agent.run('Hi'));
    const content = events.filter(e => e.type === 'content').map(e => e.content).join('');
    expect(content).toBe('Hello!');
    expect(events.at(-1)?.type).toBe('done');
    expect(events.at(-1)?.finishReason).toBe('end_turn');
  });

  it('tool call and response', async () => {
    const provider = mockProvider([
      { toolCalls: [{ id: 'tc1', name: 'echo', input: '{"text":"hi"}' }] },
      { content: 'Tool said: hi' },
    ]);

    const agent = new Agent({
      name: 'test',
      provider,
      model: 'mock-model',
      tools: [mockTool('echo', (input) => {
        const parsed = JSON.parse(input);
        return parsed.text;
      })],
    });

    const events = await collectEvents(agent.run('echo hi'));

    const toolCalls = events.filter(e => e.type === 'toolCall');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolCall?.name).toBe('echo');

    const toolResults = events.filter(e => e.type === 'toolResult');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].toolResult?.content).toBe('hi');

    const content = events.filter(e => e.type === 'content').map(e => e.content).join('');
    expect(content).toBe('Tool said: hi');
  });

  it('unknown tool returns error result', async () => {
    const provider = mockProvider([
      { toolCalls: [{ id: 'tc1', name: 'nonexistent', input: '{}' }] },
      { content: 'ok' },
    ]);

    const agent = new Agent({ name: 'test', provider, model: 'mock' });
    const events = await collectEvents(agent.run('do something'));

    const results = events.filter(e => e.type === 'toolResult');
    expect(results).toHaveLength(1);
    expect(results[0].toolResult?.isError).toBe(true);
    expect(results[0].toolResult?.content).toContain('Unknown tool');
  });

  it('session persists messages', async () => {
    const session = new InMemorySession();
    const agent = new Agent({
      name: 'test',
      provider: mockProvider([{ content: 'response1' }]),
      model: 'mock',
    });

    await collectEvents(agent.run('hello', { session }));
    const msgs = session.getMessages();
    expect(msgs).toHaveLength(2); // user + assistant
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('hello');
    expect(msgs[1].role).toBe('assistant');
  });

  it('cancellation via abort signal', async () => {
    const ac = new AbortController();
    // Provider that hangs forever until aborted
    const hangProvider: Provider = {
      name: 'hang',
      async *stream(_msgs: Message[], opts: ProviderOptions) {
        yield { type: 'content_delta' as const, content: 'start...' };
        // Wait until aborted
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve();
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        // After abort, throw like a real provider would
        throw new Error('aborted');
      },
      async complete() { throw new Error('not implemented'); },
    };

    const agent = new Agent({ name: 'test', provider: hangProvider, model: 'mock' });

    // Abort after 20ms
    setTimeout(() => ac.abort(), 20);

    const events = await collectEvents(agent.run('hi', { signal: ac.signal }));
    const done = events.find(e => e.type === 'done');
    expect(done?.finishReason).toBe('canceled');
  });

  it('onEvent callback fires', async () => {
    const received: AgentEvent[] = [];
    const agent = new Agent({
      name: 'test',
      provider: mockProvider([{ content: 'yo' }]),
      model: 'mock',
      onEvent: (e) => received.push(e),
    });

    await collectEvents(agent.run('hi'));
    expect(received.length).toBeGreaterThan(0);
    expect(received.some(e => e.type === 'content')).toBe(true);
  });

  it('asTool wraps agent as sub-agent tool', async () => {
    const sub = new Agent({
      name: 'sub',
      provider: mockProvider([{ content: 'sub-response' }]),
      model: 'mock',
    });

    const tool = sub.asTool({ name: 'ask_sub', description: 'Ask sub-agent' });
    expect(tool.name).toBe('ask_sub');

    const result = await tool.execute(
      JSON.stringify({ prompt: 'hello sub' }),
      { sessionId: 'test', agentName: 'parent', signal: new AbortController().signal },
    );
    expect(result.content).toBe('sub-response');
  });

  it('use() adds tools dynamically', async () => {
    const agent = new Agent({
      name: 'test',
      provider: mockProvider([
        { toolCalls: [{ id: 'tc1', name: 'added', input: '{}' }] },
        { content: 'done' },
      ]),
      model: 'mock',
    });

    agent.use(mockTool('added', () => 'dynamic!'));

    const events = await collectEvents(agent.run('use tool'));
    const results = events.filter(e => e.type === 'toolResult');
    expect(results[0].toolResult?.content).toBe('dynamic!');
  });

  it('multiple tool calls in one turn', async () => {
    const provider = mockProvider([
      {
        toolCalls: [
          { id: 'tc1', name: 'greet', input: '{"name":"A"}' },
          { id: 'tc2', name: 'greet', input: '{"name":"B"}' },
        ],
      },
      { content: 'Greeted both' },
    ]);

    const agent = new Agent({
      name: 'test',
      provider,
      model: 'mock',
      tools: [mockTool('greet', (input) => `Hello ${JSON.parse(input).name}`)],
    });

    const events = await collectEvents(agent.run('greet A and B'));
    const results = events.filter(e => e.type === 'toolResult');
    expect(results).toHaveLength(2);
    expect(results[0].toolResult?.content).toBe('Hello A');
    expect(results[1].toolResult?.content).toBe('Hello B');
  });
});
