import { resolve, relative, normalize } from 'node:path';

// ─── Types ───

export interface SandboxConfig {
  /** Root directory the agent can access. All file ops are confined here. */
  rootDir: string;

  /** Allowed shell commands (prefix match). Empty = all blocked. '*' = all allowed. */
  allowedCommands?: string[];

  /** Banned shell commands (checked before allowed). */
  bannedCommands?: string[];

  /** Read-only commands that skip permission checks. */
  safeReadOnlyCommands?: string[];

  /** Allowed file extensions for write. undefined = all allowed. */
  allowedWriteExtensions?: string[];

  /** Max output length for command results (bytes). */
  maxOutputLength?: number;

  /** Command timeout (ms). */
  commandTimeoutMs?: number;

  /** Whether to auto-approve all operations (YOLO mode). */
  autoApprove?: boolean;

  /** Network access policy. */
  network?: 'blocked' | 'allowed' | 'restricted';

  /** Allowed network hosts (only when network='restricted'). */
  allowedHosts?: string[];
}

export interface PermissionRequest {
  id: string;
  tool: string;
  action: string;
  description: string;
  path?: string;
  command?: string;
  timestamp: number;
}

export type PermissionDecision = 'granted' | 'denied' | 'pending';

export interface PermissionRecord extends PermissionRequest {
  decision: PermissionDecision;
  decidedAt?: number;
  persistent?: boolean;
}

export interface SandboxStatus {
  rootDir: string;
  allowedCommands: string[];
  bannedCommands: string[];
  safeReadOnlyCommands: string[];
  allowedWriteExtensions: string[] | null;
  network: string;
  allowedHosts: string[];
  autoApprove: boolean;
  maxOutputLength: number;
  commandTimeoutMs: number;
  pendingPermissions: PermissionRequest[];
  recentDecisions: PermissionRecord[];
  stats: {
    totalRequests: number;
    granted: number;
    denied: number;
    pathViolations: number;
    commandViolations: number;
  };
}

// ─── Defaults ───

const DEFAULT_BANNED_COMMANDS = [
  'rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork',
  'curl', 'wget', 'nc', 'telnet',
  'alias', 'chrome', 'firefox', 'safari', 'open',
  'shutdown', 'reboot', 'halt', 'poweroff',
  'passwd', 'chown', 'chmod 777',
  'sudo', 'su ',
];

const DEFAULT_SAFE_READONLY = [
  'ls', 'echo', 'pwd', 'date', 'cal', 'whoami', 'which', 'type',
  'uname', 'hostname', 'df', 'du', 'free', 'ps', 'uptime',
  'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff',
  'find', 'grep', 'rg', 'fd', 'ag',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  'git tag', 'git remote', 'git ls-files', 'git blame', 'git grep',
  'node --version', 'npm --version', 'pnpm --version', 'npx --version',
  'tsc --version', 'python --version', 'go version', 'rustc --version',
];

// ─── Sandbox ───

let idCounter = 0;

export class Sandbox {
  private config: Required<SandboxConfig>;
  private pendingPermissions = new Map<string, {
    request: PermissionRequest;
    resolve: (granted: boolean) => void;
  }>();
  private decisions: PermissionRecord[] = [];
  private persistentGrants: Array<{ tool: string; action: string; path?: string }> = [];
  private stats = { totalRequests: 0, granted: 0, denied: 0, pathViolations: 0, commandViolations: 0 };

  /** External handler for permission requests. If not set, non-autoApprove requests are denied. */
  onPermissionRequest?: (req: PermissionRequest) => void;

  constructor(config: SandboxConfig) {
    this.config = {
      rootDir: resolve(config.rootDir),
      allowedCommands: config.allowedCommands ?? ['*'],
      bannedCommands: config.bannedCommands ?? DEFAULT_BANNED_COMMANDS,
      safeReadOnlyCommands: config.safeReadOnlyCommands ?? DEFAULT_SAFE_READONLY,
      allowedWriteExtensions: config.allowedWriteExtensions ?? (undefined as any),
      maxOutputLength: config.maxOutputLength ?? 30_000,
      commandTimeoutMs: config.commandTimeoutMs ?? 120_000,
      autoApprove: config.autoApprove ?? false,
      network: config.network ?? 'blocked',
      allowedHosts: config.allowedHosts ?? [],
    };
  }

  // ─── Path validation ───

  /** Resolve path and check it's within rootDir. Returns absolute path or throws. */
  resolvePath(inputPath: string): string {
    const abs = resolve(this.config.rootDir, inputPath);
    const rel = relative(this.config.rootDir, abs);
    if (rel.startsWith('..') || resolve(abs) !== abs && rel.startsWith('..')) {
      this.stats.pathViolations++;
      throw new SandboxError('path_violation', `Path escapes sandbox: ${inputPath} → ${abs}`);
    }
    return abs;
  }

  /** Check if a path is within the sandbox. */
  isPathAllowed(inputPath: string): boolean {
    try {
      this.resolvePath(inputPath);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Command validation ───

  /** Check if a command is banned. */
  isCommandBanned(command: string): string | null {
    const cmd = command.trim().toLowerCase();
    for (const banned of this.config.bannedCommands) {
      if (cmd.startsWith(banned.toLowerCase())) {
        return banned;
      }
    }
    return null;
  }

  /** Check if a command is safe read-only (skips permission check). */
  isCommandSafeReadOnly(command: string): boolean {
    const cmd = command.trim().toLowerCase();
    for (const safe of this.config.safeReadOnlyCommands) {
      const safeLower = safe.toLowerCase();
      if (cmd === safeLower || cmd.startsWith(safeLower + ' ') || cmd.startsWith(safeLower + '-')) {
        return true;
      }
    }
    return false;
  }

  /** Check if a command is in the allowed list. */
  isCommandAllowed(command: string): boolean {
    if (this.config.allowedCommands.includes('*')) return true;
    const baseCmd = command.trim().split(/\s+/)[0].toLowerCase();
    return this.config.allowedCommands.some(
      (a) => baseCmd === a.toLowerCase() || command.trim().toLowerCase().startsWith(a.toLowerCase()),
    );
  }

  /** Full command check: banned → safe readonly → allowed. Returns reason or null. */
  validateCommand(command: string): { allowed: boolean; reason: string; needsPermission: boolean } {
    const banned = this.isCommandBanned(command);
    if (banned) {
      this.stats.commandViolations++;
      return { allowed: false, reason: `Banned command: ${banned}`, needsPermission: false };
    }

    if (!this.isCommandAllowed(command)) {
      this.stats.commandViolations++;
      return { allowed: false, reason: `Command not in allowlist`, needsPermission: false };
    }

    if (this.isCommandSafeReadOnly(command)) {
      return { allowed: true, reason: 'safe read-only', needsPermission: false };
    }

    return { allowed: true, reason: 'needs approval', needsPermission: !this.config.autoApprove };
  }

  // ─── File write validation ───

  validateWrite(filePath: string): { allowed: boolean; reason: string } {
    const abs = this.resolvePath(filePath); // throws if outside sandbox
    if (this.config.allowedWriteExtensions) {
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      if (!this.config.allowedWriteExtensions.includes(ext) && !this.config.allowedWriteExtensions.includes('.' + ext)) {
        return { allowed: false, reason: `Extension .${ext} not in allowlist` };
      }
    }
    return { allowed: true, reason: 'ok' };
  }

  // ─── Network validation ───

  validateNetwork(url: string): { allowed: boolean; reason: string } {
    if (this.config.network === 'allowed') return { allowed: true, reason: 'all network allowed' };
    if (this.config.network === 'blocked') return { allowed: false, reason: 'network access blocked' };
    try {
      const host = new URL(url).hostname;
      if (this.config.allowedHosts.some((h) => host === h || host.endsWith('.' + h))) {
        return { allowed: true, reason: `host ${host} in allowlist` };
      }
      return { allowed: false, reason: `host ${host} not in allowlist` };
    } catch {
      return { allowed: false, reason: 'invalid URL' };
    }
  }

  // ─── Permission system ───

  async requestPermission(tool: string, action: string, description: string, extra?: { path?: string; command?: string }): Promise<boolean> {
    this.stats.totalRequests++;

    if (this.config.autoApprove) {
      this.stats.granted++;
      return true;
    }

    // Check persistent grants
    for (const grant of this.persistentGrants) {
      if (grant.tool === tool && grant.action === action && (!grant.path || grant.path === extra?.path)) {
        this.stats.granted++;
        return true;
      }
    }

    const id = `perm_${++idCounter}`;
    const request: PermissionRequest = {
      id,
      tool,
      action,
      description,
      path: extra?.path,
      command: extra?.command,
      timestamp: Date.now(),
    };

    return new Promise<boolean>((resolvePromise) => {
      this.pendingPermissions.set(id, { request, resolve: resolvePromise });
      this.onPermissionRequest?.(request);

      // Auto-deny after 5 minutes if no response
      setTimeout(() => {
        if (this.pendingPermissions.has(id)) {
          this.denyPermission(id);
        }
      }, 5 * 60 * 1000);
    });
  }

  grantPermission(id: string, persistent = false): void {
    const entry = this.pendingPermissions.get(id);
    if (!entry) return;
    this.pendingPermissions.delete(id);
    this.stats.granted++;
    const record: PermissionRecord = { ...entry.request, decision: 'granted', decidedAt: Date.now(), persistent };
    this.decisions.push(record);
    if (persistent) {
      this.persistentGrants.push({ tool: entry.request.tool, action: entry.request.action, path: entry.request.path });
    }
    entry.resolve(true);
  }

  denyPermission(id: string): void {
    const entry = this.pendingPermissions.get(id);
    if (!entry) return;
    this.pendingPermissions.delete(id);
    this.stats.denied++;
    const record: PermissionRecord = { ...entry.request, decision: 'denied', decidedAt: Date.now() };
    this.decisions.push(record);
    entry.resolve(false);
  }

  // ─── Status ───

  getStatus(): SandboxStatus {
    return {
      rootDir: this.config.rootDir,
      allowedCommands: this.config.allowedCommands,
      bannedCommands: this.config.bannedCommands,
      safeReadOnlyCommands: this.config.safeReadOnlyCommands,
      allowedWriteExtensions: this.config.allowedWriteExtensions ?? null,
      network: this.config.network,
      allowedHosts: this.config.allowedHosts,
      autoApprove: this.config.autoApprove,
      maxOutputLength: this.config.maxOutputLength,
      commandTimeoutMs: this.config.commandTimeoutMs,
      pendingPermissions: [...this.pendingPermissions.values()].map((e) => e.request),
      recentDecisions: this.decisions.slice(-50),
      stats: { ...this.stats },
    };
  }

  getConfig(): Required<SandboxConfig> {
    return { ...this.config };
  }

  /** Update config at runtime. */
  updateConfig(patch: Partial<SandboxConfig>): void {
    if (patch.rootDir) this.config.rootDir = resolve(patch.rootDir);
    if (patch.allowedCommands) this.config.allowedCommands = patch.allowedCommands;
    if (patch.bannedCommands) this.config.bannedCommands = patch.bannedCommands;
    if (patch.safeReadOnlyCommands) this.config.safeReadOnlyCommands = patch.safeReadOnlyCommands;
    if (patch.allowedWriteExtensions !== undefined) this.config.allowedWriteExtensions = patch.allowedWriteExtensions as any;
    if (patch.maxOutputLength) this.config.maxOutputLength = patch.maxOutputLength;
    if (patch.commandTimeoutMs) this.config.commandTimeoutMs = patch.commandTimeoutMs;
    if (patch.autoApprove !== undefined) this.config.autoApprove = patch.autoApprove;
    if (patch.network) this.config.network = patch.network;
    if (patch.allowedHosts) this.config.allowedHosts = patch.allowedHosts;
  }
}

export class SandboxError extends Error {
  constructor(
    public code: 'path_violation' | 'command_banned' | 'command_not_allowed' | 'permission_denied' | 'network_blocked',
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}
