#!/usr/bin/env node
/**
 * Standalone server entry point.
 * Usage: npx tsx src/serve.ts [--port 7777]
 */
import { serve } from '@hono/node-server';
import { AgentManager } from './manager.js';
import { createServer } from './server.js';

const port = Number(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? 7777);
const manager = new AgentManager();
const app = createServer(manager);

// Export manager so external code can register agents
(globalThis as any).__agentManager = manager;

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`openagent server listening on http://localhost:${port}`);
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /agents');
  console.log('  GET  /agents/:id');
  console.log('  DEL  /agents/:id');
  console.log('  POST /agents/:id/run    { prompt }');
  console.log('  POST /agents/:id/cancel');
  console.log('  GET  /agents/:id/session');
  console.log('  GET  /agents/:id/events  (SSE)');
  console.log('  GET  /runs');
  console.log('  GET  /runs/:id');
  console.log('  GET  /events             (SSE)');
});
