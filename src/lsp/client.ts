/**
 * Minimal LSP client over JSON-RPC 2.0 stdio.
 * No external dependencies — implements just what we need.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

// ─── Types ───

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code?: string | number;
  source?: string;
  message: string;
  tags?: number[];
}

export interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface LspClientConfig {
  name: string;
  command: string;
  args: string[];
  fileTypes: string[];      // e.g. ['.ts', '.tsx', '.js']
  rootMarkers?: string[];   // e.g. ['tsconfig.json', 'package.json']
  initOptions?: Record<string, unknown>;
  env?: Record<string, string>;
}

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// ─── Client ───

export class LspClient extends EventEmitter {
  readonly name: string;
  readonly fileTypes: string[];

  private config: LspClientConfig;
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private contentLength = -1;
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private openFiles = new Map<string, number>(); // uri → version
  private initialized = false;
  private cwd: string;

  constructor(config: LspClientConfig, cwd: string) {
    super();
    this.name = config.name;
    this.fileTypes = config.fileTypes;
    this.config = config;
    this.cwd = cwd;
  }

  // ─── Lifecycle ───

  async start(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn(this.config.command, this.config.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      // LSP servers often log to stderr — just emit for debugging
      this.emit('log', chunk.toString());
    });
    this.proc.on('exit', (code) => {
      this.initialized = false;
      this.proc = null;
      this.emit('exit', code);
    });
    this.proc.on('error', (err) => {
      this.emit('error', err);
    });

    await this.initialize();
  }

  async stop(): Promise<void> {
    if (!this.proc) return;

    // Shutdown request
    try {
      await this.request('shutdown', null, 5000);
      this.notify('exit', null);
    } catch {
      this.proc?.kill('SIGTERM');
    }

    // Wait for exit
    await new Promise<void>((resolve) => {
      if (!this.proc) return resolve();
      const timer = setTimeout(() => {
        this.proc?.kill('SIGKILL');
        resolve();
      }, 3000);
      this.proc.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.proc = null;
    this.initialized = false;
    this.pending.clear();
    this.diagnostics.clear();
    this.openFiles.clear();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  get isRunning(): boolean {
    return this.proc !== null && this.initialized;
  }

  // ─── LSP Protocol ───

  private async initialize(): Promise<void> {
    const rootUri = `file://${this.cwd}`;
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri,
      rootPath: this.cwd,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
          synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
          completion: { completionItem: { snippetSupport: false } },
          references: {},
          definition: {},
        },
        workspace: {
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: false },
        },
      },
      workspaceFolders: [{ uri: rootUri, name: resolvePath(this.cwd).split('/').pop()! }],
      initializationOptions: this.config.initOptions ?? {},
    });

    this.notify('initialized', {});
    this.initialized = true;
    this.emit('initialized', result);
  }

  // ─── File Operations ───

  async openFile(filePath: string): Promise<void> {
    const uri = pathToUri(filePath);
    if (this.openFiles.has(uri)) return;

    const content = await readFile(filePath, 'utf-8');
    const languageId = this.detectLanguageId(filePath);
    this.openFiles.set(uri, 1);

    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text: content },
    });
  }

  async notifyChange(filePath: string): Promise<void> {
    const uri = pathToUri(filePath);
    const version = (this.openFiles.get(uri) ?? 0) + 1;
    this.openFiles.set(uri, version);

    const content = await readFile(filePath, 'utf-8');
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  closeFile(filePath: string): void {
    const uri = pathToUri(filePath);
    if (!this.openFiles.has(uri)) return;
    this.openFiles.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  // ─── Queries ───

  async findReferences(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    const uri = pathToUri(filePath);
    await this.openFile(filePath);

    const result = await this.request('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    }, 15000);

    return (result as LspLocation[] | null) ?? [];
  }

  getDiagnostics(filePath?: string): Map<string, LspDiagnostic[]> {
    if (!filePath) return new Map(this.diagnostics);
    const uri = pathToUri(filePath);
    const diags = this.diagnostics.get(uri);
    if (diags) return new Map([[uri, diags]]);
    return new Map();
  }

  /** Wait for fresh diagnostics after a change notification. */
  waitForDiagnostics(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const handler = () => {
        clearTimeout(timer);
        this.removeListener('diagnostics', handler);
        // Small delay to collect more diagnostics
        setTimeout(resolve, 200);
      };
      this.on('diagnostics', handler);
    });
  }

  handlesFile(filePath: string): boolean {
    return this.fileTypes.some(ext => filePath.endsWith(ext));
  }

  // ─── JSON-RPC Transport ───

  private request(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        return reject(new Error('LSP process not running'));
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: JsonRpcMessage): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    this.proc?.stdin?.write(header + body);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      if (Buffer.byteLength(this.buffer) < this.contentLength) break;

      const body = Buffer.from(this.buffer).slice(0, this.contentLength).toString();
      this.buffer = Buffer.from(this.buffer).slice(this.contentLength).toString();
      this.contentLength = -1;

      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        this.handleMessage(msg);
      } catch {
        // Invalid JSON — skip
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to a request
    if (msg.id !== undefined && this.pending.has(msg.id as number)) {
      const handler = this.pending.get(msg.id as number)!;
      this.pending.delete(msg.id as number);
      if (msg.error) {
        handler.reject(new Error(`LSP error: ${msg.error.message} (${msg.error.code})`));
      } else {
        handler.resolve(msg.result);
      }
      return;
    }

    // Notification from server
    if (msg.method === 'textDocument/publishDiagnostics') {
      const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
      this.diagnostics.set(params.uri, params.diagnostics);
      this.emit('diagnostics', params.uri, params.diagnostics);
      return;
    }

    // Window notifications — log them
    if (msg.method?.startsWith('window/')) {
      this.emit('log', `[${msg.method}] ${JSON.stringify(msg.params)}`);
      // Auto-respond to window/workDoneProgress/create
      if (msg.method === 'window/workDoneProgress/create' && msg.id !== undefined) {
        this.send({ jsonrpc: '2.0', id: msg.id as number, result: null } as any);
      }
      return;
    }

    // Client/registerCapability — acknowledge
    if (msg.method === 'client/registerCapability' && msg.id !== undefined) {
      this.send({ jsonrpc: '2.0', id: msg.id as number, result: null } as any);
    }
  }

  private detectLanguageId(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescriptreact',
      js: 'javascript', jsx: 'javascriptreact',
      py: 'python', rs: 'rust', go: 'go',
      c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
      java: 'java', rb: 'ruby', php: 'php',
      css: 'css', html: 'html', json: 'json',
      md: 'markdown', yaml: 'yaml', yml: 'yaml',
      sh: 'shellscript', bash: 'shellscript',
      sql: 'sql', lua: 'lua', zig: 'zig',
      swift: 'swift', kt: 'kotlin',
    };
    return map[ext] ?? ext;
  }
}

// ─── Utils ───

function pathToUri(filePath: string): string {
  const abs = resolvePath(filePath);
  return `file://${abs}`;
}

export function uriToPath(uri: string): string {
  return uri.replace('file://', '');
}
