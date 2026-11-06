import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { DAEMON_PORT, type ClientMessage, type ServerMessage } from '@land/protocol';
import { Store } from './store.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { startDemo } from './demo.ts';
import { describeTool, needsUser } from './activity.ts';
import { TaskBoard } from './tasks.ts';
import { createTeamCoordinator, createTeamRunner } from './team.ts';
import { FAKE_CODEX_MODELS, fakeExecutors } from './fake-executors.ts';
import { DnsService, FakeDnsBackend } from './dns.ts';
import { UpdatesService } from './updates.ts';
import { AgentService } from './agents.ts';
import { DoctorService, providerExecutors } from './doctor.ts';
import { record } from './json-store.ts';
import { claudeModels, ModelCatalogService } from './model-catalog.ts';
import { McpService } from './mcp.ts';
import { ProcessSupervisor } from './process-supervisor.ts';
import { requestUrl, SessionToken } from './session-token.ts';
import { LAND_HOME, SettingsService } from './settings.ts';
import { sanitizeWorkspacePath } from './workspace-path.ts';

const args = process.argv.slice(2);
const port = Number(process.env.LAND_PORT ?? DAEMON_PORT);
const store = new Store();

if (args.includes('--demo')) startDemo(store);
if (!args.includes('--no-real')) {
  new ClaudeAdapter(store).start();
  new CodexAdapter(store).start();
  new AntigravityAdapter(store).start();
}
// --fake-agents: tasks go to the fake CLIs from test/fakes and nothing is saved, for working on the UI without models.
const fake = args.includes('--fake-agents');
const dns = new DnsService(fake ? { backend: new FakeDnsBackend(), file: null } : { file: join(LAND_HOME, 'dns-backups.json') });
if (fake) process.env.FAKE_DELAY_MS ??= '6000';
const settings = new SettingsService(fake ? null : LAND_HOME);
const getSettings = () => settings.get();
const executors = fake ? fakeExecutors() : providerExecutors(getSettings);
const catalog = new ModelCatalogService(fake ? {
  modelsOverride: [...claudeModels(), ...FAKE_CODEX_MODELS.map((model) => ({ ...model, executor: 'codex' as const, origin: 'builtin' as const }))],
} : { antigravityCommand: () => executors.find((cli) => cli.id === 'antigravity')?.command() });
const agents = new AgentService(catalog, fake ? null : join(LAND_HOME, 'agents.json'));
const mcp = new McpService(join(LAND_HOME, 'mcp-runtime'), getSettings, () => broadcast({ type: 'mcp', mcp: mcp.status() }));
const doctor = new DoctorService(LAND_HOME, executors, catalog, mcp);
doctor.activeProcesses = () => board.activeCount();
const session = new SessionToken();
const supervisor = new ProcessSupervisor();
supervisor.bind();
const board = new TaskBoard(store, {
  executors, file: fake ? null : join(LAND_HOME, 'tasks.json'), catalog,
  settings: getSettings, supervisor, convertAttachment: (path) => mcp.convert(path),
});
const team = createTeamCoordinator(
  board,
  (message) => broadcast({ type: 'error', message }),
  (task, recipient) => {
    if (task.agentId) store.log(task.agentId, { at: Date.now(), kind: 'system', text: `Передаёт ответ коллеге ${recipient}` });
  },
  { onCollab: (collab) => broadcast({ type: 'collab', collab }), file: fake ? null : join(LAND_HOME, 'teams.json') },
);
const runner = createTeamRunner(board, {
  file: fake ? null : join(LAND_HOME, 'team-runs.json'),
  agents: () => agents.list(),
  onRun: (run) => broadcast({ type: 'team:updated', run }),
  presetStore: { list: () => settings.listPresets(), replace: (list) => settings.replacePresets(list) },
  onStage: (run, step, stage) => {
    // The bubble over the active character: the stage of its team step.
    const task = step.taskId ? board.list().find((t) => t.id === step.taskId) : undefined;
    if (task?.agentId) store.log(task.agentId, { at: Date.now(), kind: 'system', text: `Команда · шаг «${step.title}»: ${stage}` });
    // The step's chat is named after the team and the step, not after the envelope's first line.
    if (step.taskId) {
      const index = run.steps.findIndex((s) => s.taskId === step.taskId) + 1;
      try {
        settings.setMeta({ id: step.taskId, title: `Команда · шаг ${index} «${step.title}»: ${run.prompt.replace(/\s+/g, ' ').slice(0, 80)}`.slice(0, 200) });
        broadcast({ type: 'conversations.meta', meta: settings.meta() });
      } catch { /* a title is cosmetic */ }
    }
  },
});
const teamsMessage = (): Extract<ServerMessage, { type: 'teams' }> => ({
  type: 'teams', runs: runner.list(),
  presets: runner.presets(),
});
const updates = new UpdatesService((state) => broadcast({ type: 'updates', state }),
  () => !dns.changing && !board.list().some((t) => ['starting', 'running', 'cancelling'].includes(t.status)) && !team.list().some((t) => ['running', 'stopping'].includes(t.status)) && !runner.list().some((t) => ['running', 'stopping'].includes(t.status)), { fake });
process.on('message', (message: unknown) => {
  const m = record(message);
  const patch = record(m?.patch);
  if (m?.type === 'office.update.status' && patch) updates.set(patch as Parameters<UpdatesService['set']>[0]);
});

/**
 * Transcripts are private. The daemon only listens on loopback, but a web page
 * open in the browser could still reach it, so browser requests must come from
 * a local origin (the office client). Hooks and curl send no Origin header.
 */
function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  // Vite answers on both names, and the app's browser pane opens localhost.
  const officePort = process.env.LAND_OFFICE_PORT ?? '5173';
  const origins = (process.env.LAND_ALLOWED_ORIGINS ?? `http://127.0.0.1:${officePort},http://localhost:${officePort}`).split(',').map((s) => s.trim());
  return origins.includes(origin);
}

const server = createServer((req, res) => {
  // The daemon serves JSON only: nothing it answers may be framed, sniffed or run as a page.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.headers.host !== `127.0.0.1:${port}` || !allowedOrigin(req.headers.origin)) {
    res.writeHead(403).end();
    return;
  }
  const url = requestUrl(req.url);
  if (!url) { res.writeHead(400).end(); return; }
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'GET' && url.pathname === '/token') {
    if (!req.headers.origin) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ token: session.current() }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/hook') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 256 * 1024) {
        res.writeHead(413).end();
        req.destroy();
      }
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        onClaudeHook(JSON.parse(body));
      } catch {
        // Hooks must never fail the agent; ignore bad payloads.
      }
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: updates.state.current, pid: process.pid }));
    return;
  }
  if (!session.matches(url.searchParams.get('token'))) { res.writeHead(401).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(store.snapshot()));
});

/**
 * Optional Claude Code hooks (see README) give instant signals the transcript
 * cannot: above all `Notification`, sent when Claude needs a permission or an answer.
 */
function onClaudeHook(input: unknown): void {
  const h = record(input);
  const id = h?.session_id;
  if (!h || typeof id !== 'string' || !/^[a-z\d:-]{1,128}$/i.test(id)) return;
  const now = Date.now();
  // Only notifications that ask the user for something change the office; ignoring the
  // rest before creating the agent keeps informational hooks from spawning anyone.
  const event = typeof h.hook_event_name === 'string' ? h.hook_event_name : '';
  if (event === 'Notification' && !needsUser(h)) return;
  if (!store.has(id)) {
    const cwd = typeof h.cwd === 'string' ? h.cwd : '';
    store.update(id, { source: 'claude', cwd, project: cwd ? basename(cwd) : '' }, now);
  }
  switch (event) {
    case 'Notification':
      store.waiting(id, typeof h.message === 'string' ? h.message : 'Ждёт вас', now);
      break;
    case 'UserPromptSubmit':
      store.newTurn(id, 'Читает задачу', now);
      break;
    case 'PreToolUse': {
      const tool = typeof h.tool_name === 'string' ? h.tool_name : 'tool';
      const { activity, detail, test } = describeTool(tool, record(h.tool_input) ?? {});
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

const wss = new WebSocketServer({
  server, maxPayload: 8 * 1024 * 1024,
  verifyClient: ({ origin, req }, done) => {
    if (req.headers.host !== `127.0.0.1:${port}` || !origin || !allowedOrigin(origin)) return done(false, 403);
    if (!session.matches(requestUrl(req.url)?.searchParams.get('token'))) return done(false, 401);
    done(true);
  },
});
const clients = new Set<WebSocket>();
const send = (ws: WebSocket, msg: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (msg: ServerMessage) => {
  if (!clients.size) return;
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
};

const settingsMessage = (refresh = false): ServerMessage => ({
  type: 'settings', settings: getSettings(), providers: doctor.providers(refresh), mcp: mcp.status(),
});

function publishModels(): void {
  board.invalidateConfig();
  broadcast({ type: 'models:updated', catalog: catalog.get() });
  broadcast({ type: 'board', config: board.config(), tasks: board.list() });
}

async function refreshModels(refresh = false): Promise<void> {
  if (refresh) for (const executor of executors) executor.refresh?.();
  await catalog.rescan(refresh);
  publishModels();
}

wss.on('connection', (ws) => {
  clients.add(ws);
  send(ws, store.snapshot());
  send(ws, { type: 'board', config: board.config(), tasks: board.list() });
  send(ws, { type: 'collabs', collabs: team.list() });
  send(ws, teamsMessage());
  send(ws, { type: 'updates', state: updates.state });
  send(ws, { type: 'models:updated', catalog: catalog.get() });
  send(ws, { type: 'agents', agents: agents.list() });
  send(ws, settingsMessage());
  send(ws, { type: 'conversations.meta', meta: settings.meta() });
  ws.on('message', async (raw) => {
    if (ws.readyState !== ws.OPEN) return;
    // Only the office client (an allowed origin, see verifyClient) can start tasks.
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
      if (!record(msg) || typeof msg.type !== 'string') throw new Error('Некорректное сообщение');
    } catch {
      return send(ws, { type: 'error', message: 'Некорректное сообщение' });
    }
    const reqId = 'requestId' in msg && typeof msg.requestId === 'string' ? msg.requestId : undefined;
    const ack = (message?: string) => { if (reqId) send(ws, { type: 'ack', requestId: reqId, ok: true, message }); };
    try {
      if (updates.busy && ['task.create', 'task.reply', 'team.create', 'team.start', 'team.resume'].includes(msg.type)) throw new Error('Офис обновляется. Дождитесь завершения');
      if (msg.type === 'models.rescan') await refreshModels();
      else if (msg.type === 'agents.save' || msg.type === 'agents.duplicate' || msg.type === 'agents.delete') {
        if (msg.type === 'agents.save') agents.save(msg.agent);
        else if (msg.type === 'agents.duplicate') agents.duplicate(msg.id);
        else agents.delete(msg.id);
        broadcast({ type: 'agents', agents: agents.list() });
        ack();
      } else if (msg.type === 'settings.update') {
        const before = getSettings().providers;
        settings.update(msg.patch);
        const changed = JSON.stringify(before) !== JSON.stringify(getSettings().providers);
        if (changed) await refreshModels(true);
        broadcast(settingsMessage(changed));
        ack();
      } else if (msg.type === 'mcp.install') {
        await mcp.install(msg.id);
        broadcast(settingsMessage());
      } else if (msg.type === 'conversation.meta') {
        settings.setMeta(msg.meta);
        broadcast({ type: 'conversations.meta', meta: settings.meta() });
      } else if (msg.type === 'doctor.run' || msg.type === 'doctor.fix') {
        if (msg.type === 'doctor.fix') {
          await doctor.fix(msg.id);
          if (msg.id === 'models') publishModels();
          broadcast(settingsMessage(true));
        }
        send(ws, { type: 'doctor', checks: await doctor.run(), at: Date.now() });
      } else if (msg.type === 'backup.export') {
        if (!reqId) throw new Error('Не указан идентификатор запроса');
        const teams = teamsMessage();
        send(ws, { type: 'backup', requestId: reqId, backup: settings.exportBackup(agents, teams.presets.filter((preset) => !preset.builtin)) });
      } else if (msg.type === 'backup.import') {
        if (!reqId) throw new Error('Не указан идентификатор запроса');
        const ignoredOverrides = settings.importBackup(msg.backup, agents);
        broadcast(settingsMessage());
        broadcast(teamsMessage());
        broadcast({ type: 'agents', agents: agents.list() });
        broadcast({ type: 'conversations.meta', meta: settings.meta() });
        ack(ignoredOverrides ? 'Импорт завершён. Локальные пути к CLI сохранены' : undefined);
      } else if (msg.type === 'token.rotate') {
        session.rotate();
        ack('Сессионный токен обновлён');
        for (const client of clients) client.close(4001, 'Session token rotated');
      } else if (msg.type === 'cache.clear') {
        await refreshModels(true);
        broadcast(settingsMessage(true));
        ack('Кеш CLI и моделей обновлён');
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
        broadcast({ type: 'task', task: { ...board.create(msg.task) } });
        if (msg.requestId) send(ws, { type: 'task.accepted', requestId: msg.requestId });
        broadcast({ type: 'board', config: board.config(), tasks: board.list() });
      } else if (msg.type === 'team.create') {
        team.startTeam(msg.task, msg.colleague, msg.planner);
        if (msg.requestId) send(ws, { type: 'task.accepted', requestId: msg.requestId });
        broadcast({ type: 'board', config: board.config(), tasks: board.list() });
      } else if (msg.type === 'task.reply') {
        broadcast({ type: 'task', task: { ...board.reply(msg.taskId, { prompt: msg.prompt, access: msg.access, model: msg.model, effort: msg.effort }) } });
        if (msg.requestId) send(ws, { type: 'task.accepted', requestId: msg.requestId });
        broadcast({ type: 'board', config: board.config(), tasks: board.list() });
      } else if (msg.type === 'artifact.save') {
        if (!reqId || typeof msg.path !== 'string' || !msg.path.trim() || msg.path.length > 400) throw new Error('Некорректный путь артефакта');
        const task = board.get(msg.taskId);
        if (!task) throw new Error('Задача не найдена');
        const path = sanitizeWorkspacePath(resolve(task.cwd, msg.path), task.cwd);
        const text = board.fullResult(task.id) ?? task.result ?? '';
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, msg.format === 'txt' ? text.replace(/```[a-z]*\n?/gi, '') : text, 'utf8');
        send(ws, { type: 'artifact:saved', requestId: reqId, path });
        ack(`Сохранено: ${path}`);
      } else if (msg.type === 'team.start') {
        runner.start(msg.run);
        if (msg.requestId) send(ws, { type: 'task.accepted', requestId: msg.requestId });
        broadcast({ type: 'board', config: board.config(), tasks: board.list() });
      } else if (msg.type === 'team.resume') {
        runner.resume(msg.id, msg.fromStep, msg.override);
        ack();
        broadcast({ type: 'board', config: board.config(), tasks: board.list() });
      } else if (msg.type === 'team.stop') runner.stop(msg.id);
      else if (msg.type === 'preset.save' || msg.type === 'preset.delete') {
        if (msg.type === 'preset.save') runner.savePreset(msg.preset);
        else runner.deletePreset(msg.id);
        broadcast(teamsMessage());
        ack();
      } else if (msg.type === 'task.cancel') board.cancel(msg.id);
      else if (msg.type === 'team.cancel') team.cancelTeam(msg.id);
    } catch (e) {
      if (msg.type === 'backup.export' && reqId) send(ws, { type: 'backup', requestId: reqId, error: (e as Error).message });
      else if (reqId && ['agents.save', 'settings.update', 'backup.import', 'token.rotate', 'cache.clear', 'team.resume', 'preset.save', 'artifact.save'].includes(msg.type))
        send(ws, { type: 'ack', requestId: reqId, ok: false, message: (e as Error).message });
      else if (msg.type === 'updates.install') updates.set({ phase: 'failed', message: (e as Error).message });
      else if ((msg.type === 'task.create' || msg.type === 'team.create' || msg.type === 'task.reply' || msg.type === 'team.start') && msg.requestId)
        send(ws, { type: 'task.rejected', requestId: msg.requestId, message: (e as Error).message });
      else send(ws, { type: 'error', message: (e as Error).message });
    }
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => ws.terminate());
});
store.on('message', broadcast);
board.on('task', (task) => {
  broadcast({ type: 'task', task });
  team.continueTeam(task);
  runner.onTask(task);
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
  void refreshModels();
  void mcp.detect().then(() => { if (!fake) return mcp.installBundled(); });
});
setTimeout(() => void updates.check(), 10_000).unref();
setInterval(() => void updates.check(), 4 * 60 * 60_000).unref();
