import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { AgentManager, ManagerEvent } from './manager.js';

export function createServer(manager: AgentManager) {
  const app = new Hono();

  app.use('*', cors());

  // --- Health ---
  app.get('/health', (c) => c.json({ ok: true, uptime: process.uptime() }));

  // --- Agents ---
  app.get('/agents', (c) => {
    return c.json(manager.listAgents());
  });

  app.get('/agents/:id', (c) => {
    const entry = manager.getAgent(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry.info);
  });

  app.delete('/agents/:id', (c) => {
    const ok = manager.remove(c.req.param('id'));
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // --- Runs ---
  app.get('/runs', (c) => {
    const agentId = c.req.query('agentId');
    return c.json(manager.listRuns(agentId));
  });

  app.get('/runs/:id', (c) => {
    const run = manager.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    return c.json({
      ...run,
      events: run.events.map((e) => sanitizeEvent(e)),
    });
  });

  app.post('/agents/:id/run', async (c) => {
    const agentId = c.req.param('id');
    const body = await c.req.json<{ prompt: string }>();
    if (!body.prompt) return c.json({ error: 'prompt required' }, 400);
    try {
      const runId = await manager.startRun(agentId, body.prompt);
      return c.json({ runId }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/agents/:id/cancel', (c) => {
    manager.cancelRun(c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- Sessions ---
  app.get('/agents/:id/session', (c) => {
    const session = manager.getSession(c.req.param('id'));
    if (!session) return c.json({ messages: [] });
    return c.json({
      id: session.id,
      messages: session.getMessages(),
    });
  });

  // --- Sandbox ---
  app.get('/agents/:id/sandbox', (c) => {
    const sandbox = manager.getSandbox(c.req.param('id'));
    if (!sandbox) return c.json({ error: 'no sandbox configured' }, 404);
    return c.json(sandbox.getStatus());
  });

  app.patch('/agents/:id/sandbox', async (c) => {
    const sandbox = manager.getSandbox(c.req.param('id'));
    if (!sandbox) return c.json({ error: 'no sandbox configured' }, 404);
    const patch = await c.req.json();
    sandbox.updateConfig(patch);
    return c.json(sandbox.getStatus());
  });

  app.post('/agents/:id/sandbox/permissions/:permId/grant', (c) => {
    const sandbox = manager.getSandbox(c.req.param('id'));
    if (!sandbox) return c.json({ error: 'no sandbox configured' }, 404);
    sandbox.grantPermission(c.req.param('permId'));
    return c.json({ ok: true });
  });

  app.post('/agents/:id/sandbox/permissions/:permId/deny', (c) => {
    const sandbox = manager.getSandbox(c.req.param('id'));
    if (!sandbox) return c.json({ error: 'no sandbox configured' }, 404);
    sandbox.denyPermission(c.req.param('permId'));
    return c.json({ ok: true });
  });

  app.post('/agents/:id/sandbox/validate-command', async (c) => {
    const sandbox = manager.getSandbox(c.req.param('id'));
    if (!sandbox) return c.json({ error: 'no sandbox configured' }, 404);
    const { command } = await c.req.json<{ command: string }>();
    return c.json(sandbox.validateCommand(command));
  });

  app.post('/agents/:id/sandbox/validate-path', async (c) => {
    const sandbox = manager.getSandbox(c.req.param('id'));
    if (!sandbox) return c.json({ error: 'no sandbox configured' }, 404);
    const { path } = await c.req.json<{ path: string }>();
    try {
      const resolved = sandbox.resolvePath(path);
      return c.json({ allowed: true, resolved });
    } catch (err) {
      return c.json({ allowed: false, error: (err as Error).message });
    }
  });

  // --- SSE (real-time events) ---
  app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const handler = (event: ManagerEvent) => {
        stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      };

      const unsub = manager.bus.on('*', handler);

      // Keep alive
      const keepAlive = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' });
      }, 15_000);

      // Wait for disconnect
      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        unsub();
        clearInterval(keepAlive);
      }
    });
  });

  // Filtered SSE for a specific agent
  app.get('/agents/:id/events', (c) => {
    const agentId = c.req.param('id');
    return streamSSE(c, async (stream) => {
      const handler = (event: ManagerEvent) => {
        if (event.agentId === agentId) {
          stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      };

      const unsub = manager.bus.on('*', handler);
      const keepAlive = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' });
      }, 15_000);

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        unsub();
        clearInterval(keepAlive);
      }
    });
  });

  return app;
}

/** Strip Error objects (not JSON-serializable) */
function sanitizeEvent(event: { type: string; error?: Error }) {
  if (event.error instanceof Error) {
    return { ...event, error: { message: event.error.message, name: event.error.name } };
  }
  return event;
}
