/**
 * LSP tools — diagnostics, references, restart.
 * Require an LspManager instance.
 */
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import type { LspManager } from '../lsp/manager.js';
import type { LspDiagnostic } from '../lsp/client.js';
import { resolve as resolvePath, relative } from 'node:path';

const SEVERITY_NAMES: Record<number, string> = {
  1: 'Error', 2: 'Warn', 3: 'Info', 4: 'Hint',
};

function formatDiagnostic(path: string, diag: LspDiagnostic, cwd: string): string {
  const severity = SEVERITY_NAMES[diag.severity ?? 3] ?? 'Info';
  const relPath = relative(cwd, path) || path;
  const loc = `${relPath}:${diag.range.start.line + 1}:${diag.range.start.character + 1}`;
  const source = diag.source ? `[${diag.source}]` : '';
  const code = diag.code ? `[${diag.code}]` : '';
  const tags = (diag.tags ?? []).map(t => t === 1 ? 'unnecessary' : t === 2 ? 'deprecated' : '').filter(Boolean);
  const tagStr = tags.length ? ` (${tags.join(', ')})` : '';
  return `${severity}: ${loc} ${source}${code}${tagStr} ${diag.message}`;
}

export function createLspTools(manager: LspManager): Tool[] {
  const cwd = process.cwd();

  const diagnosticsTool: Tool = {
    name: 'lsp_diagnostics',
    description: `Get diagnostics (errors, warnings) from the language server.
If file_path is provided, shows diagnostics for that file (and notifies the LSP of any changes).
If file_path is omitted, shows project-wide diagnostics from all running LSP servers.
Use after editing files to check for errors.`,
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to file (optional — omit for project-wide diagnostics)' },
      },
    },
    required: [],

    async execute(input: string, context: ToolContext): Promise<ToolResult> {
      const params = JSON.parse(input || '{}');
      const filePath = params.file_path ? resolvePath(params.file_path) : undefined;

      if (filePath) {
        await manager.notifyChange(filePath);
      }

      const allDiags = manager.getDiagnostics(filePath);

      if (allDiags.length === 0) {
        if (manager.getClients().length === 0) {
          return { content: 'No LSP servers running. Open a file first to start the appropriate LSP.' };
        }
        return { content: filePath ? 'No diagnostics for this file.' : 'No diagnostics found.' };
      }

      // Format
      const fileDiags: string[] = [];
      const projectDiags: string[] = [];
      let fileErrors = 0, fileWarnings = 0, projectErrors = 0, projectWarnings = 0;

      for (const { path, diagnostics } of allDiags) {
        const isCurrentFile = filePath && resolvePath(path) === filePath;
        for (const diag of diagnostics) {
          const formatted = formatDiagnostic(path, diag, cwd);
          if (isCurrentFile) {
            fileDiags.push(formatted);
            if (diag.severity === 1) fileErrors++;
            if (diag.severity === 2) fileWarnings++;
          } else {
            projectDiags.push(formatted);
            if (diag.severity === 1) projectErrors++;
            if (diag.severity === 2) projectWarnings++;
          }
        }
      }

      // Sort: errors first
      const sort = (arr: string[]) => arr.sort((a, b) => {
        const aErr = a.startsWith('Error');
        const bErr = b.startsWith('Error');
        if (aErr !== bErr) return aErr ? -1 : 1;
        return a.localeCompare(b);
      });

      sort(fileDiags);
      sort(projectDiags);

      let output = '';

      if (fileDiags.length > 0) {
        output += '<file_diagnostics>\n';
        output += (fileDiags.length > 10 ? fileDiags.slice(0, 10).join('\n') + `\n... and ${fileDiags.length - 10} more` : fileDiags.join('\n'));
        output += '\n</file_diagnostics>\n';
      }

      if (projectDiags.length > 0) {
        output += '\n<project_diagnostics>\n';
        output += (projectDiags.length > 10 ? projectDiags.slice(0, 10).join('\n') + `\n... and ${projectDiags.length - 10} more` : projectDiags.join('\n'));
        output += '\n</project_diagnostics>\n';
      }

      output += '\n<diagnostic_summary>\n';
      if (filePath) {
        output += `Current file: ${fileErrors} errors, ${fileWarnings} warnings\n`;
      }
      output += `Project: ${projectErrors} errors, ${projectWarnings} warnings\n`;
      output += '</diagnostic_summary>';

      return { content: output };
    },
  };

  const referencesTool: Tool = {
    name: 'lsp_references',
    description: `Find all references to a symbol using the language server.
Searches for the symbol in the codebase, then uses LSP to find all references including usages, imports, and type references.
More accurate than grep for finding symbol references because it understands the code semantically.`,
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The symbol name to find references for (e.g. function name, class name, variable)' },
        path: { type: 'string', description: 'File or directory to search in. Defaults to current working directory.' },
      },
      required: ['symbol'],
    },
    required: ['symbol'],

    async execute(input: string, context: ToolContext): Promise<ToolResult> {
      const params = JSON.parse(input);
      const symbol: string = params.symbol;
      if (!symbol) return { content: 'symbol is required', isError: true };

      const searchDir = params.path ? resolvePath(params.path) : cwd;

      if (manager.getClients().length === 0) {
        return { content: 'No LSP servers running. Try opening a file first.', isError: true };
      }

      // Step 1: grep for the symbol to find candidate locations
      const { execSync } = await import('node:child_process');
      let grepOutput: string;
      try {
        grepOutput = execSync(
          `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' --include='*.go' --include='*.rs' "${symbol.replace(/"/g, '\\"')}" "${searchDir}" 2>/dev/null | head -50`,
          { encoding: 'utf-8', timeout: 10000 },
        );
      } catch {
        return { content: `Symbol '${symbol}' not found in ${relative(cwd, searchDir) || '.'}` };
      }

      if (!grepOutput.trim()) {
        return { content: `Symbol '${symbol}' not found` };
      }

      // Step 2: Parse grep results, try LSP references on each match
      const lines = grepOutput.trim().split('\n');
      for (const line of lines) {
        const match = line.match(/^(.+?):(\d+):/);
        if (!match) continue;

        const [, filePath, lineStr] = match;
        const lineNum = parseInt(lineStr, 10) - 1;
        const lineContent = line.slice(match[0].length);
        const charNum = lineContent.indexOf(symbol);
        if (charNum === -1) continue;

        // Start LSP for this file type
        await manager.start(filePath);
        const client = manager.getClient(filePath);
        if (!client) continue;

        try {
          const refs = await manager.findReferences(filePath, lineNum, charNum);
          if (refs.length > 0) {
            // Group by file
            const byFile = new Map<string, Array<{ line: number; character: number }>>();
            for (const ref of refs) {
              const relPath = relative(cwd, ref.path) || ref.path;
              if (!byFile.has(relPath)) byFile.set(relPath, []);
              byFile.get(relPath)!.push({ line: ref.line, character: ref.character });
            }

            let output = `Found ${refs.length} reference(s) in ${byFile.size} file(s):\n\n`;
            for (const [file, locs] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
              output += `${file} (${locs.length} reference(s)):\n`;
              for (const loc of locs) {
                output += `  Line ${loc.line}, Column ${loc.character}\n`;
              }
              output += '\n';
            }
            return { content: output };
          }
        } catch {
          continue; // Try next match
        }
      }

      return { content: `No LSP references found for symbol '${symbol}'. The LSP may not support references for this symbol, or the symbol was only found in comments/strings.` };
    },
  };

  const restartTool: Tool = {
    name: 'lsp_restart',
    description: 'Restart all running LSP servers. Use when the language server seems stuck or is giving stale results.',
    parameters: { type: 'object', properties: {} },
    required: [],

    async execute(_input: string, _context: ToolContext): Promise<ToolResult> {
      const restarted = await manager.restartAll();
      if (restarted.length === 0) {
        return { content: 'No LSP servers were running.' };
      }
      return { content: `Restarted ${restarted.length} LSP server(s): ${restarted.join(', ')}` };
    },
  };

  return [diagnosticsTool, referencesTool, restartTool];
}
