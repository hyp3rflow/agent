import type { Tool, ToolContext, ToolResult } from '../core/types.js';

/**
 * Web search tool using Brave Search API.
 * Requires BRAVE_API_KEY environment variable.
 */
export const webSearchTool: Tool = {
  name: 'web_search',
  description: `Search the web using Brave Search API. Returns titles, URLs, and snippets.
Useful for finding current information, documentation, APIs, or any web content.
Requires BRAVE_API_KEY environment variable to be set.`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string' },
      count: { type: 'number', description: 'Number of results (1-20, default: 5)' },
      country: { type: 'string', description: '2-letter country code for region-specific results (e.g. "US", "KR")' },
      freshness: { type: 'string', description: 'Filter by time: "pd" (24h), "pw" (week), "pm" (month), "py" (year)' },
    },
  },
  required: ['query'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const apiKey = process.env.BRAVE_API_KEY;

    if (!apiKey) {
      return { content: 'Error: BRAVE_API_KEY environment variable not set', isError: true };
    }

    const count = Math.min(20, Math.max(1, params.count ?? 5));
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', params.query);
    url.searchParams.set('count', String(count));
    if (params.country) url.searchParams.set('country', params.country);
    if (params.freshness) url.searchParams.set('freshness', params.freshness);

    try {
      const resp = await fetch(url.toString(), {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: context.signal,
      });

      if (!resp.ok) {
        return { content: `Search API error: ${resp.status} ${resp.statusText}`, isError: true };
      }

      const data = await resp.json() as {
        web?: { results?: Array<{ title: string; url: string; description: string }> };
        query?: { original: string };
      };

      const results = data.web?.results ?? [];
      if (results.length === 0) {
        return { content: `No results found for: ${params.query}` };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`
      ).join('\n\n');

      return { content: `Search results for "${params.query}":\n\n${formatted}` };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { content: 'Search canceled', isError: true };
      }
      return { content: `Search error: ${err.message}`, isError: true };
    }
  },
};
