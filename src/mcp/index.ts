import { spawn, type ChildProcess } from 'node:child_process';
import { nanoid } from 'nanoid';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class MCP {
  private process: ChildProcess;
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private buffer = '';
  private tools: Tool[] = [];

  private constructor(proc: ChildProcess) {
    this.process = proc;

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      // Log MCP server errors to stderr
      process.stderr.write(`[mcp] ${chunk.toString()}`);
    });

    proc.on('exit', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('MCP server exited'));
      }
      this.pending.clear();
    });
  }

  static async connect(
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
  ): Promise<Tool[]> {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : undefined,
    });

    const client = new MCP(proc);

    // Initialize
    await client.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'openagent', version: '0.1.0' },
    });

    // Notify initialized
    client.notify('notifications/initialized', {});

    // List tools
    const response = (await client.call('tools/list', {})) as { tools: MCPToolDef[] };
    const tools: Tool[] = (response.tools ?? []).map((t) => client.wrapTool(t));
    client.tools = tools;

    // Attach disconnect to returned tools for cleanup
    (tools as unknown as { _mcp: MCP })._mcp = client;

    return tools;
  }

  private wrapTool(def: MCPToolDef): Tool {
    const client = this;
    return {
      name: def.name,
      description: def.description ?? '',
      parameters: (def.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      async execute(input: string, _context: ToolContext): Promise<ToolResult> {
        try {
          const parsed = JSON.parse(input);
          const result = (await client.call('tools/call', {
            name: def.name,
            arguments: parsed,
          })) as { content: Array<{ type: string; text?: string }> };

          const text = (result.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n');

          return { callId: '', content: text };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { callId: '', content: message, isError: true };
        }
      },
    };
  }

  private async call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const data = JSON.stringify(request) + '\n';
      this.process.stdin!.write(data, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    const request = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    this.process.stdin!.write(JSON.stringify(request) + '\n');
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id != null) {
          const handler = this.pending.get(msg.id);
          if (handler) {
            this.pending.delete(msg.id);
            if (msg.error) {
              handler.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              handler.resolve(msg.result);
            }
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  }

  disconnect(): void {
    this.process.kill();
    for (const { reject } of this.pending.values()) {
      reject(new Error('MCP disconnected'));
    }
    this.pending.clear();
  }
}
