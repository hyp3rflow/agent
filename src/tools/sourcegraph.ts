import type { Tool, ToolContext, ToolResult } from '../core/types.js';

const SOURCEGRAPH_API = 'https://sourcegraph.com/.api/graphql';

const GRAPHQL_QUERY = `query Search($query: String!) {
  search(query: $query, version: V2, patternType: keyword) {
    results {
      matchCount
      limitHit
      results {
        __typename
        ... on FileMatch {
          repository { name }
          file { path, url, content }
          lineMatches { preview, lineNumber, offsetAndLengths }
        }
      }
    }
  }
}`;

export const sourcegraphTool: Tool = {
  name: 'sourcegraph',
  description: `Search code across public repositories using Sourcegraph.

Use to find code examples, implementations, patterns in open source.

Query syntax:
- "fmt.Println" — exact match
- "file:.ts useState" — filter by file type
- "repo:^github.com/org/repo$" — specific repo
- "lang:typescript" — filter by language
- "type:symbol" — search symbols (functions, classes)
- "type:diff after:\\"1 month ago\\"" — recent changes

Examples:
- "file:.ts context.WithTimeout lang:go"
- "repo:facebook/react useState type:symbol"
- "lang:typescript defineWorkflow file:.ts"`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Sourcegraph search query' },
      count: { type: 'number', description: 'Number of results (default: 10, max: 20)' },
      context_window: { type: 'number', description: 'Lines of context around matches (default: 5)' },
    },
  },
  required: ['query'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);

    if (!params.query) {
      return { content: 'query is required', isError: true };
    }

    const count = Math.min(20, Math.max(1, params.count ?? 10));
    const contextWindow = params.context_window ?? 5;

    // Append count to query
    const query = `${params.query} count:${count}`;

    try {
      const resp = await fetch(SOURCEGRAPH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { query } }),
        signal: context.signal,
      });

      if (!resp.ok) {
        return { content: `Sourcegraph API error: ${resp.status} ${resp.statusText}`, isError: true };
      }

      const data = await resp.json() as any;
      const searchResults = data?.data?.search?.results;
      if (!searchResults) {
        return { content: 'No results from Sourcegraph', isError: true };
      }

      const matchCount = searchResults.matchCount ?? 0;
      const limitHit = searchResults.limitHit ?? false;
      const results = (searchResults.results ?? []).slice(0, count);

      if (results.length === 0) {
        return { content: `No results found for: ${params.query}` };
      }

      let output = `# Sourcegraph Search Results\n\nFound ${matchCount} matches`;
      if (limitHit) output += ' (limit reached, try a more specific query)';
      output += '\n\n';

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.__typename !== 'FileMatch') continue;

        const repoName = r.repository?.name ?? 'unknown';
        const filePath = r.file?.path ?? 'unknown';
        const fileUrl = r.file?.url ?? '';
        const fileContent = r.file?.content ?? '';
        const lineMatches = r.lineMatches ?? [];

        output += `## ${i + 1}. ${repoName}/${filePath}\n`;
        if (fileUrl) output += `URL: https://sourcegraph.com${fileUrl}\n`;
        output += '\n';

        if (lineMatches.length > 0 && fileContent) {
          const lines = fileContent.split('\n');
          for (const lm of lineMatches) {
            const lineNum = Math.floor(lm.lineNumber ?? 0);
            const start = Math.max(0, lineNum - contextWindow);
            const end = Math.min(lines.length, lineNum + contextWindow + 1);

            output += '```\n';
            for (let j = start; j < end; j++) {
              const marker = j === lineNum ? '>' : ' ';
              output += `${marker}${j + 1}| ${lines[j]}\n`;
            }
            output += '```\n\n';
          }
        } else if (lineMatches.length > 0) {
          for (const lm of lineMatches) {
            output += `  L${Math.floor(lm.lineNumber ?? 0) + 1}: ${lm.preview}\n`;
          }
          output += '\n';
        }
      }

      return { content: output.slice(0, 30000) };
    } catch (err: any) {
      if (err.name === 'AbortError') return { content: 'Search canceled', isError: true };
      return { content: `Sourcegraph error: ${err.message}`, isError: true };
    }
  },
};
