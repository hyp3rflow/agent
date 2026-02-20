import { spawn } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '../types.js';

const MAX_OUTPUT = 30000;

export const bashTool: Tool = {
  name: 'bash',
  description: `Execute a shell command. Use this to run CLI commands, install packages, run scripts, or interact with the system.
The command runs in a bash shell with the working directory set to the project root.
Commands time out after 60 seconds by default. Output (stdout+stderr combined) is truncated to 30000 characters.
Use for: running tests, checking file contents, installing dependencies, git operations, system commands.
Do NOT use for: long-running servers (they will timeout), interactive commands requiring TTY input.`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' },
    },
  },
  required: ['command'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const { command, timeout = 60000 } = params;

    return new Promise((resolve) => {
      let output = '';
      let killed = false;

      const proc = spawn('bash', ['-c', command], {
        cwd: context.workingDirectory ?? process.cwd() ?? process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 3000);
      }, timeout);

      const onData = (data: Buffer) => {
        output += data.toString();
        if (output.length > MAX_OUTPUT * 1.5) {
          killed = true;
          proc.kill('SIGTERM');
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      context.signal.addEventListener('abort', () => {
          proc.kill('SIGTERM');
        }, { once: true });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (output.length > MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT) + `\n... (truncated, ${output.length} total chars)`;
        }
        const exitInfo = killed ? ' (killed - timeout or output limit)' : '';
        resolve({
          content: `${output}\n\nExit code: ${code ?? 1}${exitInfo}`,
          isError: (code ?? 1) !== 0,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ content: `Error spawning process: ${err.message}`, isError: true });
      });
    });
  },
};
