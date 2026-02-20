/**
 * Smoke test: Agent + AnthropicProvider + bash tool
 * Run: npx tsx test/smoke.ts
 */
import { Agent } from '../src/core/agent.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { bashTool } from '../src/tools/bash.js';

const provider = new AnthropicProvider();

const agent = new Agent({
  name: 'test-agent',
  provider,
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You are a helpful assistant. Be concise.',
  tools: [bashTool],
});

async function main() {
  console.log('--- openagent smoke test ---\n');

  // Test 1: Simple text response
  console.log('[Test 1] Simple question...');
  for await (const event of agent.run('What is 2 + 2? Answer in one word.')) {
    if (event.type === 'content') process.stdout.write(event.content ?? '');
    if (event.type === 'done') console.log(`\n✓ Done (${event.finishReason})\n`);
  }

  // Test 2: Tool use
  console.log('[Test 2] Tool use (bash)...');
  for await (const event of agent.run('Run `echo hello-openagent` and tell me what it printed.')) {
    if (event.type === 'content') process.stdout.write(event.content ?? '');
    if (event.type === 'toolCall') console.log(`\n🔧 Tool: ${event.toolCall?.name}(${event.toolCall?.input})`);
    if (event.type === 'toolResult') console.log(`📋 Result: ${event.toolResult?.content?.slice(0, 100)}`);
    if (event.type === 'done') console.log(`\n✓ Done (${event.finishReason})\n`);
  }

  console.log('--- all tests passed ---');
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
