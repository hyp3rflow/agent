import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../core/types.js';
import { fileTimestamps } from './file-read.js';

interface PatchAction {
  type: 'update' | 'add' | 'delete';
  path: string;
  hunks: Array<{ context: string; lines: string[] }>;
  content?: string; // for 'add'
}

function parsePatch(patchText: string): PatchAction[] {
  const actions: PatchAction[] = [];
  const lines = patchText.split('\n');
  let i = 0;

  // Skip until *** Begin Patch
  while (i < lines.length && !lines[i].startsWith('*** Begin Patch')) i++;
  i++;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('*** End Patch')) break;

    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      const hunks: Array<{ context: string; lines: string[] }> = [];
      let currentHunk: { context: string; lines: string[] } | null = null;

      while (i < lines.length && !lines[i].startsWith('***')) {
        if (lines[i].startsWith('@@ ')) {
          if (currentHunk) hunks.push(currentHunk);
          currentHunk = { context: lines[i].slice(3).trim(), lines: [] };
        } else if (currentHunk) {
          currentHunk.lines.push(lines[i]);
        }
        i++;
      }
      if (currentHunk) hunks.push(currentHunk);
      actions.push({ type: 'update', path, hunks });
    } else if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const contentLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('***')) {
        // Strip leading + for add file content
        contentLines.push(lines[i].startsWith('+') ? lines[i].slice(1) : lines[i]);
        i++;
      }
      actions.push({ type: 'add', path, hunks: [], content: contentLines.join('\n') });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      actions.push({ type: 'delete', path, hunks: [] });
    } else {
      i++;
    }
  }

  return actions;
}

function applyHunks(original: string, hunks: Array<{ context: string; lines: string[] }>): { result: string; error?: string } {
  let fileLines = original.split('\n');

  for (const hunk of hunks) {
    // Find the context line
    const contextIdx = fileLines.findIndex(l => l.trim() === hunk.context.trim());
    if (contextIdx === -1) {
      return { result: '', error: `Context line not found: "${hunk.context}"` };
    }

    // Parse hunk lines: space = keep, - = remove, + = add
    const newLines: string[] = [];
    let pos = contextIdx;
    const fileLinesCopy = [...fileLines];

    // Add everything before context
    newLines.push(...fileLinesCopy.slice(0, pos));

    for (const hunkLine of hunk.lines) {
      const prefix = hunkLine[0];
      const content = hunkLine.slice(1);

      if (prefix === ' ') {
        // Keep line — verify match
        if (pos < fileLinesCopy.length && fileLinesCopy[pos].trimEnd() === content.trimEnd()) {
          newLines.push(fileLinesCopy[pos]);
          pos++;
        } else {
          newLines.push(content);
          pos++;
        }
      } else if (prefix === '-') {
        // Remove — skip line in original
        if (pos < fileLinesCopy.length && fileLinesCopy[pos].trimEnd() === content.trimEnd()) {
          pos++;
        } else {
          return { result: '', error: `Line to remove not found at expected position: "${content}"` };
        }
      } else if (prefix === '+') {
        // Add new line
        newLines.push(content);
      }
    }

    // Add remaining lines after hunk
    newLines.push(...fileLinesCopy.slice(pos));
    fileLines = newLines;
  }

  return { result: fileLines.join('\n') };
}

export const patchTool: Tool = {
  name: 'patch',
  description: `Apply a patch to multiple files in one operation. Useful for coordinated changes across files.

Format:
*** Begin Patch
*** Update File: path/to/file
@@ Context line (unique within file)
 Line to keep
-Line to remove
+Line to add
*** Add File: path/to/new/file
+Content line 1
+Content line 2
*** Delete File: path/to/remove
*** End Patch

Requirements:
- Context lines must uniquely identify sections
- Whitespace must match exactly
- Read files before patching (stale-write protection)
- Use relative or absolute paths`,
  parameters: {
    type: 'object',
    properties: {
      patch_text: { type: 'string', description: 'The full patch text' },
    },
  },
  required: ['patch_text'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const cwd = context.workingDirectory ?? process.cwd();

    if (!params.patch_text) {
      return { content: 'patch_text is required', isError: true };
    }

    let actions: PatchAction[];
    try {
      actions = parsePatch(params.patch_text);
    } catch (e: any) {
      return { content: `Failed to parse patch: ${e.message}`, isError: true };
    }

    if (actions.length === 0) {
      return { content: 'No patch actions found. Check format.', isError: true };
    }

    // Phase 1: Validate all files
    for (const action of actions) {
      const absPath = resolve(cwd, action.path);

      if (action.type === 'update' || action.type === 'delete') {
        // Check file exists
        try {
          const st = await stat(absPath);
          // Stale check
          const knownMtime = fileTimestamps.get(absPath);
          if (knownMtime !== undefined && st.mtimeMs !== knownMtime) {
            return {
              content: `File ${action.path} modified externally since last read. Re-read before patching.`,
              isError: true,
            };
          }
        } catch {
          return { content: `File not found: ${action.path}`, isError: true };
        }
      }

      if (action.type === 'add') {
        try {
          await stat(absPath);
          return { content: `File already exists: ${action.path}. Use Update instead.`, isError: true };
        } catch { /* good — doesn't exist */ }
      }
    }

    // Phase 2: Apply all changes
    const changed: string[] = [];
    let additions = 0;
    let removals = 0;

    for (const action of actions) {
      const absPath = resolve(cwd, action.path);

      if (action.type === 'add') {
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, action.content ?? '', 'utf-8');
        additions += (action.content ?? '').split('\n').length;
        changed.push(`+ ${action.path}`);
      } else if (action.type === 'delete') {
        const content = await readFile(absPath, 'utf-8');
        removals += content.split('\n').length;
        await unlink(absPath);
        changed.push(`- ${action.path}`);
      } else if (action.type === 'update') {
        const content = await readFile(absPath, 'utf-8');
        const { result, error } = applyHunks(content, action.hunks);
        if (error) {
          return { content: `Failed to apply patch to ${action.path}: ${error}`, isError: true };
        }
        await writeFile(absPath, result, 'utf-8');

        // Count changes
        for (const hunk of action.hunks) {
          for (const line of hunk.lines) {
            if (line.startsWith('+')) additions++;
            if (line.startsWith('-')) removals++;
          }
        }
        changed.push(`~ ${action.path}`);
      }

      // Update mtime tracker
      try {
        const st = await stat(absPath);
        fileTimestamps.set(absPath, st.mtimeMs);
      } catch { /* deleted file */ }
    }

    return {
      content: `Patch applied: ${changed.length} files changed, +${additions} -${removals}\n${changed.join('\n')}`,
      metadata: JSON.stringify({ filesChanged: changed, additions, removals }),
    };
  },
};
