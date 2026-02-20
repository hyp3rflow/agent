import { writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import { fileTimestamps } from './file-read.js';

export const fileWriteTool: Tool = {
  name: 'file_write',
  description: `Write content to a file. Creates the file if it doesn't exist, overwrites if it does.
Automatically creates parent directories as needed.
If the file was previously read, verifies it hasn't been modified externally since the last read (stale-write protection).
Use this to create new files or completely replace file contents.
For partial edits, use file_edit instead.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to working directory or absolute)' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
  },
  required: ['path', 'content'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const filePath = resolve(context.workingDirectory ?? process.cwd(), params.path);

    try {
      // Stale-write check: if we previously read this file, verify mtime hasn't changed
      const knownMtime = fileTimestamps.get(filePath);
      if (knownMtime !== undefined) {
        try {
          const st = await stat(filePath);
          if (st.mtimeMs !== knownMtime) {
            return {
              content: `Error: file ${params.path} has been modified externally since last read (expected mtime ${new Date(knownMtime).toISOString()}, got ${new Date(st.mtimeMs).toISOString()}). Re-read the file before writing.`,
              isError: true,
            };
          }
        } catch {
          // File may have been deleted — allow write
        }
      }

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, params.content, 'utf-8');

      // Update tracked mtime after successful write
      try {
        const st = await stat(filePath);
        fileTimestamps.set(filePath, st.mtimeMs);
      } catch { /* ignore */ }

      const lines = params.content.split('\n').length;
      return { content: `Wrote ${lines} lines to ${params.path}` };
    } catch (err: any) {
      return { content: `Error writing file: ${err.message}`, isError: true };
    }
  },
};
