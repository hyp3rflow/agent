import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { AgentManager, ManagerEvent } from '../manager/manager.js';
import type { WorkflowManager } from '../workflow/workflow-manager.js';
import type { WorkflowEvent } from '../workflow/workflow.js';

export interface ServerOptions {
  manager?: AgentManager;
  workflows?: WorkflowManager;
}

export function createServer(opts: AgentManager | ServerOptions) {
  const manager = 'listAgents' in opts ? opts : opts.manager;
  const workflows = 'listAgents' in opts ? undefined : opts.workflows;

  const app = new Hono();
  app.use('*', cors());

  // --- Health ---
  app.get('/health', (c) => c.json({
    ok: true,
    uptime: process.uptime(),
    agents: manager?.listAgents().length ?? 0,
    workflowRuns: workflows?.listRuns().length ?? 0,
  }));

  // ═══════════════════════════════════════
  // Agent Manager routes (if provided)
  // ═══════════════════════════════════════

  if (manager) {
    app.get('/agents', (c) => c.json(manager.listAgents()));

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

    app.get('/runs', (c) => {
      const agentId = c.req.query('agentId');
      return c.json(manager.listRuns(agentId));
    });

    app.get('/runs/:id', (c) => {
      const run = manager.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      return c.json({ ...run, events: run.events.map(sanitizeEvent) });
    });

    app.post('/agents/:id/run', async (c) => {
      const body = await c.req.json<{ prompt: string }>();
      if (!body.prompt) return c.json({ error: 'prompt required' }, 400);
      try {
        const runId = await manager.startRun(c.req.param('id'), body.prompt);
        return c.json({ runId }, 201);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    });

    app.post('/agents/:id/cancel', (c) => {
      manager.cancelRun(c.req.param('id'));
      return c.json({ ok: true });
    });

    app.get('/agents/:id/session', (c) => {
      const session = manager.getSession(c.req.param('id'));
      if (!session) return c.json({ messages: [] });
      return c.json({ id: session.id, messages: session.getMessages() });
    });

    // Sandbox
    app.get('/agents/:id/sandbox', (c) => {
      const sandbox = manager.getSandbox(c.req.param('id'));
      if (!sandbox) return c.json({ error: 'no sandbox' }, 404);
      return c.json(sandbox.getStatus());
    });

    app.patch('/agents/:id/sandbox', async (c) => {
      const sandbox = manager.getSandbox(c.req.param('id'));
      if (!sandbox) return c.json({ error: 'no sandbox' }, 404);
      sandbox.updateConfig(await c.req.json());
      return c.json(sandbox.getStatus());
    });

    app.post('/agents/:id/sandbox/permissions/:permId/grant', (c) => {
      const sandbox = manager.getSandbox(c.req.param('id'));
      if (!sandbox) return c.json({ error: 'no sandbox' }, 404);
      sandbox.grantPermission(c.req.param('permId'));
      return c.json({ ok: true });
    });

    app.post('/agents/:id/sandbox/permissions/:permId/deny', (c) => {
      const sandbox = manager.getSandbox(c.req.param('id'));
      if (!sandbox) return c.json({ error: 'no sandbox' }, 404);
      sandbox.denyPermission(c.req.param('permId'));
      return c.json({ ok: true });
    });

    // Agent SSE
    app.get('/agents/:id/events', (c) => {
      const agentId = c.req.param('id');
      return streamSSE(c, async (stream) => {
        const unsub = manager.bus.on('*', (event: ManagerEvent) => {
          if (event.agentId === agentId) {
            stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          }
        });
        const ka = setInterval(() => stream.writeSSE({ event: 'ping', data: '' }), 15_000);
        try {
          await new Promise<void>((r) => stream.onAbort(() => r()));
        } finally { unsub(); clearInterval(ka); }
      });
    });

    // Global SSE
    app.get('/events', (c) => {
      return streamSSE(c, async (stream) => {
        const unsub = manager.bus.on('*', (event: ManagerEvent) => {
          stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        });
        const ka = setInterval(() => stream.writeSSE({ event: 'ping', data: '' }), 15_000);
        try {
          await new Promise<void>((r) => stream.onAbort(() => r()));
        } finally { unsub(); clearInterval(ka); }
      });
    });
  }

  // ═══════════════════════════════════════
  // Workflow routes (if provided)
  // ═══════════════════════════════════════

  if (workflows) {
    // List all workflow runs
    app.get('/workflows', (c) => {
      const status = c.req.query('status') as any;
      const runs = workflows.listRuns(status);
      // Return summary (without recentEvents for list view)
      return c.json(runs.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        status: r.status,
        prompt: r.prompt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        duration: r.duration,
        agents: r.agents.length,
        usage: r.usage,
      })));
    });

    // Get full workflow run state
    app.get('/workflows/:id', (c) => {
      const run = workflows.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      // Return everything except recentEvents (use /events endpoint for that)
      const { recentEvents, ...rest } = run;
      return c.json(rest);
    });

    // Get agents in a workflow run
    app.get('/workflows/:id/agents', (c) => {
      const run = workflows.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      return c.json(run.agents);
    });

    // Get events for a workflow run
    app.get('/workflows/:id/events', (c) => {
      const limit = parseInt(c.req.query('limit') ?? '100', 10);
      const events = workflows.getEvents(c.req.param('id'), limit);
      if (!events.length && !workflows.getRun(c.req.param('id'))) {
        return c.json({ error: 'not found' }, 404);
      }
      return c.json(events);
    });

    // Get workflow config/schema snapshot
    app.get('/workflows/:id/config', (c) => {
      const run = workflows.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      return c.json({
        main: run.main,
        providers: run.providers,
        defaultProvider: run.defaultProvider,
        tools: run.tools,
        delegation: run.delegation,
        sandbox: run.sandbox,
      });
    });

    // SSE for workflow events
    app.get('/workflows/:id/stream', (c) => {
      const runId = c.req.param('id');
      return streamSSE(c, async (stream) => {
        const unsub = workflows.bus.on('*', (event: WorkflowEvent) => {
          if (event.runId === runId) {
            stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          }
        });
        const ka = setInterval(() => stream.writeSSE({ event: 'ping', data: '' }), 15_000);
        try {
          await new Promise<void>((r) => stream.onAbort(() => r()));
        } finally { unsub(); clearInterval(ka); }
      });
    });

    // Global workflow SSE
    app.get('/workflows/stream', (c) => {
      return streamSSE(c, async (stream) => {
        const unsub = workflows.bus.on('*', (event: WorkflowEvent) => {
          stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        });
        const ka = setInterval(() => stream.writeSSE({ event: 'ping', data: '' }), 15_000);
        try {
          await new Promise<void>((r) => stream.onAbort(() => r()));
        } finally { unsub(); clearInterval(ka); }
      });
    });
  }

  return app;
}

function sanitizeEvent(event: { type: string; error?: Error }) {
  if (event.error instanceof Error) {
    return { ...event, error: { message: event.error.message, name: event.error.name } };
  }
  return event;
}
