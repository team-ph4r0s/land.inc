import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelOption, Task } from '@land/protocol';
import { headCwd, mtime, onPath } from './files.ts';
import type { Command, Executor, ExecutorStatus, OutputParser, PreparedRun } from './types.ts';

type Rec = Record<string, any>;

export interface CodexOptions {
  /** Override the CLI, e.g. a fake one in tests. */
  command?: Command;
  /** Override the model list (tests); the default reads Codex's local model cache. */
  models?: ModelOption[];
}

/** Codex non-interactively (`codex exec --json`), the CLI from the Codex Desktop package or one on PATH. */
export class CodexExecutor implements Executor {
  readonly id = 'codex' as const;
  private override?: Command;
  private models?: ModelOption[];
  private found?: Command | null;

  constructor(options: CodexOptions = {}) {
    this.override = options.command;
    this.models = options.models;
  }

  command(): Command | undefined {
    if (this.override) return this.override;
    if (this.found === undefined) {
      const bin = codexBin();
      this.found = bin ? { command: bin, args: [] } : null;
    }
    return this.found ?? undefined;
  }

  status(): ExecutorStatus {
    const models = this.models ?? codexModels();
    if (!this.command()) return { available: false, models, note: 'codex.exe не найден (Codex Desktop или Codex CLI)' };
    return { available: true, models };
  }

  prepare(task: Task, onAgent: (agentId: string) => void): PreparedRun {
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
    return { args, output: jsonEvents(onAgent) };
  }

  projects(): [string, number][] {
    // Working folders of Codex threads, from the newest rollouts.
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
        const cwd = headCwd(f);
        return cwd ? [[cwd, at]] : [];
      });
  }
}

/**
 * `codex exec --json` prints JSONL events: the thread id links the worker, agent
 * messages carry the answer. A message can be an intermediate one, so the answer is
 * the last message before turn.completed (or the last one seen at all).
 */
function jsonEvents(onAgent: (agentId: string) => void): OutputParser {
  let pending = '';
  let agent: string | undefined;
  let last: string | undefined;
  let final: string | undefined;
  let error: string | undefined;

  const line = (text: string) => {
    let ev: Rec;
    try {
      ev = JSON.parse(text);
    } catch {
      return;
    }
    const thread = ev.thread_id ?? ev.session_id ?? ev.msg?.session_id;
    if (!agent && typeof thread === 'string' && /^(thread|session)\.(started|configured)$|^session_configured$/.test(ev.type ?? ev.msg?.type ?? '')) {
      agent = `codex:${thread}`;
      onAgent(agent);
    }
    const item = ev.item ?? {};
    if (ev.type === 'item.completed' && (item.type === 'agent_message' || item.item_type === 'assistant_message') && typeof item.text === 'string') {
      last = item.text.trim();
    } else if (ev.type === 'turn.completed') {
      final = last;
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      const message = ev.error?.message ?? ev.message;
      error = typeof message === 'string' ? message : 'Codex завершил ход с ошибкой';
    }
  };
  const feed = (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    lines.forEach(line);
  };

  return {
    onStdout: feed,
    last: () => last,
    finish(code, stdout, stderr) {
      feed('\n'); // the last line may lack a newline
      if (code === 0 && !error) return { ok: true, text: final ?? last };
      if (error) return { ok: false, text: error };
      // stdout is the JSON event stream; the reason for a crash is on stderr.
      return { ok: false, text: (stderr.trim() || last || stdout.trim()).slice(-2_000) || `Код выхода ${code}` };
    },
  };
}

function codexBin(): string | undefined {
  if (process.env.LAND_CODEX_BIN && existsSync(process.env.LAND_CODEX_BIN)) return process.env.LAND_CODEX_BIN;
  if (process.platform === 'win32') {
    try {
      const loc = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-AppxPackage -Name 'OpenAI.Codex*' | Select-Object -First 1).InstallLocation"], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
      const exe = loc && join(loc, 'app', 'resources', 'codex.exe');
      if (exe && existsSync(exe)) return exe;
    } catch {
      // no Store package
    }
  }
  return onPath('codex');
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
