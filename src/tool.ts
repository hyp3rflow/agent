import type { Tool, ToolContext, ToolResult } from './types.js';

export type { Tool, ToolContext, ToolResult };

export interface ToolConfig {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  required?: string[];
  execute(input: string, context: ToolContext): Promise<ToolResult>;
}

export function defineTool(config: ToolConfig): Tool {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    required: config.required,
    execute: config.execute,
  };
}
