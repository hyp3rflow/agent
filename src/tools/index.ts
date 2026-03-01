import type { Tool } from '../core/types.js';

export { bashTool } from './bash.js';
export { fileReadTool } from './file-read.js';
export { fileWriteTool } from './file-write.js';
export { fileEditTool } from './file-edit.js';
export { lsTool } from './ls.js';
export { grepTool } from './grep.js';
export { globTool } from './glob.js';
export { fetchTool } from './fetch.js';
export { gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool, gitBranchTool, gitPushTool, gitStashTool, gitTools } from './git.js';
export { webSearchTool } from './web-search.js';
export { patchTool } from './patch.js';
export { sourcegraphTool } from './sourcegraph.js';
export { createLspTools } from './lsp.js';

import { bashTool } from './bash.js';
import { fileReadTool } from './file-read.js';
import { fileWriteTool } from './file-write.js';
import { fileEditTool } from './file-edit.js';
import { lsTool } from './ls.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { fetchTool } from './fetch.js';
import { gitTools } from './git.js';
import { webSearchTool } from './web-search.js';
import { patchTool } from './patch.js';
import { sourcegraphTool } from './sourcegraph.js';

export function getDefaultTools(): Tool[] {
  return [bashTool, fileReadTool, fileWriteTool, fileEditTool, patchTool, lsTool, grepTool, globTool, fetchTool];
}

/** All default tools + git + web search + sourcegraph. */
export function getAllTools(): Tool[] {
  return [...getDefaultTools(), ...gitTools, webSearchTool, sourcegraphTool];
}

export function getReadOnlyTools(): Tool[] {
  return [fileReadTool, lsTool, grepTool, globTool, fetchTool];
}
