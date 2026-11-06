import { createInterface } from 'node:readline';
import { MCP_IDS, type McpId } from '@land/protocol';
import { record } from './json-store.ts';
import { applyMcpPipeline, compactContext, contextBudget } from './mcp.ts';

const descriptions: Record<McpId, string> = {
  markitdown: 'Convert a workspace attachment to Markdown.',
  'context-budget': 'Count characters and estimate tokens.',
  'strategic-compact': 'Compact intermediate text while preserving headings, names and code signatures.',
  'agentic-shield': 'Check prompt safety and redact credential patterns.',
};

const fields = {
  text: { type: 'string', maxLength: 2_000_000 },
  path: { type: 'string', maxLength: 4096 },
  limit: { type: 'integer', minimum: 1, maximum: 2_000_000 },
};

export async function serveMcp(runtime: string): Promise<void> {
  const selected = process.argv[2];
  const ids = selected === undefined ? MCP_IDS : MCP_IDS.filter((id) => id === selected);
  const tools = ids.map((name) => {
    const required = name === 'markitdown' ? ['path'] : name === 'strategic-compact' ? ['text', 'limit'] : ['text'];
    return { name, description: descriptions[name], inputSchema: { type: 'object', required,
      properties: Object.fromEntries(required.map((key) => [key, fields[key as keyof typeof fields]])), additionalProperties: false } };
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const send = (id: string | number | null, payload: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
  const error = (id: string | number | null, code: number, message: string) => send(id, { error: { code, message } });
  for await (const line of input) {
    let request: Record<string, unknown> | undefined;
    try { request = record(JSON.parse(line)); } catch { error(null, -32700, 'Invalid JSON'); continue; }
    if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') { error(null, -32600, 'Invalid request'); continue; }
    const id = request.id;
    if (id === undefined) continue;
    if (typeof id !== 'number' && typeof id !== 'string') { error(null, -32600, 'Invalid request ID'); continue; }
    const params = record(request.params);
    if (request.method === 'initialize') {
      const requested = params?.protocolVersion;
      send(id, { result: { protocolVersion: requested === '2025-03-26' || requested === '2025-06-18' ? requested : '2025-11-25',
        capabilities: { tools: {} }, serverInfo: { name: 'land.inc', version: '1.5.0' } } });
    } else if (request.method === 'ping') send(id, { result: {} });
    else if (request.method === 'tools/list') send(id, { result: { tools } });
    else if (request.method === 'tools/call') {
      const tool = ids.find((name) => name === params?.name);
      const args = record(params?.arguments);
      if (!tool || !args) { error(id, -32602, 'Invalid tool or arguments'); continue; }
      try {
        const result = execute(tool, args, runtime);
        send(id, { result: { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] } });
      } catch (failure) {
        send(id, { result: { isError: true, content: [{ type: 'text', text: (failure as Error).message }] } });
      }
    } else error(id, -32601, 'Unknown method');
  }
}

function execute(id: McpId, args: Record<string, unknown>, runtime: string): object | string {
  const cwd = process.cwd();
  if (id === 'markitdown') {
    if (typeof args.path !== 'string' || args.path.length > 4096) throw new Error('Specify a workspace attachment');
    return applyMcpPipeline('', { cwd, attachments: [args.path], runtime }).prompt;
  }
  if (typeof args.text !== 'string' || args.text.length > 2_000_000) throw new Error('Specify text up to 2,000,000 characters');
  if (id === 'context-budget') return contextBudget(args.text);
  if (id === 'agentic-shield') {
    const result = applyMcpPipeline(args.text, { cwd });
    return { prompt: result.prompt, warnings: result.warnings };
  }
  if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 2_000_000)
    throw new Error('Specify an integer limit between 1 and 2,000,000');
  return compactContext(args.text, args.limit);
}
