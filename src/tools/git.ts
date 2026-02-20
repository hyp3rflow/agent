import { spawn } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';

const MAX_OUTPUT = 30000;

function runGit(args: string[], cwd?: string, timeout = 30000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn('git', args, {
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (d) => { stdout += d; if (stdout.length > MAX_OUTPUT) { proc.kill(); } });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ stdout, stderr: stderr + '\n[git command timed out]', code: code ?? 1 });
      } else {
        resolve({ stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, 5000), code: code ?? 0 });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, code: 1 });
    });
  });
}

// ─── git_status ───

export const gitStatusTool: Tool = {
  name: 'git_status',
  description: 'Get git repository status including branch, staged/unstaged changes, and untracked files.',
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Working directory (defaults to project root)' },
    },
  },
  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const cwd = params.cwd ?? context.workingDirectory;
    const { stdout, stderr, code } = await runGit(['status', '--porcelain=v2', '--branch'], cwd);
    if (code !== 0) return { content: `git status failed: ${stderr}`, isError: true };
    // Also get a human-readable version
    const { stdout: readable } = await runGit(['status', '--short', '--branch'], cwd);
    return { content: readable || '(clean working tree)' };
  },
};

// ─── git_diff ───

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description: 'Show git diff. Defaults to unstaged changes. Use staged=true for staged, or specify a commit/branch to compare against.',
  parameters: {
    type: 'object',
    properties: {
      staged: { type: 'boolean', description: 'Show staged changes instead of unstaged' },
      target: { type: 'string', description: 'Compare against a commit, branch, or ref (e.g. "main", "HEAD~3")' },
      path: { type: 'string', description: 'Limit diff to a specific file or directory' },
      stat: { type: 'boolean', description: 'Show diffstat summary only' },
      cwd: { type: 'string', description: 'Working directory' },
    },
  },
  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const cwd = params.cwd ?? context.workingDirectory;
    const args = ['diff'];
    if (params.staged) args.push('--cached');
    if (params.stat) args.push('--stat');
    if (params.target) args.push(params.target);
    if (params.path) { args.push('--'); args.push(params.path); }
    const { stdout, stderr, code } = await runGit(args, cwd);
    if (code !== 0) return { content: `git diff failed: ${stderr}`, isError: true };
    return { content: stdout || '(no changes)' };
  },
};

// ─── git_log ───

export const gitLogTool: Tool = {
  name: 'git_log',
  description: 'Show git commit log. Returns recent commits with hash, author, date, and message.',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'Number of commits to show (default: 20)' },
      oneline: { type: 'boolean', description: 'One line per commit (default: true)' },
      branch: { type: 'string', description: 'Branch or ref to show log for' },
      path: { type: 'string', description: 'Limit to commits touching this path' },
      cwd: { type: 'string', description: 'Working directory' },
    },
  },
  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const cwd = params.cwd ?? context.workingDirectory;
    const count = params.count ?? 20;
    const args = ['log', `-${count}`];
    if (params.oneline !== false) args.push('--oneline', '--decorate');
    if (params.branch) args.push(params.branch);
    if (params.path) { args.push('--'); args.push(params.path); }
    const { stdout, stderr, code } = await runGit(args, cwd);
    if (code !== 0) return { content: `git log failed: ${stderr}`, isError: true };
    return { content: stdout || '(no commits)' };
  },
};

// ─── git_commit ───

export const gitCommitTool: Tool = {
  name: 'git_commit',
  description: 'Stage and commit changes. By default stages all changes. Use paths to stage specific files.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message (required)' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific paths to stage. Empty = stage all changes (git add -A).',
      },
      amend: { type: 'boolean', description: 'Amend the previous commit' },
      cwd: { type: 'string', description: 'Working directory' },
    },
  },
  required: ['message'],
  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const cwd = params.cwd ?? context.workingDirectory;

    // Stage
    if (params.paths?.length > 0) {
      const { stderr, code } = await runGit(['add', ...params.paths], cwd);
      if (code !== 0) return { content: `git add failed: ${stderr}`, isError: true };
    } else {
      const { stderr, code } = await runGit(['add', '-A'], cwd);
      if (code !== 0) return { content: `git add failed: ${stderr}`, isError: true };
    }

    // Commit
    const args = ['commit', '-m', params.message];
    if (params.amend) args.push('--amend');
    const { stdout, stderr, code } = await runGit(args, cwd);
    if (code !== 0) return { content: `git commit failed: ${stderr}`, isError: true };
    return { content: stdout };
  },
};

// ─── git_branch ───

export const gitBranchTool: Tool = {
  name: 'git_branch',
  description: 'Manage git branches. Create, switch, list, or delete branches.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'switch', 'delete'],
        description: 'Branch action (default: list)',
      },
      name: { type: 'string', description: 'Branch name (for create/switch/delete)' },
      from: { type: 'string', description: 'Base ref for new branch (default: current HEAD)' },
      cwd: { type: 'string', description: 'Working directory' },
    },
  },
  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const cwd = params.cwd ?? context.workingDirectory;
    const action = params.action ?? 'list';

    switch (action) {
      case 'list': {
        const { stdout, stderr, code } = await runGit(['branch', '-a', '--sort=-committerdate'], cwd);
        if (code !== 0) return { content: `git branch failed: ${stderr}`, isError: true };
        return { content: stdout || '(no branches)' };
      }
      case 'create': {
        if (!params.name) return { content: 'Branch name required', isError: true };
        const args = ['checkout', '-b', params.name];
        if (params.from) args.push(params.from);
        const { stdout, stderr, code } = await runGit(args, cwd);
        if (code !== 0) return { content: `Failed to create branch: ${stderr}`, isError: true };
        return { content: `Created and switched to branch '${params.name}'` };
      }
      case 'switch': {
        if (!params.name) return { content: 'Branch name required', isError: true };
        const { stderr, code } = await runGit(['checkout', params.name], cwd);
        if (code !== 0) return { content: `Failed to switch branch: ${stderr}`, isError: true };
        return { content: `Switched to branch '${params.name}'` };
      }
      case 'delete': {
        if (!params.name) return { content: 'Branch name required', isError: true };
        const { stderr, code } = await runGit(['branch', '-d', params.name], cwd);
        if (code !== 0) return { content: `Failed to delete branch: ${stderr}`, isError: true };
        return { content: `Deleted branch '${params.name}'` };
      }
      default:
        return { content: `Unknown action: ${action}`, isError: true };
    }
  },
};

// ─── git_push ───

export const gitPushTool: Tool = {
  name: 'git_push',
  description: 'Push commits to remote. Supports setting upstream for new branches.',
  parameters: {
    type: 'object',
    properties: {
      remote: { type: 'string', description: 'Remote name (default: origin)' },
      branch: { type: 'string', description: 'Branch to push (default: current)' },
      setUpstream: { type: 'boolean', description: 'Set upstream tracking (-u)' },
      force: { type: 'boolean', description: 'Force push (use with caution)' },
      cwd: { type: 'string', description: 'Working directory' },
    },
  },
  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const cwd = params.cwd ?? context.workingDirectory;
    const args = ['push'];
    if (params.setUpstream) args.push('-u');
    if (params.force) args.push('--force-with-lease');
    args.push(params.remote ?? 'origin');
    if (params.branch) args.push(params.branch);
    const { stdout, stderr, code } = await runGit(args, cwd, 60000);
    if (code !== 0) return { content: `git push failed: ${stderr}`, isError: true };
    return { content: stderr || stdout || 'Pushed successfully' }; // git push outputs to stderr
  },
};

// ─── git_stash ───

export const gitStashTool: Tool = {
  name: 'git_stash',
  description: 'Stash or restore uncommitted changes.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['push', 'pop', 'list', 'drop'],
        description: 'Stash action (default: push)',
      },
      message: { type: 'string', description: 'Stash message (for push)' },
      cwd: { type: 'string', description: 'Working directory' },
    },
  },
  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const cwd = params.cwd ?? context.workingDirectory;
    const action = params.action ?? 'push';
    const args = ['stash', action];
    if (action === 'push' && params.message) args.push('-m', params.message);
    const { stdout, stderr, code } = await runGit(args, cwd);
    if (code !== 0) return { content: `git stash ${action} failed: ${stderr}`, isError: true };
    return { content: stdout || stderr || `Stash ${action} completed` };
  },
};

// ─── Exports ───

export const gitTools: Tool[] = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitBranchTool,
  gitPushTool,
  gitStashTool,
];
