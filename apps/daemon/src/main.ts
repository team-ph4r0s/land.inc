import { createServer, type IncomingMessage } from 'node:http';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse as parseUrl } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { DAEMON_PORT, assertClientMessage, type ClientMessage, type ServerMessage } from '@land/protocol';
import { Store } from './store.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { startDemo } from './demo.ts';
import { describeTool, needsUser } from './activity.ts';
import { TaskBoard } from './tasks.ts';
import { createTeamCoordinator } from './team.ts';
import { fakeExecutors } from './fake-executors.ts';
import { DnsService, FakeDnsBackend } from './dns.ts';
import { UpdatesService } from './updates.ts';
import { McpManager } from './executors/mcp-manager.ts';
import { createSessionToken, authorizeRequest, sanitizeWorkspacePath } from './security/shield.ts';
import { AgentRegistry } from './agents/registry.ts';

const args = process.argv.slice(2);
const port = Number(process.env.LAND_PORT ?? DAEMON_PORT);
const store = new Store();
const sessionToken = createSessionToken();
const mcp = new McpManager();
const agents = new AgentRegistry();
const MAX_HOOK_BODY = 256 * 1024;

function persistSessionToken(token: string): void {
  const path = process.env.LAND_TOKEN_FILE ?? join(homedir(), '.land', 'daemon.token');
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    console.warn(`[land] не удалось сохранить токен сессии: ${(error as Error).message}`);
  }
}
persistSessionToken(sessionToken);

if (args.includes('--demo')) startDemo(store);
if (!args.includes('--no-real')) {
  new ClaudeAdapter(store).start();
  new CodexAdapter(store).start();
  new AntigravityAdapter(store).start();
}
// --fake-agents: tasks go to the fake CLIs from test/fakes and nothing is saved, for working on the UI without models.
const fake = args.includes('--fake-agents');
const dns = new DnsService(fake ? { backend: new FakeDnsBackend(), file: null } : {});
if (fake) process.env.FAKE_DELAY_MS ??= '6000';
const board = new TaskBoard(store, fake ? { executors: fakeExecutors(), file: null } : {});
const team = createTeamCoordinator(
  board,
  (message) => broadcast({ type: 'error', message }),
  (task, recipient) => {
    if (task.agentId) store.log(task.agentId, { at: Date.now(), kind: 'system', text: `Передаёт ответ коллеге ${recipient}` });
  },
  { onCollab: (collab) => broadcast({ type: 'collab', collab }), ...(fake ? { file: null } : {}) },
);
const updates = new UpdatesService((state) => broadcast({ type: 'updates', state }),
  () => !dns.changing && !board.list().some((t) => ['starting', 'running', 'cancelling'].includes(t.status)) && !team.list().some((t) => ['running', 'stopping'].includes(t.status)), { fake });
process.on('message', (message: unknown) => {
  if (isRecord(message) && message.type === 'office.update.status' && isRecord(message.patch)) updates.set(message.patch as Parameters<UpdatesService['set']>[0]);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Transcripts are private. The daemon only listens on loopback, but a web page
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
  const url = parseUrl(req.url ?? '/', true);
  const queryToken = typeof url.query.token === 'string' ? url.query.token : undefined;
  const requestHeaders = queryToken ? { ...req.headers, 'x-land-token': queryToken } : req.headers;
  const secureHeaders = { 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };
  const respond = (status: number, headers: Record<string, string> = {}) => res.writeHead(status, { ...secureHeaders, ...headers });
  if (req.headers.host !== `127.0.0.1:${port}` || !allowedOrigin(req.headers.origin)) {
    respond(403).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/hook') {
    if (!authorizeRequest(requestHeaders, sessionToken, `127.0.0.1:${port}`)) { respond(403).end(); return; }
    let body = '';
    let size = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return;
      size += Buffer.byteLength(c);
      if (size > MAX_HOOK_BODY) { rejected = true; req.destroy(); respond(413).end(); return; }
      body += c;
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const payload: unknown = JSON.parse(body);
        if (!isRecord(payload)) throw new Error('Некорректный hook payload');
        onClaudeHook(payload);
      } catch {
        // Hooks must never fail the agent; ignore bad payloads.
      }
      respond(204).end();
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    respond(200, { 'content-type': 'application/json', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ version: updates.state.current, pid: process.pid, token: sessionToken }));
    return;
  }
  if (!authorizeRequest(requestHeaders, sessionToken, `127.0.0.1:${port}`)) { respond(403).end(); return; }
  respond(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(store.snapshot()));
});

/**
 * Optional Claude Code hooks (see README) give instant signals the transcript
 * cannot: above all `Notification`, sent when Claude needs a permission or an answer.
 */
function onClaudeHook(h: Record<string, unknown>): void {
  const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
  const id = text(h.session_id);
  if (typeof id !== 'string') return;
  const now = Date.now();
  // Only notifications that ask the user for something change the office; ignoring the
  // rest before creating the agent keeps informational hooks from spawning anyone.
  const event = text(h.hook_event_name);
  if (event === 'Notification' && !needsUser(h)) return;
  if (!store.has(id)) {
    const cwd = text(h.cwd);
    store.update(id, { source: 'claude', cwd, project: cwd ? basename(cwd) : '' }, now);
  }
  switch (event) {
    case 'Notification':
      store.waiting(id, text(h.message, 'Ждёт вас'), now);
      break;
    case 'UserPromptSubmit':
      store.newTurn(id, 'Читает задачу', now);
      break;
    case 'PreToolUse': {
      const tool = text(h.tool_name, 'tool');
      const input = isRecord(h.tool_input) ? h.tool_input : {};
      const { activity, detail, test } = describeTool(tool, input);
      store.tool(id, tool, activity, detail, now, test);
      break;
    }
    case 'PostToolUse':
      store.toolDone(id, now);
      break;
    case 'PostToolUseFailure':
      store.toolDone(id, now, false);
      break;
    case 'Stop':
      store.turnEnd(id, now);
      break;
  }
}

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => {
  const token = typeof req.headers['x-land-token'] === 'string' ? req.headers['x-land-token'] : new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? undefined;
  return req.headers.host === `127.0.0.1:${port}` && !!origin && allowedOrigin(origin) && authorizeRequest({ ...req.headers, 'x-land-token': token }, sessionToken, `127.0.0.1:${port}`);
} });
const clients = new Set<WebSocket>();
const send = (ws: WebSocket, msg: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (msg: ServerMessage) => {
  if (!clients.size) return;
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
};

setTimeout(() => void mcp.audit().then((statuses) => broadcast({ type: 'mcp:status', statuses })), 0).unref();

wss.on('connection', (ws) => {
  clients.add(ws);
  send(ws, { type: 'security.session', token: sessionToken });
  send(ws, { type: 'agents', agents: agents.list() });
  send(ws, store.snapshot());
  send(ws, { type: 'board', config: board.config(), tasks: board.list() });
  send(ws, { type: 'collabs', collabs: team.list() });
  send(ws, { type: 'updates', state: updates.state });
  void mcp.audit().then((statuses) => send(ws, { type: 'mcp:status', statuses }));
  ws.on('message', async (raw) => {
    // Only the office client (an allowed origin, see verifyClient) can start tasks.
    let msg: ClientMessage;
    try {
      msg = assertClientMessage(JSON.parse(String(raw)));
    } catch {
      return send(ws, { type: 'error', message: 'Некорректное сообщение' });
    }
    try {
      if (updates.busy && ['task.create', 'task.reply', 'team.create'].includes(msg.type)) throw new Error('Офис обновляется. Дождитесь завершения');
      if (msg.type === 'agents.list') send(ws, { type: 'agents', agents: agents.list() });
      else if (msg.type === 'agent.create') {
        const agent = agents.create(msg.agent);
        const event = { type: 'agent:created' as const, agent };
        broadcast({ type: 'agent', event });
      } else if (msg.type === 'agent.update') {
        const agent = agents.update(msg.id, msg.patch);
        broadcast({ type: 'agent', event: { type: 'agent:updated', agent } });
      } else if (msg.type === 'agent.clone') {
        const agent = agents.clone(msg.id, msg.name);
        broadcast({ type: 'agent', event: { type: 'agent:created', agent } });
      } else if (msg.type === 'agent.delete') {
        agents.remove(msg.id);
        broadcast({ type: 'agent', event: { type: 'agent:deleted', id: msg.id } });
      } else if (msg.type === 'mcp.audit') send(ws, { type: 'mcp:status', statuses: await mcp.audit() });
      else if (msg.type === 'mcp.install') {
        const statuses = await mcp.install(msg.request, (name, progress, message) => broadcast({ type: 'mcp:install:progress', name, progress, message }));
        broadcast({ type: 'mcp:install:complete', statuses });
      } else if (msg.type === 'artifact.save') {
        if (!msg.requestId || msg.path.length > 400) throw new Error('Некорректный путь артефакта');
        const task = board.get(msg.taskId);
        if (!task) throw new Error('Задача не найдена');
        const path = sanitizeWorkspacePath(resolve(task.cwd, msg.path), task.cwd);
        const text = board.fullResult(task.id) ?? task.result ?? '';
        writeFileSync(path, msg.format === 'txt' ? text.replace(/```[a-z]*\n?/gi, '') : text, 'utf8');
        send(ws, { type: 'artifact:saved', requestId: msg.requestId, path });
      } else if (msg.type === 'updates.check') await updates.check();
      else if (msg.type === 'updates.install') await updates.install(msg.version, msg.sha);
      else if (msg.type === 'dns.read' || msg.type === 'dns.test' || msg.type === 'dns.apply' || msg.type === 'dns.restore') {
        if (typeof msg.requestId !== 'string' || msg.requestId.length > 100) throw new Error('Некорректный запрос DNS');
        try {
          if (updates.busy && (msg.type === 'dns.apply' || msg.type === 'dns.restore')) throw new Error('Офис обновляется. Дождитесь завершения');
          if (msg.type === 'dns.apply' && !msg.settings) throw new Error('Не заданы новые настройки DNS');
          if (msg.type === 'dns.test') send(ws, { type: 'dns.result', requestId: msg.requestId, probes: await dns.test(msg.servers) });
          else {
            const state = msg.type === 'dns.read' ? await dns.state() : await dns.change(msg.adapterId, msg.revision, msg.type === 'dns.apply' ? msg.settings : undefined);
            send(ws, { type: 'dns.result', requestId: msg.requestId, state, message: msg.type === 'dns.apply' ? 'DNS применены и проверены' : msg.type === 'dns.restore' ? 'Прежние настройки DNS восстановлены' : undefined });
          }
        } catch (e) { send(ws, { type: 'dns.result', requestId: msg.requestId, error: (e as Error).message }); }
      } else if (msg.type === 'board.refresh') {
        send(ws, { type: 'board', config: board.config(true), tasks: board.list() });
      } else if (msg.type === 'folders.list') {
        try {
          if (msg.path !== undefined && (typeof msg.path !== 'string' || !isAbsolute(msg.path))) throw new Error('Укажите полный путь');
          const path = resolve(msg.path ?? homedir());
          const folders = readdirSync(path, { withFileTypes: true }).filter((entry) => {
            if (entry.isDirectory()) return true;
            if (!entry.isSymbolicLink()) return false;
            try { return statSync(join(path, entry.name)).isDirectory(); } catch { return false; }
          }).map((entry) => join(path, entry.name)).sort((a, b) => a.localeCompare(b));
          const parent = dirname(path);
          send(ws, { type: 'folders', requestId: msg.requestId, path, parent: parent === path ? undefined : parent, folders });
        } catch {
          send(ws, { type: 'folders', requestId: msg.requestId, error: 'Не удалось открыть папку. Проверьте путь и права доступа.' });
        }
      } else if (msg.type === 'task.create') {
        board.create(msg.task);
        if (msg.requestId) send(ws, { type: 'task.accepted', requestId: msg.requestId });
        broadcast({ type: 'board', config: board.config(), tasks: board.list() });
      } else if (msg.type === 'team.create') {
        if (msg.pipeline) {
          const stages = msg.pipeline.stages.toSorted((a, b) => a.order - b.order);
          const profiles = stages.map((stage) => agents.get(stage.agentId));
          if (!profiles.length || profiles.some((profile) => !profile)) throw new Error('В pipeline есть неизвестный агент');
          const first = profiles[0]!;
          const participants = profiles.slice(1).map((profile, index) => ({ executor: profile!.provider, model: profile!.model, effort: profile!.reasoningEffort, access: stages[index + 1].access }));
          team.startTeam({ ...msg.task, executor: first.provider, model: first.model, effort: first.reasoningEffort, access: first.defaultAccessMode === 'workspace-write' ? 'write' : 'read' }, participants);
        } else team.startTeam(msg.task, msg.colleague, msg.planner);
        if (msg.requestId) send(ws, { type: 'task.accepted', requestId: msg.requestId });
        broadcast({ type: 'board', config: board.config(), tasks: board.list() });
      } else if (msg.type === 'task.reply') {
        board.reply(msg.taskId, { prompt: msg.prompt, access: msg.access, model: msg.model, effort: msg.effort });
        if (msg.requestId) send(ws, { type: 'task.accepted', requestId: msg.requestId });
        broadcast({ type: 'board', config: board.config(), tasks: board.list() });
      } else if (msg.type === 'task.cancel') board.cancel(msg.id);
      else if (msg.type === 'team.cancel') team.cancelTeam(msg.id);
    } catch (e) {
      if (msg.type === 'updates.install') updates.set({ phase: 'failed', message: (e as Error).message });
      else if ((msg.type === 'task.create' || msg.type === 'team.create' || msg.type === 'task.reply') && msg.requestId)
        send(ws, { type: 'task.rejected', requestId: msg.requestId, message: (e as Error).message });
      else send(ws, { type: 'error', message: (e as Error).message });
    }
  });
  ws.on('close', () => clients.delete(ws));
});
store.on('message', broadcast);
board.on('task', (task) => {
  broadcast({ type: 'task', task });
  team.continueTeam(task);
});
board.on('stream', (stream) => broadcast({ type: 'task:stream:chunk', ...stream }));
// Fake CLIs write no transcripts: put their workers in the office from the board instead.
if (fake)
  board.on('task', (task) => {
    if (!task.agentId) return;
    const at = Date.now();
    const title = task.prompt.split('\n')[0].slice(0, 48);
    store.update(task.agentId, { source: task.executor, title, cwd: task.cwd, project: basename(task.cwd), model: task.model, effort: task.effort, taskId: task.id }, at);
    if (task.status === 'running') store.tool(task.agentId, 'Fake', task.access === 'write' ? 'write' : 'read', 'Работает над задачей', at);
    else if (['done', 'failed', 'cancelled'].includes(task.status)) store.turnEnd(task.agentId, at);
  });

server.listen(port, '127.0.0.1', () => {
  console.log(`[land] демон запущен: ws://127.0.0.1:${port}`);
});
setTimeout(() => void updates.check(), 10_000).unref();
setInterval(() => void updates.check(), 4 * 60 * 60_000).unref();
