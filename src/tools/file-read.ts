import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';

const MAX_BYTES = 50 * 1024;

/**
 * In-memory file timestamp tracker.
 * Tracks mtime at read time so write/edit can detect stale overwrites.
 */
export const fileTimestamps = new Map<string, number>();

export const fileReadTool: Tool = {
  name: 'file_read',
  description: `Read the contents of a file. Returns the file content with line numbers.
Use offset and limit to read specific portions of large files.
Supports text files only. Output is capped at 50KB.
Use this to examine source code, configuration files, logs, or any text file.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to working directory or absolute)' },
      offset: { type: 'number', description: 'Line number to start reading from (1-indexed, default: 1)' },
      limit: { type: 'number', description: 'Maximum number of lines to read' },
    },
  },
  required: ['path'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const filePath = resolve(context.workingDirectory ?? process.cwd(), params.path);
    const offset = Math.max(1, params.offset ?? 1);
    const limit = params.limit;

    try {
      // Track mtime for stale-write detection
      const st = await stat(filePath);
      fileTimestamps.set(filePath, st.mtimeMs);

      const raw = await readFile(filePath, 'utf-8');
      if (Buffer.byteLength(raw) > MAX_BYTES && !limit) {
        const lines = raw.split('\n');
        let result = '';
        let bytes = 0;
        for (let i = offset - 1; i < lines.length; i++) {
          const line = `${i + 1}\t${lines[i]}\n`;
          bytes += Buffer.byteLength(line);
          if (bytes > MAX_BYTES) {
            result += `\n... (truncated at 50KB, file has ${lines.length} lines)`;
            break;
          }
          result += line;
        }
        return { content: result };
      }

      const lines = raw.split('\n');
      const start = offset - 1;
      const end = limit ? start + limit : lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n');

      return { content: numbered || '(empty file)' };
    } catch (err: any) {
      return { content: `Error reading file: ${err.message}`, isError: true };
    }
  },
};
