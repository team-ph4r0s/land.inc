import { createServer, type IncomingMessage } from 'node:http';
import { basename } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { DAEMON_PORT, type ServerMessage } from '@land/protocol';
import { Store } from './store.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { startDemo } from './demo.ts';
import { describeTool, needsUser } from './activity.ts';

const args = process.argv.slice(2);
const port = Number(process.env.LAND_PORT ?? DAEMON_PORT);
const store = new Store();

if (args.includes('--demo')) startDemo(store);
if (!args.includes('--no-real')) {
  new ClaudeAdapter(store).start();
  new CodexAdapter(store).start();
}

/**
 * Transcripts are private. The daemon only listens on loopback, but any web page
 * open in the browser could still reach it, so browser requests must come from
 * a local origin (the office client). Hooks and curl send no Origin header.
 */
function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  // Vite answers on both names, and the app's browser pane opens localhost.
  const origins = (process.env.LAND_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((s) => s.trim());
  return origins.includes(origin);
}

const server = createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` || !allowedOrigin(req.headers.origin)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === 'POST' && req.url === '/hook') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        onClaudeHook(JSON.parse(body));
      } catch {
        // Hooks must never fail the agent; ignore bad payloads.
      }
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(store.snapshot()));
});

/**
 * Optional Claude Code hooks (see README) give instant signals the transcript
 * cannot: above all `Notification`, sent when Claude needs a permission or an answer.
 */
function onClaudeHook(h: Record<string, any>): void {
  const id = h.session_id;
  if (typeof id !== 'string') return;
  const now = Date.now();
  // Only notifications that ask the user for something change the office; ignoring the
  // rest before creating the agent keeps informational hooks from spawning anyone.
  if (h.hook_event_name === 'Notification' && !needsUser(h)) return;
  if (!store.has(id)) {
    store.update(id, { source: 'claude', cwd: h.cwd ?? '', project: h.cwd ? basename(h.cwd) : '' }, now);
  }
  switch (h.hook_event_name) {
    case 'Notification':
      store.waiting(id, h.message ?? 'Ждёт вас', now);
      break;
    case 'UserPromptSubmit':
      store.newTurn(id, 'Читает задачу', now);
      break;
    case 'PreToolUse': {
      const { activity, detail } = describeTool(h.tool_name ?? 'tool', h.tool_input ?? {});
      store.tool(id, h.tool_name ?? 'tool', activity, detail, now);
      break;
    }
    case 'PostToolUse':
      store.toolDone(id, now);
      break;
    case 'Stop':
      store.turnEnd(id, now);
      break;
  }
}

const wss = new WebSocketServer({ server, verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) =>
  req.headers.host === `127.0.0.1:${port}` && !!origin && allowedOrigin(origin) });
const clients = new Set<WebSocket>();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(store.snapshot()));
  ws.on('close', () => clients.delete(ws));
});
store.on('message', (msg: ServerMessage) => {
  if (!clients.size) return;
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[land] демон запущен: ws://127.0.0.1:${port}`);
});
