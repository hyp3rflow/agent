import type { Tool, ToolContext, ToolResult } from '../types.js';

const MAX_CHARS = 50000;

export const fetchTool: Tool = {
  name: 'fetch',
  description: `Fetch content from a URL and return the response body as text.
Use this to retrieve web pages, API responses, documentation, or any HTTP resource.
Output is truncated to 50000 characters. Only text-based responses are supported.`,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch (must be http or https)' },
      method: { type: 'string', description: 'HTTP method (default: GET)' },
      headers: { type: 'object', description: 'Optional request headers' },
    },
  },
  required: ['url'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const { url, method = 'GET', headers = {} } = params;

    try {
      const response = await globalThis.fetch(url, {
        method,
        headers: { 'User-Agent': 'openagent/1.0', ...headers },
        signal: context.signal ?? AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return { content: `HTTP ${response.status} ${response.statusText}`, isError: true };
      }

      let text = await response.text();
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) + `\n... (truncated, ${text.length} total chars)`;
      }
      return { content: text };
    } catch (err: any) {
      return { content: `Fetch error: ${err.message}`, isError: true };
    }
  },
};
