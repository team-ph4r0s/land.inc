import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelOption, Task } from '@land/protocol';
import { findCli, headCwd, mtime, safeDir } from './files.ts';
import { codexModels } from '../model-catalog.ts';
import { cliFailure, stripAnsi } from '../ansi.ts';
import type { Command, Executor, ExecutorStatus, OutputParser, PreparedRun } from './types.ts';

import { record } from '../json-store.ts';

/** Codex Desktop keeps its CLI in %LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe, newest build first. */
export function codexDesktopBins(): string[] {
  if (process.platform !== 'win32') return [];
  const root = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  return safeDir(root).map((build) => join(root, build, 'codex.exe'))
    .map((file) => ({ file, at: mtime(file) })).filter((c) => c.at > 0).sort((a, b) => b.at - a.at).map((c) => c.file);
}

export interface CodexOptions {
  /** Override the CLI, e.g. a fake one in tests. */
  command?: Command;
  pathOverride?: () => string | undefined;
  /** Override the model list (tests); the default reads Codex's local model cache. */
  models?: ModelOption[];
}

/** Codex non-interactively (`codex exec --json`), the CLI from the Codex Desktop package or one on PATH. */
export class CodexExecutor implements Executor {
  readonly id = 'codex' as const;
  private override?: Command;
  private models?: ModelOption[];
  private found?: Command | null;
  private pathOverride?: () => string | undefined;

  constructor(options: CodexOptions = {}) {
    this.override = options.command;
    this.pathOverride = options.pathOverride;
    this.models = options.models;
  }

  refresh(): void { this.found = undefined; }

  command(): Command | undefined {
    if (this.override) return this.override;
    if (this.found === undefined) {
      const path = this.pathOverride?.();
      const candidates = path ? [path] : [process.env.LAND_CODEX_BIN, ...codexDesktopBins()].filter((value): value is string => !!value);
      this.found = findCli('codex', '@openai/codex', candidates) ?? null;
    }
    return this.found ?? undefined;
  }

  status(catalogModels?: ModelOption[]): ExecutorStatus {
    const models = catalogModels ?? this.models ?? codexModels();
    if (!this.command()) return { available: false, models, note: 'codex.exe не найден (Codex Desktop или Codex CLI)' };
    return { available: true, models };
  }

  prepare(task: Task, onAgent: (agentId: string) => void, resume?: string, captureLimit = 200_000): PreparedRun {
    const sandbox = task.access === 'write' ? 'workspace-write' : 'read-only';
    // `exec resume` has no --sandbox or -C: the sandbox goes through config, the folder is the process cwd.
    const args = resume
      ? ['exec', 'resume', resume, '--json', '-c', `sandbox_mode="${sandbox}"`]
      : ['exec', '--json', '--sandbox', sandbox, '-C', task.cwd];
    // Nobody is there to approve: requests outside the sandbox are refused, not asked.
    args.push('-c', 'approval_policy="never"', '-m', task.model, '--skip-git-repo-check');
    if (task.effort) args.push('-c', `model_reasoning_effort="${task.effort}"`);
    args.push('-');
    return { args, agentId: resume ? `codex:${resume}` : undefined, output: jsonEvents(onAgent, captureLimit) };
  }

  sessionOf(agentId: string): string | undefined {
    // Office ids are "codex:<thread uuid>"; the thread id is what `exec resume` takes.
    return agentId.match(/^codex:([0-9a-f-]{36})$/i)?.[1];
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
function jsonEvents(onAgent: (agentId: string) => void, captureLimit: number): OutputParser {
  let pending = '';
  let agent: string | undefined;
  let last: string | undefined;
  let final: string | undefined;
  let error: string | undefined;

  const line = (text: string) => {
    let ev: Record<string, unknown> | undefined;
    try {
      ev = record(JSON.parse(stripAnsi(text)));
    } catch {
      return;
    }
    if (!ev) return;
    const msg = record(ev.msg);
    const thread = ev.thread_id ?? ev.session_id ?? msg?.session_id;
    if (!agent && typeof thread === 'string' && /^(thread|session)\.(started|configured)$|^session_configured$/.test(String(ev.type ?? msg?.type ?? ''))) {
      agent = `codex:${thread}`;
      onAgent(agent);
    }
    const item = record(ev.item);
    if ((ev.type === 'item.completed' || ev.type === 'item.updated') && (item?.type === 'agent_message' || item?.item_type === 'assistant_message') && typeof item.text === 'string') {
      last = stripAnsi(item.text).trim().slice(-captureLimit);
    } else if (ev.type === 'turn.completed') {
      final = last;
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      const message = record(ev.error)?.message ?? ev.message;
      error = typeof message === 'string' ? message : 'Codex завершил ход с ошибкой';
    }
  };
  const feed = (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = (lines.pop() ?? '').slice(-Math.max(8_000_000, captureLimit * 6));
    lines.forEach(line);
  };

  return {
    onStdout: feed,
    last: () => last,
    finish(code, stdout, stderr) {
      feed('\n'); // the last line may lack a newline
      if (code === 0 && !error) return { ok: true, text: final ?? last };
      const recognized = cliFailure('codex', error, stderr, stdout);
      if (recognized) return recognized;
      if (error) return { ok: false, text: stripAnsi(error) };
      // stdout is the JSON event stream; the reason for a crash is on stderr.
      return { ok: false, text: (stripAnsi(stderr).trim() || last || stripAnsi(stdout).trim()).slice(-2_000) || `Код выхода ${code}` };
    },
  };
}
