import type { Tool } from '../core/types.js';

export { bashTool } from './bash.js';
export { fileReadTool } from './file-read.js';
export { fileWriteTool } from './file-write.js';
export { fileEditTool } from './file-edit.js';
export { lsTool } from './ls.js';
export { grepTool } from './grep.js';
export { globTool } from './glob.js';
export { fetchTool } from './fetch.js';

import { bashTool } from './bash.js';
import { fileReadTool } from './file-read.js';
import { fileWriteTool } from './file-write.js';
import { fileEditTool } from './file-edit.js';
import { lsTool } from './ls.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { fetchTool } from './fetch.js';

export function getDefaultTools(): Tool[] {
  return [bashTool, fileReadTool, fileWriteTool, fileEditTool, lsTool, grepTool, globTool, fetchTool];
}

export function getReadOnlyTools(): Tool[] {
  return [fileReadTool, lsTool, grepTool, globTool, fetchTool];
}
