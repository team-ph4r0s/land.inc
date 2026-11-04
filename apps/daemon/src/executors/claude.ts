import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelOption, Task } from '@land/protocol';
import { clip } from '../activity.ts';
import { cliCommand, cliOnPath, compareVersions, headCwd, mtime, safeDir } from './files.ts';
import type { Command, Executor, ExecutorStatus, OutputParser, PreparedRun } from './types.ts';

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
].map((m) => ({ ...m, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }));

export interface ClaudeOptions {
  /** Override the CLI, e.g. a fake one in tests. */
  command?: Command;
}

/** Claude Code in print mode (`claude -p`), the CLI bundled with Claude Desktop or a standalone one. */
export class ClaudeExecutor implements Executor {
  readonly id = 'claude' as const;
  private override?: Command;
  private found?: Command | null;

  constructor(options: ClaudeOptions = {}) {
    this.override = options.command;
  }

  refresh(): void { this.found = undefined; }

  command(): Command | undefined {
    if (this.override) return this.override;
    if (this.found === undefined) {
      this.found = claudeBin() ?? null;
    }
    return this.found ?? undefined;
  }

  status(): ExecutorStatus {
    const cmd = this.command();
    if (!cmd) return { available: false, models: CLAUDE_MODELS, note: 'claude.exe не найден (Claude Desktop или Claude Code)' };
    // The CLI bundled with Claude Desktop is signed in only inside Desktop's own sessions.
    if (!signedIn(cmd)) {
      const shown = [cmd.command, ...cmd.args].map((p) => `"${p}"`).join(' ');
      return { available: false, models: CLAUDE_MODELS, note: `Claude Code не авторизован для фоновых задач. Один раз выполните в терминале: & ${shown} auth login` };
    }
    return { available: true, models: CLAUDE_MODELS };
  }

  prepare(task: Task, _onAgent: (agentId: string) => void, resume?: string): PreparedRun {
    // A known session id lets the office link the task to its worker right away. Resuming keeps
    // the same id (Claude makes a new one only with --fork-session), so the same worker continues.
    const session = resume ?? randomUUID();
    const args = [
      '-p',
      '--model', task.model,
      // Headless runs cannot ask: read-only work plans, write work may edit files; anything else is denied.
      '--permission-mode', task.access === 'write' ? 'acceptEdits' : 'plan',
      ...(resume ? ['--resume', resume] : ['--session-id', session, '-n', `Доска: ${clip(task.prompt, 40)}`]),
    ];
    if (task.effort) args.push('--effort', task.effort);
    return { args, agentId: session, output: printOutput() };
  }

  sessionOf(agentId: string): string | undefined {
    // Claude's office agents are its session ids (subagents carry "session:agent" and cannot be resumed).
    return /^[0-9a-f-]{36}$/i.test(agentId) ? agentId : undefined;
  }

  projects(): [string, number][] {
    // cwd of the newest transcript in every Claude project folder.
    const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
    const out: [string, number][] = [];
    for (const dir of safeDir(root)) {
      const newest = safeDir(join(root, dir))
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f: join(root, dir, f), at: mtime(join(root, dir, f)) }))
        .sort((a, b) => b.at - a.at)[0];
      const cwd = newest && headCwd(newest.f);
      if (cwd) out.push([cwd, newest.at]);
    }
    return out;
  }
}

/** `claude -p` prints the final answer to stdout. */
function printOutput(): OutputParser {
  return {
    onStdout() {},
    last: () => undefined,
    finish(code, stdout, stderr) {
      if (code === 0) return { ok: true, text: stdout.trim() };
      if (/not logged in|please run \/login/i.test(stdout))
        return { ok: false, signedOut: true, text: 'Claude Code не авторизован для фоновых задач: выполните вход (подсказка на доске задач)' };
      return { ok: false, text: (stdout.trim() ? stdout : stderr).trim().slice(-2_000) || `Код выхода ${code}` };
    },
  };
}

function signedIn(cmd: Command): boolean {
  try {
    const out = execFileSync(cmd.command, [...cmd.args, 'auth', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return JSON.parse(out).loggedIn === true;
  } catch {
    return false;
  }
}

function claudeBin(): Command | undefined {
  const candidates: string[] = [];
  if (process.env.LAND_CLAUDE_BIN) candidates.push(process.env.LAND_CLAUDE_BIN);
  const data = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Claude-Data');
  for (const profile of safeDir(data)) {
    const root = join(data, profile, 'claude-code');
    const versions = safeDir(root).sort(compareVersions).reverse();
    for (const v of versions) for (const build of safeDir(join(root, v))) candidates.push(join(root, v, build, 'claude.exe'));
  }
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  candidates.push(join(homedir(), '.claude', 'local', name), join(homedir(), '.local', 'bin', name));
  for (const bin of candidates) {
    const cmd = cliCommand(bin, 'claude', '@anthropic-ai/claude-code');
    if (cmd) return cmd;
  }
  return cliOnPath('claude', '@anthropic-ai/claude-code');
}
