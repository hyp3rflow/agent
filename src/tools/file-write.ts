import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../types.js';

export const fileWriteTool: Tool = {
  name: 'file_write',
  description: `Write content to a file. Creates the file if it doesn't exist, overwrites if it does.
Automatically creates parent directories as needed.
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
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, params.content, 'utf-8');
      const lines = params.content.split('\n').length;
      return { content: `Wrote ${lines} lines to ${params.path}` };
    } catch (err: any) {
      return { content: `Error writing file: ${err.message}`, isError: true };
    }
  },
};
