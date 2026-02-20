import { readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';

const IGNORE = new Set(['node_modules', '.git', '.next', '.cache', 'dist', '__pycache__', '.venv']);
const MAX_RESULTS = 1000;

export const globTool: Tool = {
  name: 'glob',
  description: `Find files matching a glob-like pattern. Searches recursively through the directory tree.
Supports simple patterns: * (any chars), ? (single char). Ignores node_modules, .git, etc.
Use this to find files by name or extension across a project.`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "*.ts", "src/**/*.test.ts", "package.json")' },
      path: { type: 'string', description: 'Base directory to search from (default: working directory)' },
    },
  },
  required: ['pattern'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const baseDir = resolve(context.workingDirectory ?? process.cwd(), params.path ?? '.');
    const pattern = params.pattern;
    const regex = globToRegex(pattern);
    const results: string[] = [];

    async function walk(dir: string) {
      if (results.length >= MAX_RESULTS) return;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (IGNORE.has(entry.name)) continue;
          if (results.length >= MAX_RESULTS) break;
          const fullPath = join(dir, entry.name);
          const relPath = relative(baseDir, fullPath);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (regex.test(relPath) || regex.test(entry.name)) {
            results.push(relPath);
          }
        }
      } catch { /* skip */ }
    }

    await walk(baseDir);
    results.sort();
    const truncated = results.length >= MAX_RESULTS ? `\n... (truncated at ${MAX_RESULTS})` : '';
    return { content: results.join('\n') + truncated || 'No files found.' };
  },
};

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/§DOUBLESTAR§/g, '.*');
  return new RegExp(`(^|/)${escaped}$`);
}
