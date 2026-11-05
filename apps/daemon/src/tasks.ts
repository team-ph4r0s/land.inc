import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Access, BoardConfig, Executor as ExecutorId, NewTask, Task } from '@land/protocol';
import type { Store } from './store.ts';
import type { Executor, OutputParser } from './executors/types.ts';
import { ClaudeExecutor } from './executors/claude.ts';
import { CodexExecutor } from './executors/codex.ts';
import { AntigravityExecutor } from './executors/antigravity.ts';
import { sanitizeWorkspacePath } from './security/shield.ts';
import { HangDetector } from './supervisor.ts';
import { McpManager } from './executors/mcp-manager.ts';
import { redactSecrets } from './security/shield.ts';
import { preIteration, postIteration } from './pipeline/hooks.ts';

const MAX_RUNNING = 4;
const MAX_PROMPT = 100_000;
const KEEP_TASKS = 100;
const CONFIG_TTL_MS = 60_000;
const EXECUTORS: ExecutorId[] = ['claude', 'codex', 'antigravity'];

export interface BoardOptions {
  /** The agents tasks can go to; tests pass executors that start fake CLIs. */
  executors?: Executor[];
  /** Where the task history lives; null keeps it in memory only. */
  file?: string | null;
}

/**
 * The task board: the user writes a task, picks a project folder, an executor and
 * a model, and the daemon starts that agent's own CLI in the folder. The CLI writes
 * its transcript as usual, so the new worker walks into the office by itself.
 */
export interface StreamChunk { taskId: string; chunk: string; sequence: number; }

export class TaskBoard extends EventEmitter<{ task: [Task]; stream: [StreamChunk] }> {
  private tasks: Task[] = [];
  private procs = new Map<string, ChildProcess>();
  private outputs = new Map<string, OutputParser>();
  private executors: Map<ExecutorId, Executor>;
  private file: string | null;
  private cached?: { at: number; config: BoardConfig };
  /**
   * A cancel settles only once both are known: the CLI closed, and how the tree kill
   * went. Either can come first (taskkill /T closes the CLI before it exits itself).
   */
  private cancels = new Map<string, { closed: boolean; last?: string; kill?: { error?: string } }>();
  /** Untrimmed answers of recent tasks: a team looks for the colleague section, which is usually at the end. */
  private full = new Map<string, string>();
  /** Tasks that continue an agent session: task id → the CLI's session id. */
  private resumes = new Map<string, string>();
  /** Swappable in tests. */
  private killTree = killTree;
  private store: Store;
  private readonly hangs = new HangDetector();
  private readonly mcp = new McpManager();
  private readonly streamBuffers = new Map<string, string>();
  private readonly streamTimers = new Map<string, NodeJS.Timeout>();
  private readonly streamSequences = new Map<string, number>();

  constructor(store: Store, options: BoardOptions = {}) {
    super();
    this.store = store;
    const executors = options.executors ?? [new ClaudeExecutor(), new CodexExecutor(), new AntigravityExecutor()];
    this.executors = new Map(executors.map((e) => [e.id, e]));
    this.file = options.file === undefined ? join(homedir(), '.land', 'tasks.json') : options.file;
    this.load();
    // Tag the worker in the office with its newest task: a reply resumes the same agent,
    // whose tag must move on from the task it answered.
    store.on('message', (m) => {
      if (m.type !== 'upsert') return;
      const task = this.tasks.find((t) => t.agentId === m.agent.id);
      if (task && m.agent.taskId !== task.id) store.update(m.agent.id, { source: m.agent.source, taskId: task.id });
    });
    process.on('exit', () => {
      for (const p of this.procs.values()) killTree(p, true);
    });
    setInterval(() => {
      for (const record of this.hangs.check()) {
        const task = this.tasks.find((item) => item.id === record.taskId);
        if (task && (task.status === 'starting' || task.status === 'running')) this.annotate(task.id, `Процесс не отвечает более ${Math.round((Date.now() - record.lastActivity) / 1000)} с. Можно мягко перезапустить этот этап или остановить дерево процессов.`);
      }
    }, 5_000).unref();
  }

  list(): Task[] {
    return this.tasks;
  }

  fullResult(id: string): string | undefined {
    return this.full.get(id);
  }

  get(id: string): Task | undefined {
    const task = this.tasks.find((item) => item.id === id);
    return task ? structuredClone(task) : undefined;
  }

  /** Add a note to a task's result, e.g. why the team it belonged to stopped. */
  annotate(id: string, note: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.result = task.result ? `${task.result}\n\n${note}` : note;
    this.changed(task);
  }

  config(refresh = false): BoardConfig {
    if (refresh) {
      this.cached = undefined;
      for (const executor of this.executors.values()) executor.refresh?.();
    }
    if (this.cached && Date.now() - this.cached.at < CONFIG_TTL_MS) return this.cached.config;
    const projects = this.projects();
    const executors = Object.fromEntries(
      EXECUTORS.map((id) => [id, this.executors.get(id)?.status() ?? { available: false, models: [], note: 'Исполнитель не подключён' }]),
    ) as BoardConfig['executors'];
    const config: BoardConfig = { projects, outsideGit: projects.filter((p) => !inGit(p)), executors };
    this.cached = { at: Date.now(), config };
    return config;
  }

  /**
   * Reply to the agent of a finished task: a new task that continues the same session, so
   * the agent keeps what it learned. The folder and the agent stay; access, model and effort
   * are chosen again and checked like every task. The session id never comes from the client.
   */
  reply(taskId: string, input: { prompt: string; access: Access; model?: string; effort?: string }): Task {
    const previous = this.tasks.find((t) => t.id === taskId);
    if (!previous) throw new Error('Задача не найдена');
    if (previous.status === 'starting' || previous.status === 'running' || previous.status === 'cancelling')
      throw new Error('Агент ещё работает над этой задачей — дождитесь ответа');
    const session = previous.agentId && this.executors.get(previous.executor)?.sessionOf?.(previous.agentId);
    if (!session) throw new Error('Сессия этого агента неизвестна: продолжить разговор нельзя');
    // After an unconfirmed cancel, what that run started may still be working in this session.
    if (this.tasks.some((t) => t.agentId === previous.agentId && t.orphans))
      throw new Error('Прошлый ход этого агента не удалось остановить наверняка: его процессы могли продолжить работу. Продолжать эту сессию небезопасно — начните новую задачу.');
    // One conversation at a time per session: two replies at once would interleave in one transcript.
    if (this.tasks.some((t) => t.agentId === previous.agentId && (t.status === 'starting' || t.status === 'running' || t.status === 'cancelling')))
      throw new Error('Этот агент уже отвечает на другое сообщение');
    return this.create(
      // Model and effort stay as they were unless the reply picks others.
      { prompt: input.prompt, cwd: previous.cwd, executor: previous.executor, model: input.model || previous.model, effort: input.effort || (input.model ? undefined : previous.effort), access: input.access, conversationId: previous.conversationId, systemPrompt: previous.systemPrompt, mcpConfigPath: previous.mcpConfigPath },
      { resume: session, continues: previous.id, agentId: previous.agentId },
    );
  }

  /** Validate and start a task. Throws an Error with a message for the user. */
  create(input: NewTask, from?: { resume: string; continues: string; agentId?: string }): Task {
    const prompt = typeof input.prompt === 'string' ? preIteration(input.prompt.trim()).prompt : '';
    if (!prompt) throw new Error('Опишите задачу');
    if (prompt.length > MAX_PROMPT) throw new Error(`Задача длиннее ${MAX_PROMPT} символов`);
    // Check before resolve(): an empty or relative path would quietly become the daemon's own folder.
    const raw = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    if (!raw || !isAbsolute(raw)) throw new Error('Укажите полный путь к папке проекта');
    const cwd = sanitizeWorkspacePath(resolve(raw), resolve(raw));
    if (!isDir(cwd)) throw new Error('Папка проекта не найдена');
    if (!EXECUTORS.includes(input.executor)) throw new Error('Неизвестный исполнитель');
    if (input.access !== 'read' && input.access !== 'write') throw new Error('Неизвестный режим доступа');
    const executor = this.config().executors[input.executor];
    if (!executor.available) throw new Error(executor.note ?? 'Исполнитель недоступен');
    // Only listed models and efforts reach the command line.
    const model = executor.models.find((m) => m.id === input.model);
    if (!model) throw new Error('Модель недоступна');
    if (input.effort && !model.efforts?.includes(input.effort)) throw new Error('Такой уровень рассуждений модель не поддерживает');
    // A task being cancelled still holds its slot until its processes are gone.
    const live = this.tasks.filter((t) => t.status === 'starting' || t.status === 'running' || t.status === 'cancelling');
    if (live.length >= MAX_RUNNING) throw new Error(`Одновременно выполняется не больше ${MAX_RUNNING} задач`);
    // One writer per folder: two agents editing the same files would trample each other's work.
    if (input.access === 'write' && live.some((t) => t.access === 'write' && overlaps(t.cwd, cwd)))
      throw new Error('В этой папке уже работает задача с правом записи. Дождитесь её завершения или выберите «Только чтение».');

    const conversationId = input.conversationId ?? randomUUID();
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
      conversationId,
      mcpConfigPath: input.mcpConfigPath ?? this.mcp.writeSessionConfig(conversationId),
      systemPrompt: input.systemPrompt,
      ...(from ? { continues: from.continues, agentId: from.agentId } : {}),
    };
    if (from) this.resumes.set(task.id, from.resume);
    this.tasks.unshift(task);
    this.tasks = this.tasks.slice(0, KEEP_TASKS);
    // The resumed agent may already be in the office: move its tag to this task now
    // (after the task is listed, so the tag listener agrees it is the newest one).
    const office = from?.agentId ? this.store.snapshot() : undefined;
    if (office?.type === 'snapshot') {
      const present = office.agents.find((a) => a.id === from!.agentId);
      if (present) this.store.update(present.id, { source: present.source, taskId: task.id });
    }
    if (!this.config().projects.includes(cwd)) this.cached = undefined;
    this.run(task);
    return task;
  }

  cancel(id: string): void {
    const p = this.procs.get(id);
    const task = this.tasks.find((t) => t.id === id);
    if (!task || !p) return;
    // Cancelling again retries a kill that failed; while an attempt is still running, more clicks do nothing.
    const previous = this.cancels.get(id);
    if (previous && !previous.kill) return;
    task.status = 'cancelling';
    // The old failure is not true of the new attempt; keeping it would show the retry as failed already.
    if (previous?.kill?.error) task.result = undefined;
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
    if (c.kill.error) {
      task.orphans = true;
      this.finish(task, 'failed', 'Отмена не подтверждена: CLI завершился, но запущенные им процессы могли продолжить работу. Проверьте их в диспетчере задач.');
    } else this.finish(task, 'cancelled', c.last);
  }

  private run(task: Task): void {
    const executor = this.executors.get(task.executor)!;
    let child: ChildProcess;
    let output: OutputParser;
    let stdin: string | undefined;
    let command: string | undefined;
    try {
      const cmd = executor.command();
      if (!cmd) throw new Error('CLI не найден');
      command = [cmd.command, ...cmd.args].join(' ');
      const prepared = executor.prepare(
        task,
        (agentId) => {
          if (task.agentId === agentId) return;
          task.agentId = agentId;
          this.changed(task);
        },
        this.resumes.get(task.id),
      );
      if (prepared.agentId) task.agentId = prepared.agentId;
      output = prepared.output;
      stdin = prepared.stdin;
      child = spawn(cmd.command, [...cmd.args, ...prepared.args], {
        cwd: task.cwd,
        windowsHide: true,
        detached: process.platform !== 'win32', // its own process group, so a cancel can stop the whole tree
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return this.finish(task, 'failed', launchError(e as NodeJS.ErrnoException, command));
    }
    this.procs.set(task.id, child);
    this.hangs.start(task.id, child);
    this.outputs.set(task.id, output);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      this.hangs.touch(task.id);
      stdout = (stdout + d).slice(-200_000);
      this.queueStream(task.id, d);
      output.onStdout(d);
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => { this.hangs.touch(task.id); stderr = (stderr + d).slice(-8_000); this.queueStream(task.id, d); });
    child.on('spawn', () => {
      task.status = 'running';
      this.changed(task);
    });
    child.on('error', (e) => this.finish(task, 'failed', launchError(e, command)));
    child.on('close', (code) => {
      this.procs.delete(task.id);
      this.hangs.stop(task.id);
      this.flushStream(task.id);
      const result = output.finish(code, stdout, stderr);
      const cancel = this.cancels.get(task.id);
      if (task.status === 'cancelling' && cancel) {
        cancel.closed = true;
        cancel.last = output.last();
        return this.settleCancel(task);
      }
      if (result.signedOut) this.cached = undefined;
      if (result.ok) this.finish(task, 'done', result.text || 'Готово');
      else this.finish(task, 'failed', result.text);
    });
    // A CLI that dies before reading its prompt closes stdin; that surfaces through 'close', not as a crash here.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin ?? task.prompt);
  }

  private finish(task: Task, status: Task['status'], result?: string): void {
    if (task.finishedAt) return;
    task.status = status;
    task.finishedAt = Date.now();
    // Keep the answer in the persisted task too: the UI and a restarted daemon
    // must see the same text as the session continuation (bounded CLI capture).
    const safeResult = result ? postIteration(result).text : result;
    task.result = safeResult;
    if (safeResult) {
      this.full.set(task.id, safeResult.slice(-200_000));
      if (this.full.size > 20) this.full.delete(this.full.keys().next().value!);
    }
    this.outputs.delete(task.id);
    this.resumes.delete(task.id);
    this.changed(task);
  }

  private queueStream(taskId: string, chunk: string): void {
    const current = `${this.streamBuffers.get(taskId) ?? ''}${redactSecrets(chunk)}`.slice(-64_000);
    this.streamBuffers.set(taskId, current);
    if (this.streamTimers.has(taskId)) return;
    this.streamTimers.set(taskId, setTimeout(() => this.flushStream(taskId), 60));
  }

  private flushStream(taskId: string): void {
    const timer = this.streamTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.streamTimers.delete(taskId);
    const chunk = this.streamBuffers.get(taskId);
    if (!chunk) return;
    this.streamBuffers.delete(taskId);
    const sequence = (this.streamSequences.get(taskId) ?? 0) + 1;
    this.streamSequences.set(taskId, sequence);
    this.emit('stream', { taskId, chunk, sequence });
  }

  private changed(task: Task): void {
    this.save();
    this.emit('task', { ...task });
  }

  private load(): void {
    if (!this.file) return;
    try {
      const saved = JSON.parse(readRecoverable(this.file) ?? 'null');
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
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeAtomic(this.file, JSON.stringify(this.tasks, null, 2));
    } catch (e) {
      console.log(`[board] не удалось сохранить задачи: ${(e as Error).message}`);
    }
  }

  /** Project folders the user worked in recently, from live agents, past tasks and each agent's history. */
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
    for (const executor of this.executors.values()) for (const [cwd, at] of executor.projects?.() ?? []) add(cwd, at);
    return [...seen]
      .filter(([cwd]) => isDir(cwd) && !/[\\/](scratch|Temp|tmp)[\\/]/i.test(cwd))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([cwd]) => cwd);
  }
}

function launchError(error: NodeJS.ErrnoException, command?: string): string {
  let message = `Не удалось запустить${command ? ` CLI «${command}»` : ''}: ${error.message}`;
  if (error.code === 'EPERM' || error.code === 'EACCES')
    message += '. ОС запретила запуск. Проверьте, что CLI запускается из обычного терминала; если да — проверьте журнал блокировок Windows или антивируса.';
  return message;
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

/**
 * Save a file so that at every moment a complete copy exists on disk: first the whole
 * text goes to `<file>.tmp`, then it is renamed over the file. Windows may refuse to
 * replace a file (EPERM/EBUSY while an indexer or antivirus holds it, or in some
 * sandboxes): after a few retries the file is written directly, and `.tmp` stays as
 * the intact copy until that write has finished. readRecoverable() falls back to it.
 */
export function writeAtomic(path: string, data: string, ops: { rename: (from: string, to: string) => void } = { rename: renameSync }): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      ops.rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw e;
      if (attempt < 3) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
        continue;
      }
      writeFileSync(path, data);
      rmSync(tmp, { force: true });
      return;
    }
  }
}

/**
 * The latest saved text of a file written by writeAtomic. A whole `.tmp` exists only when
 * a save did not finish, and it is then newer than the file, so it wins; a broken `.tmp`
 * (cut off while being written) gives way to the previous, intact file.
 */
export function readRecoverable(path: string, valid: (text: string) => boolean = isJson): string | undefined {
  for (const candidate of [`${path}.tmp`, path]) {
    try {
      const text = readFileSync(candidate, 'utf8');
      if (valid(text)) return text;
    } catch {
      // try the next copy
    }
  }
  return undefined;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Two folders overlap when one is the other or lies inside it, after following links
 * (junctions, symlinks) and ignoring case on Windows: writers there can touch the same files.
 */
export function overlaps(a: string, b: string): boolean {
  const canon = (p: string) => {
    let real: string;
    try {
      real = realpathSync.native(p);
    } catch {
      real = resolve(p);
    }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  const inside = (outer: string, inner: string) => {
    const rel = relative(outer, inner);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const x = canon(a);
  const y = canon(b);
  return inside(x, y) || inside(y, x);
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
