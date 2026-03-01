/**
 * LSP Manager — manages multiple LSP clients, auto-detects by file type.
 */
import { LspClient, uriToPath, type LspClientConfig, type LspDiagnostic } from './client.js';
import { resolve as resolvePath, extname } from 'node:path';
import { existsSync } from 'node:fs';

// ─── Default LSP Configs ───

const DEFAULT_CONFIGS: LspClientConfig[] = [
  {
    name: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    fileTypes: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    rootMarkers: ['tsconfig.json', 'package.json'],
  },
  {
    name: 'pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    fileTypes: ['.py', '.pyi'],
    rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt'],
  },
  {
    name: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    fileTypes: ['.rs'],
    rootMarkers: ['Cargo.toml'],
  },
  {
    name: 'gopls',
    command: 'gopls',
    args: ['serve'],
    fileTypes: ['.go'],
    rootMarkers: ['go.mod'],
  },
];

export interface LspManagerOptions {
  cwd?: string;
  configs?: LspClientConfig[];
  /** Whether to use default configs for common LSPs. Default true. */
  useDefaults?: boolean;
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  private cwd: string;
  private configs: LspClientConfig[];

  constructor(options: LspManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    const defaults = options.useDefaults !== false ? DEFAULT_CONFIGS : [];
    this.configs = [...defaults, ...(options.configs ?? [])];
  }

  /** Start the LSP that handles this file type (lazy — starts on first use). */
  async start(filePath: string): Promise<LspClient | null> {
    const ext = extname(filePath);
    if (!ext) return null;

    // Already running?
    for (const client of this.clients.values()) {
      if (client.handlesFile(filePath) && client.isRunning) {
        return client;
      }
    }

    // Find matching config
    const config = this.configs.find(c => c.fileTypes.includes(ext));
    if (!config) return null;

    // Check if the command exists
    if (!commandExists(config.command)) return null;

    // Check if already created but not running
    const existing = this.clients.get(config.name);
    if (existing) {
      await existing.start();
      return existing;
    }

    // Create and start
    const client = new LspClient(config, this.cwd);
    this.clients.set(config.name, client);

    try {
      await client.start();
      return client;
    } catch {
      this.clients.delete(config.name);
      return null;
    }
  }

  /** Get a client that handles a file path. */
  getClient(filePath: string): LspClient | null {
    for (const client of this.clients.values()) {
      if (client.handlesFile(filePath) && client.isRunning) {
        return client;
      }
    }
    return null;
  }

  /** Get all running clients. */
  getClients(): LspClient[] {
    return [...this.clients.values()].filter(c => c.isRunning);
  }

  /** Open a file in the appropriate LSP. */
  async openFile(filePath: string): Promise<void> {
    const client = await this.start(filePath);
    if (client) {
      await client.openFile(filePath);
    }
  }

  /** Notify LSP of file change and wait for fresh diagnostics. */
  async notifyChange(filePath: string): Promise<void> {
    const client = this.getClient(filePath);
    if (!client) return;

    await client.openFile(filePath);
    await client.notifyChange(filePath);
    await client.waitForDiagnostics(5000);
  }

  /** Get diagnostics — for a specific file or project-wide. */
  getDiagnostics(filePath?: string): Array<{ path: string; diagnostics: LspDiagnostic[] }> {
    const result: Array<{ path: string; diagnostics: LspDiagnostic[] }> = [];

    for (const client of this.clients.values()) {
      if (!client.isRunning) continue;
      const diags = client.getDiagnostics(filePath);
      for (const [uri, d] of diags) {
        if (d.length > 0) {
          result.push({ path: uriToPath(uri), diagnostics: d });
        }
      }
    }

    return result;
  }

  /** Find references for a symbol at a given position. */
  async findReferences(filePath: string, line: number, character: number): Promise<Array<{ path: string; line: number; character: number }>> {
    const client = this.getClient(filePath) ?? await this.start(filePath);
    if (!client) return [];

    const locations = await client.findReferences(filePath, line, character);
    return locations.map(loc => ({
      path: uriToPath(loc.uri),
      line: loc.range.start.line + 1,
      character: loc.range.start.character + 1,
    }));
  }

  /** Restart all LSP servers. */
  async restartAll(): Promise<string[]> {
    const restarted: string[] = [];
    for (const [name, client] of this.clients) {
      try {
        await client.restart();
        restarted.push(name);
      } catch {
        this.clients.delete(name);
      }
    }
    return restarted;
  }

  /** Stop all LSP servers. */
  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
  }

  /** Get status of all clients. */
  getStatus(): Array<{ name: string; running: boolean; fileTypes: string[] }> {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      running: client.isRunning,
      fileTypes: client.fileTypes,
    }));
  }
}

function commandExists(cmd: string): boolean {
  try {
    const { execSync } = require('node:child_process');
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
