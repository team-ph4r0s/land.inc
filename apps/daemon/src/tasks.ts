import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { BoardConfig, ModelOption, NewTask, Task } from '@land/protocol';
import type { Store } from './store.ts';
import { clip } from './activity.ts';

const MAX_RUNNING = 4;
const MAX_PROMPT = 20_000;
const KEEP_TASKS = 100;
const CONFIG_TTL_MS = 60_000;

const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
].map((m) => ({ ...m, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }));

type Rec = Record<string, any>;

/**
 * The task board: the user writes a task, picks a project folder, an executor and
 * a model, and the daemon starts that agent's own CLI in the folder. The CLI writes
 * its transcript as usual, so the new worker walks into the office by itself.
 */
export class TaskBoard extends EventEmitter<{ task: [Task] }> {
  private tasks: Task[] = [];
  private procs = new Map<string, ChildProcess>();
  private file = join(homedir(), '.land', 'tasks.json');
  private cached?: { at: number; config: BoardConfig };
  /**
   * A cancel settles only once both are known: the CLI closed, and how the tree kill
   * went. Either can come first (taskkill /T closes the CLI before it exits itself).
   */
  private cancels = new Map<string, { closed: boolean; last?: string; kill?: { error?: string } }>();
  /** Swappable in tests. */
  private killTree = killTree;
  private store: Store;

  constructor(store: Store) {
    super();
    this.store = store;
    this.load();
    // Tag the worker in the office once its transcript shows up.
    store.on('message', (m) => {
      if (m.type !== 'upsert' || m.agent.taskId) return;
      const task = this.tasks.find((t) => t.agentId === m.agent.id);
      if (task) store.update(m.agent.id, { source: m.agent.source, taskId: task.id });
    });
    process.on('exit', () => {
      for (const p of this.procs.values()) killTree(p, true);
    });
  }

  list(): Task[] {
    return this.tasks;
  }

  config(): BoardConfig {
    if (this.cached && Date.now() - this.cached.at < CONFIG_TTL_MS) return this.cached.config;
    const claude = claudeBin();
    const codex = codexBin();
    // The CLI bundled with Claude Desktop is signed in only inside Desktop's own sessions.
    const signedIn = !!claude && claudeSignedIn(claude);
    const claudeNote = !claude
      ? 'claude.exe не найден (Claude Desktop или Claude Code)'
      : signedIn
        ? undefined
        : `Claude Code не авторизован для фоновых задач. Один раз выполните в терминале: & "${claude}" auth login`;
    const projects = this.projects();
    const config: BoardConfig = {
      projects,
      outsideGit: projects.filter((p) => !inGit(p)),
      executors: {
        claude: { available: signedIn, models: CLAUDE_MODELS, note: claudeNote },
        codex: { available: !!codex, models: codexModels(), note: codex ? undefined : 'codex.exe не найден (Codex Desktop или Codex CLI)' },
      },
    };
    this.cached = { at: Date.now(), config };
    return config;
  }

  /** Validate and start a task. Throws an Error with a message for the user. */
  create(input: NewTask): Task {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw new Error('Опишите задачу');
    if (prompt.length > MAX_PROMPT) throw new Error(`Задача длиннее ${MAX_PROMPT} символов`);
    // Check before resolve(): an empty or relative path would quietly become the daemon's own folder.
    const raw = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    if (!raw || !isAbsolute(raw)) throw new Error('Укажите полный путь к папке проекта');
    const cwd = resolve(raw);
    if (!isDir(cwd)) throw new Error('Папка проекта не найдена');
    if (input.executor !== 'claude' && input.executor !== 'codex') throw new Error('Неизвестный исполнитель');
    if (input.access !== 'read' && input.access !== 'write') throw new Error('Неизвестный режим доступа');
    const executor = this.config().executors[input.executor];
    if (!executor.available) throw new Error(executor.note ?? 'Исполнитель недоступен');
    // Only listed models and efforts reach the command line.
    const model = executor.models.find((m) => m.id === input.model);
    if (!model) throw new Error('Модель недоступна');
    if (input.effort && !model.efforts?.includes(input.effort)) throw new Error('Такой уровень рассуждений модель не поддерживает');
    // A task being cancelled still holds its slot until its processes are gone.
    if (this.tasks.filter((t) => t.status === 'starting' || t.status === 'running' || t.status === 'cancelling').length >= MAX_RUNNING)
      throw new Error(`Одновременно выполняется не больше ${MAX_RUNNING} задач`);

    const task: Task = {
      id: randomUUID(),
      prompt,
      cwd,
      executor: input.executor,
      model: model.id,
      effort: input.effort || undefined,
      access: input.access,
      outsideGit: !inGit(cwd) || undefined,
      status: 'starting',
      createdAt: Date.now(),
    };
    this.tasks.unshift(task);
    this.tasks = this.tasks.slice(0, KEEP_TASKS);
    if (!this.config().projects.includes(cwd)) this.cached = undefined;
    this.run(task);
    return task;
  }

  cancel(id: string): void {
    const p = this.procs.get(id);
    const task = this.tasks.find((t) => t.id === id);
    if (!task || !p) return;
    // Cancelling again retries the kill, in case the first attempt did not take.
    task.status = 'cancelling';
    const attempt: { closed: boolean; last?: string; kill?: { error?: string } } = { closed: false };
    this.cancels.set(id, attempt);
    // The CLI starts its own children (shells, tools); stop the whole tree or report that we could not.
    this.killTree(p, false, (error) => {
      if (this.cancels.get(id) !== attempt) return; // a newer attempt took over
      attempt.kill = { error };
      if (error && !attempt.closed) {
        task.result = `Не удалось остановить процессы задачи: ${error}. Попробуйте отменить ещё раз.`;
        this.changed(task);
      }
      this.settleCancel(task);
    });
    this.changed(task);
  }

  private settleCancel(task: Task): void {
    const c = this.cancels.get(task.id);
    if (!c || !c.closed || !c.kill) return;
    this.cancels.delete(task.id);
    // The CLI is gone, but if the tree kill failed its children may still be running: do not call that cancelled.
    if (c.kill.error)
      this.finish(task, 'failed', 'Отмена не подтверждена: CLI завершился, но запущенные им процессы могли продолжить работу. Проверьте их в диспетчере задач.');
    else this.finish(task, 'cancelled', c.last);
  }

  private run(task: Task): void {
    let child: ChildProcess;
    try {
      child = task.executor === 'claude' ? this.spawnClaude(task) : this.spawnCodex(task);
    } catch (e) {
      return this.finish(task, 'failed', `Не удалось запустить: ${(e as Error).message}`);
    }
    this.procs.set(task.id, child);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout = (stdout + d).slice(-200_000);
      if (task.executor === 'codex') this.codexEvents(task, d);
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-8_000)));
    child.on('spawn', () => {
      task.status = 'running';
      this.changed(task);
    });
    child.on('error', (e) => this.finish(task, 'failed', `Не удалось запустить: ${e.message}`));
    child.on('close', (code) => {
      this.procs.delete(task.id);
      if (task.executor === 'codex') this.codexEvents(task, '\n'); // the last line may lack a newline
      const run = this.runs.get(task.id);
      const cancel = this.cancels.get(task.id);
      if (task.status === 'cancelling' && cancel) {
        cancel.closed = true;
        cancel.last = run?.last;
        return this.settleCancel(task);
      }
      if (code === 0 && !run?.error) {
        const answer = task.executor === 'claude' ? stdout.trim() : (run?.final ?? run?.last);
        this.finish(task, 'done', answer || 'Готово');
      } else if (run?.error) {
        this.finish(task, 'failed', run.error);
      } else if (/not logged in|please run \/login/i.test(stdout)) {
        this.cached = undefined;
        this.finish(task, 'failed', 'Claude Code не авторизован для фоновых задач: выполните вход (подсказка на доске задач)');
      } else this.finish(task, 'failed', (stdout.trim() ? stdout : stderr).trim().slice(-2_000) || `Код выхода ${code}`);
    });
    // A CLI that dies before reading its prompt closes stdin; that surfaces through 'close', not as a crash here.
    child.stdin?.on('error', () => {});
    child.stdin?.end(task.prompt);
  }

  private spawnClaude(task: Task): ChildProcess {
    // A known session id lets the office link the task to its worker right away.
    const session = randomUUID();
    task.agentId = session;
    const args = [
      '-p',
      '--model', task.model,
      // Headless runs cannot ask: read-only work plans, write work may edit files; anything else is denied.
      '--permission-mode', task.access === 'write' ? 'acceptEdits' : 'plan',
      '--session-id', session,
      '-n', `Доска: ${clip(task.prompt, 40)}`,
    ];
    if (task.effort) args.push('--effort', task.effort);
    return spawn(claudeBin()!, args, { cwd: task.cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  }

  private spawnCodex(task: Task): ChildProcess {
    const args = [
      'exec',
      '--json',
      '--sandbox', task.access === 'write' ? 'workspace-write' : 'read-only',
      // Nobody is there to approve: requests outside the sandbox are refused, not asked.
      '-c', 'approval_policy="never"',
      '-C', task.cwd,
      '-m', task.model,
      '--skip-git-repo-check',
    ];
    if (task.effort) args.push('-c', `model_reasoning_effort="${task.effort}"`);
    args.push('-');
    return spawn(codexBin()!, args, { cwd: task.cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /**
   * `codex exec --json` prints JSONL events: the thread id links the worker, agent
   * messages carry the answer. A message can be an intermediate one, so the answer is
   * the last message before turn.completed (or the last one seen at all).
   */
  private pending = new Map<string, string>();
  private runs = new Map<string, { last?: string; final?: string; error?: string }>();
  private codexEvents(task: Task, chunk: string): void {
    const text = (this.pending.get(task.id) ?? '') + chunk;
    const lines = text.split('\n');
    this.pending.set(task.id, lines.pop() ?? '');
    for (const line of lines) {
      let ev: Rec;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const thread = ev.thread_id ?? ev.session_id ?? ev.msg?.session_id;
      if (!task.agentId && typeof thread === 'string' && /^(thread|session)\.(started|configured)$|^session_configured$/.test(ev.type ?? ev.msg?.type ?? '')) {
        task.agentId = `codex:${thread}`;
        this.changed(task);
      }
      const run = this.runs.get(task.id) ?? {};
      this.runs.set(task.id, run);
      const item = ev.item ?? {};
      if (ev.type === 'item.completed' && (item.type === 'agent_message' || item.item_type === 'assistant_message') && typeof item.text === 'string') {
        run.last = item.text.trim();
      } else if (ev.type === 'turn.completed') {
        run.final = run.last;
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        const message = ev.error?.message ?? ev.message;
        run.error = typeof message === 'string' ? message : 'Codex завершил ход с ошибкой';
      }
    }
  }

  private finish(task: Task, status: Task['status'], result?: string): void {
    if (task.finishedAt) return;
    task.status = status;
    task.finishedAt = Date.now();
    task.result = result && result.length > 4_000 ? result.slice(0, 4_000) + '…' : result;
    this.pending.delete(task.id);
    this.runs.delete(task.id);
    this.changed(task);
  }

  private changed(task: Task): void {
    this.save();
    this.emit('task', { ...task });
  }

  private load(): void {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(saved)) return;
      this.tasks = saved.slice(0, KEEP_TASKS);
      for (const t of this.tasks) {
        if (t.status === 'starting' || t.status === 'running' || t.status === 'cancelling') {
          t.status = 'failed';
          t.finishedAt = Date.now();
          t.result = 'Демон был перезапущен во время работы';
        }
      }
    } catch {
      // no board yet
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.tasks, null, 2));
    } catch (e) {
      console.log(`[board] не удалось сохранить задачи: ${(e as Error).message}`);
    }
  }

  /** Project folders the user worked in recently, from live agents, past tasks and both agents' history. */
  private projects(): string[] {
    const seen = new Map<string, number>();
    const add = (cwd: unknown, at: number) => {
      if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) return;
      const key = resolve(cwd);
      if ((seen.get(key) ?? 0) < at) seen.set(key, at);
    };
    const snap = this.store.snapshot();
    if (snap.type === 'snapshot') for (const a of snap.agents) add(a.cwd, a.updatedAt);
    for (const t of this.tasks) add(t.cwd, t.createdAt);
    for (const [cwd, at] of claudeProjects()) add(cwd, at);
    for (const [cwd, at] of codexProjects()) add(cwd, at);
    return [...seen]
      .filter(([cwd]) => isDir(cwd) && !/[\\/](scratch|Temp|tmp)[\\/]/i.test(cwd))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([cwd]) => cwd);
  }
}

/** Stop a process and everything it started. `onResult` is called once: no argument on success, the reason otherwise. */
function killTree(p: ChildProcess, sync = false, onResult?: (error?: string) => void): void {
  if (!p.pid) return onResult?.();
  if (process.platform === 'win32') {
    const args = ['/pid', String(p.pid), '/T', '/F'];
    if (sync) {
      if (spawnSync('taskkill', args, { windowsHide: true }).status !== 0) p.kill();
      return;
    }
    // No fallback to killing just the CLI: that would orphan its children and look like a clean cancel.
    let output = '';
    const tk = spawn('taskkill', args, { windowsHide: true });
    tk.stdout?.on('data', (d) => (output += d));
    tk.stderr?.on('data', (d) => (output += d));
    tk.on('error', (e) => onResult?.(e.message));
    tk.on('exit', (code) => {
      // Only exit code 0 confirms the tree is gone. A dead CLI proves nothing about its
      // children: once it has exited, taskkill /T can no longer find them by parent.
      if (code === 0) onResult?.();
      else onResult?.(output.trim() || `taskkill завершился с кодом ${code}`);
    });
  } else {
    try {
      process.kill(-p.pid, 'SIGTERM'); // detached: the child leads its own process group
      onResult?.();
    } catch (e) {
      if (sync) p.kill();
      else onResult?.((e as Error).message);
    }
  }
}

function inGit(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

let claudeCache: string | null | undefined;
/** Claude Code bundled with Claude Desktop, else a standalone install. */
function claudeBin(): string | undefined {
  if (claudeCache !== undefined) return claudeCache ?? undefined;
  const candidates: string[] = [];
  if (process.env.LAND_CLAUDE_BIN) candidates.push(process.env.LAND_CLAUDE_BIN);
  const data = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Claude-Data');
  for (const profile of safeDir(data)) {
    const root = join(data, profile, 'claude-code');
    const versions = safeDir(root).sort(compareVersions).reverse();
    for (const v of versions) for (const build of safeDir(join(root, v))) candidates.push(join(root, v, build, 'claude.exe'));
  }
  candidates.push(join(homedir(), '.claude', 'local', 'claude'), join(homedir(), '.local', 'bin', 'claude'));
  claudeCache = candidates.find((c) => existsSync(c)) ?? onPath('claude') ?? null;
  return claudeCache ?? undefined;
}

let codexCache: string | null | undefined;
/** The Codex CLI shipped inside the Codex Desktop Store package, else one on PATH. */
function codexBin(): string | undefined {
  if (codexCache !== undefined) return codexCache ?? undefined;
  let found = process.env.LAND_CODEX_BIN && existsSync(process.env.LAND_CODEX_BIN) ? process.env.LAND_CODEX_BIN : undefined;
  if (!found && process.platform === 'win32') {
    try {
      const loc = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-AppxPackage -Name 'OpenAI.Codex*' | Select-Object -First 1).InstallLocation"], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
      const exe = loc && join(loc, 'app', 'resources', 'codex.exe');
      if (exe && existsSync(exe)) found = exe;
    } catch {
      // no Store package
    }
  }
  codexCache = found ?? onPath('codex') ?? null;
  return codexCache ?? undefined;
}

function claudeSignedIn(bin: string): boolean {
  try {
    const out = execFileSync(bin, ['auth', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return JSON.parse(out).loggedIn === true;
  } catch {
    return false;
  }
}

function onPath(name: string): string | undefined {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    return out.split(/\r?\n/).find((l) => l.trim())?.trim();
  } catch {
    return undefined;
  }
}

/** Models listed in Codex's local model cache; a cache, not a guarantee of access. */
function codexModels(): ModelOption[] {
  try {
    const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const cache = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'));
    return (cache.models as Rec[])
      .filter((m) => m.visibility !== 'hide' && typeof m.slug === 'string')
      .map((m) => ({
        id: m.slug,
        label: m.display_name ?? m.slug,
        efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((r: Rec) => r.effort ?? r).filter((e: unknown) => typeof e === 'string') : undefined,
        defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined,
      }));
  } catch {
    return [];
  }
}

/** cwd of the newest transcript in every Claude project folder. */
function claudeProjects(): [string, number][] {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const out: [string, number][] = [];
  for (const dir of safeDir(root)) {
    const files = safeDir(join(root, dir))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: join(root, dir, f), at: mtime(join(root, dir, f)) }))
      .sort((a, b) => b.at - a.at);
    const newest = files[0];
    if (!newest) continue;
    const cwd = head(newest.f).match(/"cwd":"((?:\\.|[^"\\])*)"/);
    if (cwd) out.push([JSON.parse(`"${cwd[1]}"`), newest.at]);
  }
  return out;
}

/** Working folders of Codex threads, from the newest rollouts. */
function codexProjects(): [string, number][] {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  let files: string[];
  try {
    files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => /rollout-.*\.jsonl$/.test(f));
  } catch {
    return [];
  }
  return files
    .map((f) => ({ f: join(root, f), at: mtime(join(root, f)) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 60)
    .flatMap(({ f, at }): [string, number][] => {
      const cwd = head(f).match(/"cwd":"((?:\\.|[^"\\])*)"/);
      return cwd ? [[JSON.parse(`"${cwd[1]}"`), at]] : [];
    });
}

function head(path: string, bytes = 64 * 1024): string {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
