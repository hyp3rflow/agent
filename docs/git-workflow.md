# Git Workflow

First-party git integration for workflows. Auto-branch, auto-commit, auto-push — all configurable per-workflow.

## Configuration

Add `git` to your `WorkflowSchema`:

```typescript
const wf = defineWorkflow({
  name: 'feature-dev',
  // ... providers, main, tools ...

  git: {
    repoDir: '/home/user/project',  // defaults to sandbox.rootDir or cwd

    branch: {
      create: 'tycoon/{name}/{runId}',  // auto-create feature branch
      from: 'main',                      // base branch
      // OR: checkout: 'existing-branch',
    },

    commit: {
      strategy: 'on-complete',            // 'on-complete' | 'per-iteration' | 'never'
      messageTemplate: 'feat({name}): {status} — run {runId}',
      stageAll: true,
    },

    push: {
      enabled: true,
      remote: 'origin',
      setUpstream: true,
    },

    stashBeforeRun: false,   // stash uncommitted changes first
    includeGitTools: true,   // auto-include git_* tools (default: true)
  },
});
```

## GitWorkflowConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `repoDir` | `string?` | sandbox.rootDir or cwd | Git repo path |
| `branch.create` | `string?` | — | Auto-create branch (supports `{runId}`, `{name}`, `{date}`) |
| `branch.from` | `string?` | HEAD | Base ref for new branch |
| `branch.checkout` | `string?` | — | Switch to existing branch |
| `commit.strategy` | `string?` | `'on-complete'` | When to commit |
| `commit.messageTemplate` | `string?` | `'chore({name}): run {runId} — {status}'` | Commit message template |
| `commit.stageAll` | `boolean?` | `true` | `git add -A` before commit |
| `push.enabled` | `boolean?` | `false` | Auto-push after commit |
| `push.remote` | `string?` | `'origin'` | Remote name |
| `push.setUpstream` | `boolean?` | `true` | `-u` on first push |
| `stashBeforeRun` | `boolean?` | `false` | Stash dirty state before run |
| `includeGitTools` | `boolean?` | `true` | Include git tools automatically |

## Git Tools (7)

When `git` config is present (or tools are added manually), agents get these tools:

| Tool | Description |
|------|-------------|
| `git_status` | Branch info + working tree status |
| `git_diff` | Show changes (staged/unstaged/between refs) |
| `git_log` | Commit history |
| `git_commit` | Stage + commit (custom message, specific paths, amend) |
| `git_branch` | List, create, switch, delete branches |
| `git_push` | Push to remote (upstream, force-with-lease) |
| `git_stash` | Stash/pop/list uncommitted changes |

### Using Git Tools Standalone

```typescript
import { gitTools, gitStatusTool, gitCommitTool } from '@hrmm/agent/tools';

// All 7 git tools
const agent = new Agent({ tools: [...getDefaultTools(), ...gitTools] });

// Or pick specific ones
const agent = new Agent({ tools: [gitStatusTool, gitDiffTool, gitLogTool] });
```

## Lifecycle

When a workflow with `git` config runs:

1. **Before run**: Stash dirty state (if `stashBeforeRun`)
2. **Before run**: Create/checkout branch (if `branch.create` or `branch.checkout`)
3. **During run**: Agent has git tools available — can commit, diff, branch freely
4. **On complete**: Auto-commit changes (if `commit.strategy !== 'never'`)
5. **On complete**: Auto-push (if `push.enabled`)
6. **On error**: Restore stash (if stashed in step 1)

## Template Variables

| Variable | Description |
|----------|-------------|
| `{runId}` | Unique workflow run ID |
| `{name}` | Workflow name |
| `{date}` | ISO date (YYYY-MM-DD) |
| `{status}` | 'completed' or 'error' |

## Multi-Repo Workflows

Use different `repoDir` per workflow, or have agents work across repos:

```typescript
const wf = defineWorkflow({
  name: 'monorepo-feature',
  git: { repoDir: '/home/user/monorepo' },
  tools: [...getDefaultTools()],
  // Agent can also use git tools with cwd parameter to operate on other repos
});
```

Agents can pass `cwd` to any git tool to operate on a different directory than the default.
