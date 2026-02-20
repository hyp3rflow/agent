import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';

const MAX_OUTPUT = 30000;

export const grepTool: Tool = {
  name: 'grep',
  description: `Search for a pattern in files using regex. Uses ripgrep (rg) if available, falls back to grep.
Returns matching lines in format: file:line_number:content.
Use this to find where functions/variables/strings are defined or used across a codebase.`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search in (default: working directory)' },
      include: { type: 'string', description: 'File glob pattern to include (e.g. "*.ts")' },
    },
  },
  required: ['pattern'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const searchPath = resolve(context.workingDirectory ?? process.cwd(), params.path ?? '.');

    return new Promise((resolve_) => {
      // Try ripgrep first, fallback to grep
      const tryRg = () => {
        const args = ['-n', '--no-heading', '--color=never', '-e', params.pattern];
        if (params.include) args.push('-g', params.include);
        args.push(searchPath);

        execFile('rg', args, { maxBuffer: MAX_OUTPUT * 2, timeout: 30000 }, (err, stdout, stderr) => {
          if (err && (err as any).code === 'ENOENT') {
            tryGrep();
            return;
          }
          handleResult(err, stdout);
        });
      };

      const tryGrep = () => {
        const args = ['-rn', '--color=never'];
        if (params.include) args.push('--include', params.include);
        args.push('-E', params.pattern, searchPath);

        execFile('grep', args, { maxBuffer: MAX_OUTPUT * 2, timeout: 30000 }, (err, stdout) => {
          handleResult(err, stdout);
        });
      };

      const handleResult = (err: Error | null, stdout: string) => {
        let output = stdout?.trim() || '';
        if (!output && err) {
          // grep returns exit code 1 for no matches
          resolve_({ content: 'No matches found.' });
          return;
        }
        if (output.length > MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT) + '\n... (truncated)';
        }
        resolve_({ content: output || 'No matches found.' });
      };

      tryRg();
    });
  },
};
