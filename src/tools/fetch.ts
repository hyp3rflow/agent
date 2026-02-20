import type { Tool, ToolContext, ToolResult } from '../core/types.js';

const MAX_CHARS = 50000;

/**
 * Minimal HTML → readable text extraction.
 * Strips tags, decodes common entities, collapses whitespace.
 */
function htmlToText(html: string): string {
  let text = html;
  // Remove script/style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  // Block elements → newlines
  text = text.replace(/<\/?(div|p|br|h[1-6]|li|tr|blockquote|pre|section|article)[^>]*>/gi, '\n');
  // Headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    return '\n' + '#'.repeat(Number(level)) + ' ' + content.trim() + '\n';
  });
  // Links → [text](url)
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export const fetchTool: Tool = {
  name: 'fetch',
  description: `Fetch content from a URL. Supports text, markdown extraction from HTML, and raw HTML.
Use format="markdown" (default for HTML) to get readable extracted content from web pages.
Use format="text" for plain text extraction, "html" for raw HTML.
Output is truncated to 50000 characters.`,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch (http or https)' },
      method: { type: 'string', description: 'HTTP method (default: GET)' },
      headers: { type: 'object', description: 'Optional request headers' },
      format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'Output format (default: auto — markdown for HTML, text otherwise)' },
      timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
    },
  },
  required: ['url'],

  async execute(input: string, context: ToolContext): Promise<ToolResult> {
    const params = JSON.parse(input);
    const { url, method = 'GET', headers = {}, format, timeout = 30 } = params;

    try {
      const response = await globalThis.fetch(url, {
        method,
        headers: { 'User-Agent': 'openagent/1.0', ...headers },
        signal: context.signal ?? AbortSignal.timeout(timeout * 1000),
      });

      if (!response.ok) {
        return { content: `HTTP ${response.status} ${response.statusText}`, isError: true };
      }

      let text = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      const isHtml = contentType.includes('html') || text.trimStart().startsWith('<!') || text.trimStart().startsWith('<html');

      // Auto-detect format
      const outputFormat = format ?? (isHtml ? 'markdown' : 'text');

      if (outputFormat === 'markdown' && isHtml) {
        text = htmlToText(text);
      } else if (outputFormat === 'text' && isHtml) {
        text = htmlToText(text);
      }
      // 'html' format returns raw

      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) + `\n... (truncated, ${text.length} total chars)`;
      }
      return { content: text };
    } catch (err: any) {
      if (err.name === 'AbortError') return { content: 'Request timed out', isError: true };
      return { content: `Fetch error: ${err.message}`, isError: true };
    }
  },
};
