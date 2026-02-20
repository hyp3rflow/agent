import { describe, it, expect } from 'vitest';
import { Sandbox, SandboxError } from '../src/sandbox.js';

describe('Sandbox', () => {
  const makeSandbox = (overrides?: Record<string, any>) =>
    new Sandbox({ rootDir: '/home/agent/workspace', ...overrides });

  // ─── Path validation ───

  describe('path validation', () => {
    it('allows paths within rootDir', () => {
      const sb = makeSandbox();
      expect(sb.resolvePath('src/index.ts')).toBe('/home/agent/workspace/src/index.ts');
      expect(sb.isPathAllowed('src/foo.ts')).toBe(true);
    });

    it('blocks path traversal', () => {
      const sb = makeSandbox();
      expect(() => sb.resolvePath('../../etc/passwd')).toThrow(SandboxError);
      expect(sb.isPathAllowed('../../etc/passwd')).toBe(false);
    });

    it('blocks absolute paths outside rootDir', () => {
      const sb = makeSandbox();
      expect(() => sb.resolvePath('/etc/passwd')).toThrow(SandboxError);
    });

    it('allows absolute paths inside rootDir', () => {
      const sb = makeSandbox();
      expect(sb.resolvePath('/home/agent/workspace/src/foo.ts')).toBe('/home/agent/workspace/src/foo.ts');
    });
  });

  // ─── Command validation ───

  describe('command validation', () => {
    it('detects banned commands', () => {
      const sb = makeSandbox();
      expect(sb.isCommandBanned('curl http://evil.com')).toBe('curl');
      expect(sb.isCommandBanned('wget file')).toBe('wget');
      expect(sb.isCommandBanned('sudo apt install')).toBe('sudo');
    });

    it('allows safe read-only commands without permission', () => {
      const sb = makeSandbox();
      const r = sb.validateCommand('ls -la');
      expect(r.allowed).toBe(true);
      expect(r.needsPermission).toBe(false);

      const r2 = sb.validateCommand('git status');
      expect(r2.allowed).toBe(true);
      expect(r2.needsPermission).toBe(false);
    });

    it('non-readonly commands need permission', () => {
      const sb = makeSandbox();
      const r = sb.validateCommand('npm install express');
      expect(r.allowed).toBe(true);
      expect(r.needsPermission).toBe(true);
    });

    it('autoApprove skips permission', () => {
      const sb = makeSandbox({ autoApprove: true });
      const r = sb.validateCommand('npm install express');
      expect(r.allowed).toBe(true);
      expect(r.needsPermission).toBe(false);
    });

    it('banned commands always blocked even with autoApprove', () => {
      const sb = makeSandbox({ autoApprove: true });
      const r = sb.validateCommand('sudo rm -rf /');
      expect(r.allowed).toBe(false);
    });

    it('allowlist restricts commands', () => {
      const sb = makeSandbox({ allowedCommands: ['npm', 'node', 'git'] });
      expect(sb.validateCommand('npm test').allowed).toBe(true);
      expect(sb.validateCommand('python script.py').allowed).toBe(false);
    });
  });

  // ─── File write validation ───

  describe('write validation', () => {
    it('allows writes when no extension filter', () => {
      const sb = makeSandbox();
      expect(sb.validateWrite('src/foo.py').allowed).toBe(true);
    });

    it('filters by extension', () => {
      const sb = makeSandbox({ allowedWriteExtensions: ['ts', 'js', 'json'] });
      expect(sb.validateWrite('src/foo.ts').allowed).toBe(true);
      expect(sb.validateWrite('src/foo.py').allowed).toBe(false);
    });

    it('blocks writes outside sandbox', () => {
      const sb = makeSandbox({ allowedWriteExtensions: ['ts'] });
      expect(() => sb.validateWrite('/etc/crontab')).toThrow(SandboxError);
    });
  });

  // ─── Network validation ───

  describe('network validation', () => {
    it('blocks all by default', () => {
      const sb = makeSandbox();
      expect(sb.validateNetwork('https://evil.com').allowed).toBe(false);
    });

    it('allows all when network=allowed', () => {
      const sb = makeSandbox({ network: 'allowed' });
      expect(sb.validateNetwork('https://anything.com').allowed).toBe(true);
    });

    it('restricted mode checks host allowlist', () => {
      const sb = makeSandbox({ network: 'restricted', allowedHosts: ['api.github.com', 'npmjs.org'] });
      expect(sb.validateNetwork('https://api.github.com/repos').allowed).toBe(true);
      expect(sb.validateNetwork('https://evil.com').allowed).toBe(false);
    });
  });

  // ─── Permission system ───

  describe('permissions', () => {
    it('autoApprove grants immediately', async () => {
      const sb = makeSandbox({ autoApprove: true });
      const granted = await sb.requestPermission('bash', 'execute', 'run npm test');
      expect(granted).toBe(true);
    });

    it('grant/deny via API', async () => {
      const sb = makeSandbox();
      let capturedId = '';
      sb.onPermissionRequest = (req) => { capturedId = req.id; };

      const p = sb.requestPermission('bash', 'execute', 'npm install');
      // Grant it
      setTimeout(() => sb.grantPermission(capturedId), 10);
      expect(await p).toBe(true);
    });

    it('deny returns false', async () => {
      const sb = makeSandbox();
      let capturedId = '';
      sb.onPermissionRequest = (req) => { capturedId = req.id; };

      const p = sb.requestPermission('bash', 'execute', 'dangerous cmd');
      setTimeout(() => sb.denyPermission(capturedId), 10);
      expect(await p).toBe(false);
    });

    it('persistent grant auto-approves subsequent requests', async () => {
      const sb = makeSandbox();
      let capturedId = '';
      sb.onPermissionRequest = (req) => { capturedId = req.id; };

      const p1 = sb.requestPermission('bash', 'execute', 'npm test');
      setTimeout(() => sb.grantPermission(capturedId, true), 10);
      expect(await p1).toBe(true);

      // Second request should auto-approve
      const p2 = await sb.requestPermission('bash', 'execute', 'npm test again');
      expect(p2).toBe(true);
    });
  });

  // ─── Status ───

  describe('status', () => {
    it('returns full sandbox status', () => {
      const sb = makeSandbox({ network: 'restricted', allowedHosts: ['github.com'] });
      const status = sb.getStatus();
      expect(status.rootDir).toBe('/home/agent/workspace');
      expect(status.network).toBe('restricted');
      expect(status.allowedHosts).toContain('github.com');
      expect(status.stats.totalRequests).toBe(0);
    });

    it('tracks stats', async () => {
      const sb = makeSandbox({ autoApprove: true });
      await sb.requestPermission('bash', 'execute', 'test');
      await sb.requestPermission('bash', 'execute', 'test2');
      const status = sb.getStatus();
      expect(status.stats.totalRequests).toBe(2);
      expect(status.stats.granted).toBe(2);
    });
  });

  // ─── Config update ───

  describe('updateConfig', () => {
    it('updates config at runtime', () => {
      const sb = makeSandbox();
      sb.updateConfig({ autoApprove: true, network: 'allowed' });
      const cfg = sb.getConfig();
      expect(cfg.autoApprove).toBe(true);
      expect(cfg.network).toBe('allowed');
    });
  });
});
