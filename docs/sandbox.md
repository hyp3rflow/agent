# Sandbox

The `Sandbox` class enforces security boundaries for agent operations: path confinement, command validation, network restrictions, and a permission approval system.

## SandboxConfig

```typescript
import { Sandbox } from '@hrmm/agent';

const sandbox = new Sandbox({
  rootDir: '/home/user/project',
  allowedCommands: ['*'],
  bannedCommands: ['sudo', 'rm -rf /'],
  safeReadOnlyCommands: ['ls', 'cat', 'git status'],
  allowedWriteExtensions: ['ts', 'js', 'json', 'md'],
  maxOutputLength: 30_000,
  commandTimeoutMs: 120_000,
  autoApprove: false,
  network: 'restricted',
  allowedHosts: ['api.github.com'],
});
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rootDir` | `string` | required | Root directory; all paths confined here |
| `allowedCommands` | `string[]` | `['*']` | Allowed command prefixes. `'*'` = all |
| `bannedCommands` | `string[]` | [built-in list] | Always-blocked command prefixes |
| `safeReadOnlyCommands` | `string[]` | [built-in list] | Commands that skip permission checks |
| `allowedWriteExtensions` | `string[]?` | `undefined` (all) | Restrict writable file extensions |
| `maxOutputLength` | `number` | `30000` | Max command output bytes |
| `commandTimeoutMs` | `number` | `120000` | Command timeout |
| `autoApprove` | `boolean` | `false` | Auto-approve all permission requests |
| `network` | `'blocked' \| 'allowed' \| 'restricted'` | `'blocked'` | Network access policy |
| `allowedHosts` | `string[]` | `[]` | Hosts allowed when `network='restricted'` |

### Default Banned Commands

`rm -rf /`, `mkfs`, `dd if=`, `curl`, `wget`, `nc`, `sudo`, `su`, `shutdown`, `reboot`, `passwd`, `chmod 777`, `chrome`, `firefox`, `open`, etc.

### Default Safe Read-Only Commands

`ls`, `cat`, `head`, `tail`, `find`, `grep`, `rg`, `git status`, `git log`, `git diff`, `git show`, `pwd`, `wc`, `sort`, `uniq`, `diff`, `ps`, `uptime`, etc.

## Path Validation

```typescript
sandbox.resolvePath('src/index.ts');   // → /home/user/project/src/index.ts
sandbox.resolvePath('../../etc/passwd'); // throws SandboxError('path_violation')
sandbox.isPathAllowed('../outside');     // → false
```

## Command Validation

```typescript
sandbox.validateCommand('ls -la');
// → { allowed: true, reason: 'safe read-only', needsPermission: false }

sandbox.validateCommand('npm install express');
// → { allowed: true, reason: 'needs approval', needsPermission: true }

sandbox.validateCommand('sudo rm -rf /');
// → { allowed: false, reason: 'Banned command: sudo', needsPermission: false }
```

Individual checks:

- `isCommandBanned(cmd)` — returns matched ban pattern or `null`
- `isCommandSafeReadOnly(cmd)` — `true` if safe read-only
- `isCommandAllowed(cmd)` — `true` if in allowlist

## Write Validation

```typescript
sandbox.validateWrite('src/app.ts');
// → { allowed: true, reason: 'ok' }

sandbox.validateWrite('binary.exe');
// → { allowed: false, reason: 'Extension .exe not in allowlist' }
```

Also throws `SandboxError` if path escapes the sandbox.

## Network Validation

```typescript
sandbox.validateNetwork('https://api.github.com/repos');
// → { allowed: true, reason: 'host api.github.com in allowlist' }

sandbox.validateNetwork('https://evil.com');
// → { allowed: false, reason: 'host evil.com not in allowlist' }
```

## Permission System

For non-read-only, non-auto-approved operations:

```typescript
sandbox.onPermissionRequest = (req) => {
  console.log(`${req.tool}: ${req.description}`);
  // Approve or deny
  sandbox.grantPermission(req.id, true);  // persistent=true
  // or: sandbox.denyPermission(req.id);
};

const granted = await sandbox.requestPermission('bash', 'execute', 'Run npm install', { command: 'npm install' });
```

- Pending requests auto-deny after 5 minutes
- Persistent grants are remembered for matching tool+action+path
- `grantPermission(id, persistent?)` / `denyPermission(id)`

## Status

```typescript
const status: SandboxStatus = sandbox.getStatus();
// { rootDir, allowedCommands, bannedCommands, network, pendingPermissions, recentDecisions, stats, ... }
```

## Runtime Config Updates

```typescript
sandbox.updateConfig({
  autoApprove: true,
  network: 'allowed',
  bannedCommands: ['sudo'],
});
```

## SandboxError

```typescript
class SandboxError extends Error {
  code: 'path_violation' | 'command_banned' | 'command_not_allowed' | 'permission_denied' | 'network_blocked';
}
```
