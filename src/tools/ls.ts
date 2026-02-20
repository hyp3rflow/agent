import { readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';

const IGNORE = new Set(['node_modules', '.git', '.next', '.cache', 'dist', '.DS_Store', '__pycache__', '.venv', 'venv']);
const MAX_ENTRIES = 1000;

export const lsTool: Tool = {
  name: 'ls',
  description: `List files and directories in a tree structure. Automatically ignores common non-essential directories (node_modules, .git, dist, etc.).
Use this to understand project structure and find files. Limited to 1000 entries.
Provide a path to list a specific directory, or omit for the working directory.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (default: working directory)' },
      depth: { type: 'number', description: 'Maximum depth to recurse (default: 3)' },
    },
  },

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const dir = resolve(context.workingDirectory ?? process.cwd(), params.path ?? '.');
    const maxDepth = params.depth ?? 3;
    const entries: string[] = [];

    async function walk(current: string, depth: number, prefix: string) {
      if (depth > maxDepth || entries.length >= MAX_ENTRIES) return;
      try {
        const items = await readdir(current, { withFileTypes: true });
        items.sort((a, b) => a.name.localeCompare(b.name));
        for (const item of items) {
          if (IGNORE.has(item.name)) continue;
          if (entries.length >= MAX_ENTRIES) break;
          const isDir = item.isDirectory();
          entries.push(`${prefix}${item.name}${isDir ? '/' : ''}`);
          if (isDir) {
            await walk(join(current, item.name), depth + 1, prefix + '  ');
          }
        }
      } catch { /* permission denied etc */ }
    }

    await walk(dir, 0, '');
    const truncated = entries.length >= MAX_ENTRIES ? `\n... (truncated at ${MAX_ENTRIES} entries)` : '';
    return { content: entries.join('\n') + truncated || '(empty directory)' };
  },
};
