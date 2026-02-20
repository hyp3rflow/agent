import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import { fileTimestamps } from './file-read.js';

export const fileEditTool: Tool = {
  name: 'file_edit',
  description: `Make a surgical edit to a file by replacing exact text. The oldText must match exactly (including whitespace and indentation).
Verifies the file hasn't been modified externally since last read (stale-write protection).
Use this for precise edits to existing files. For creating new files or full rewrites, use file_write instead.
The tool will error if oldText is not found or appears multiple times (ambiguous match).`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      oldText: { type: 'string', description: 'Exact text to find (must match exactly including whitespace)' },
      newText: { type: 'string', description: 'New text to replace the old text with' },
    },
  },
  required: ['path', 'oldText', 'newText'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const filePath = resolve(context.workingDirectory ?? process.cwd(), params.path);

    try {
      // Stale-write check
      const knownMtime = fileTimestamps.get(filePath);
      if (knownMtime !== undefined) {
        const st = await stat(filePath);
        if (st.mtimeMs !== knownMtime) {
          return {
            content: `Error: file ${params.path} has been modified externally since last read (expected mtime ${new Date(knownMtime).toISOString()}, got ${new Date(st.mtimeMs).toISOString()}). Re-read the file before editing.`,
            isError: true,
          };
        }
      }

      const content = await readFile(filePath, 'utf-8');
      const { oldText, newText } = params;

      // Count occurrences
      let count = 0;
      let idx = 0;
      while ((idx = content.indexOf(oldText, idx)) !== -1) {
        count++;
        idx += oldText.length;
      }

      if (count === 0) {
        return { content: `Error: oldText not found in ${params.path}`, isError: true };
      }
      if (count > 1) {
        return { content: `Error: oldText found ${count} times in ${params.path} (ambiguous). Use a larger context to make the match unique.`, isError: true };
      }

      const updated = content.replace(oldText, newText);
      await writeFile(filePath, updated, 'utf-8');

      // Update tracked mtime
      try {
        const st = await stat(filePath);
        fileTimestamps.set(filePath, st.mtimeMs);
      } catch { /* ignore */ }

      return { content: `Edited ${params.path}` };
    } catch (err: any) {
      return { content: `Error editing file: ${err.message}`, isError: true };
    }
  },
};
