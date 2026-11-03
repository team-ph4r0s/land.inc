import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Store } from '../store.ts';
import { JsonlTail } from '../tail.ts';
import { clip, commandOutcome, describeTool, testOutcome } from '../activity.ts';

const RECENT_MS = 45 * 60_000;
const POLL_MS = 1_500;
const DISCOVER_MS = 5_000;

interface Tracked {
  tail: JsonlTail;
  id: string;
  title?: string;
  titled: boolean;
  metadata?: Parameters<Store['update']>[1];
  /** Nothing has been read from the file yet. */
  fresh: boolean;
  /** Imported history, hidden until the thread gets new activity. */
  muted?: Rec;
}

type Rec = Record<string, any>;

/**
 * Codex (CLI and desktop app) writes each thread as a "rollout" JSONL under
 * ~/.codex/sessions/YYYY/MM/DD/ and indexes threads in ~/.codex/state_*.sqlite.
 * We find rollouts from both places and tail them.
 */
export class CodexAdapter {
  private home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  private files = new Map<string, Tracked>();
  private known = new Map<string, { title?: string }>();
  private lastDiscover = 0;

  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  start(): void {
    if (!existsSync(this.home)) {
      console.log(`[codex] ${this.home} не найден — Codex не установлен?`);
      return;
    }
    console.log(`[codex] слежу за ${this.home}`);
    void this.poll();
    setInterval(() => void this.poll(), POLL_MS).unref();
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDiscover > DISCOVER_MS) {
      this.lastDiscover = now;
      await this.discover(now);
    }
    for (const t of this.files.values()) {
      const recs = t.tail.read() as Rec[];
      if (!recs.length) continue;
      if (t.fresh) {
        t.fresh = false;
        if (looksImported(recs)) {
          t.muted = recs[0];
          continue;
        }
      }
      if (t.muted) {
        // The user picked up an imported thread in Codex: it is a real agent now.
        this.apply(t, { ...t.muted, timestamp: recs[0].timestamp });
        t.muted = undefined;
      }
      for (const rec of recs) this.apply(t, rec);
    }
  }

  private async discover(now: number): Promise<void> {
    for (const [path, info] of await this.fromDatabase(now)) this.known.set(path, info);
    for (const path of walkRollouts(join(this.home, 'sessions'))) if (!this.known.has(path)) this.known.set(path, {});

    for (const [path, info] of this.known) {
      if (this.files.has(path)) continue;
      try {
        if (now - statSync(path).mtimeMs > RECENT_MS) continue;
      } catch {
        continue;
      }
      const id = 'codex:' + (basename(path, '.jsonl').match(/[0-9a-f-]{36}$/i)?.[0] ?? basename(path));
      this.files.set(path, { tail: new JsonlTail(path), id, title: info.title, titled: !!info.title, fresh: true });
    }
  }

  /** Recently updated threads from the Codex state database, if node:sqlite is available. */
  private async fromDatabase(now: number): Promise<Map<string, { title?: string }>> {
    const out = new Map<string, { title?: string }>();
    let files: string[];
    try {
      files = readdirSync(this.home).filter((f) => /^state_\d+\.sqlite$/.test(f));
    } catch {
      return out;
    }
    let sqlite: typeof import('node:sqlite');
    try {
      sqlite = await import('node:sqlite');
    } catch {
      return out;
    }
    for (const f of files) {
      try {
        const db = new sqlite.DatabaseSync(join(this.home, f), { readOnly: true });
        const rows = db.prepare('SELECT rollout_path, title, updated_at FROM threads WHERE archived = 0').all() as Rec[];
        db.close();
        for (const r of rows) {
          const updated = Number(r.updated_at) < 1e12 ? Number(r.updated_at) * 1000 : Number(r.updated_at);
          if (now - updated < RECENT_MS && r.rollout_path) out.set(String(r.rollout_path), { title: r.title || undefined });
        }
      } catch {
        // Schema changed or the database is locked; the sessions folder scan still works.
      }
    }
    return out;
  }

  private apply(t: Tracked, rec: Rec): void {
    const at = Date.parse(rec.timestamp) || Date.now();
    const p: Rec = rec.payload ?? {};
    const id = t.id;

    // The agent went home after a quiet spell. Only real work brings it back, with the
    // metadata it had; bookkeeping (token counts, turn context) just updates what we know.
    const missing = rec.type !== 'session_meta' && !this.store.has(id);
    if (missing && !wakesAgent(rec)) {
      if (rec.type === 'turn_context') t.metadata = { ...t.metadata, ...contextPatch(p) };
      return;
    }
    if (missing) this.store.update(id, t.metadata ?? { source: 'codex', title: t.title ? clip(t.title, 48) : 'Codex' }, at);

    switch (rec.type) {
      case 'session_meta':
      case 'turn_context': {
        const patch = contextPatch(p);
        if (rec.type === 'session_meta') {
          patch.startedAt = at;
          patch.title = t.title ? clip(t.title, 48) : 'Codex';
        }
        t.metadata = { ...t.metadata, ...patch };
        this.store.update(id, patch, at);
        return;
      }
      case 'response_item':
        return this.responseItem(t, p, at);
      case 'event_msg':
        switch (p.type) {
          case 'task_started':
            return this.store.newTurn(id, 'Взялся за задачу', at);
          case 'task_complete':
          case 'turn_aborted':
            return this.store.turnEnd(id, at);
          case 'exec_approval_request':
          case 'apply_patch_approval_request':
            return this.store.waiting(id, 'Ждёт вашего разрешения', at);
          case 'request_user_input':
            return this.store.waiting(id, 'Задаёт вам вопрос', at);
        }
    }
  }

  private responseItem(t: Tracked, p: Rec, at: number): void {
    const id = t.id;
    switch (p.type) {
      case 'message': {
        const text = messageText(p);
        if (!text) return;
        if (p.role === 'user') {
          if (!t.titled) {
            this.store.update(id, { source: 'codex', title: clip(text, 48) }, at);
            t.metadata = { ...t.metadata, source: 'codex', title: clip(text, 48) };
            t.titled = true;
          }
          this.store.log(id, { at, kind: 'user', text });
          this.store.newTurn(id, 'Читает задачу', at);
        } else if (p.role === 'assistant') {
          this.store.log(id, { at, kind: 'assistant', text });
        }
        return;
      }
      case 'reasoning':
        return this.store.thinking(id, 'Размышляет', at);
      case 'function_call':
      case 'custom_tool_call': {
        let input: Rec = {};
        try {
          if (typeof p.arguments === 'string') input = JSON.parse(p.arguments);
          else if (typeof p.input === 'string') input = { code: p.input }; // code-mode `exec` and apply_patch send raw text
          else if (p.input && typeof p.input === 'object') input = p.input;
        } catch {
          // not JSON: leave the input empty
        }
        const { activity, detail, test } = describeTool(p.name ?? 'tool', input);
        return this.store.tool(id, p.name ?? 'tool', activity, detail, at, test);
      }
      case 'local_shell_call': {
        const { activity, detail } = describeTool('local_shell', { command: p.action?.command });
        return this.store.tool(id, 'local_shell', activity, detail, at);
      }
      case 'web_search_call':
        return this.store.tool(id, 'web_search', 'web', `Гуглит «${clip(p.action?.query ?? '', 40)}»`, at);
      case 'function_call_output':
      case 'custom_tool_call_output':
        return this.store.toolDone(id, at, commandOutcome(outputText(p.output)) ?? testOutcome(outputText(p.output)));
    }
  }
}

function contextPatch(p: Rec): Parameters<Store['update']>[1] {
  const patch: Parameters<Store['update']>[1] = { source: 'codex' };
  if (typeof p.cwd === 'string') {
    patch.cwd = p.cwd;
    patch.project = basename(p.cwd);
  }
  // The model can change between turns, so every turn_context updates it.
  if (typeof p.model === 'string') {
    patch.model = p.model;
    patch.role = p.model === 'codex-auto-review' ? 'reviewer' : 'worker';
  }
  if (typeof p.effort === 'string') patch.effort = p.effort;
  return patch;
}

/** Tool output is a string or a list of content parts, depending on the tool. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((c: Rec) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/** Text of a message item, or '' for empty messages and injected context (AGENTS.md, environment). */
function messageText(p: Rec): string {
  const text = (Array.isArray(p.content) ? p.content : [])
    .map((c: Rec) => c.text)
    .filter((s: unknown) => typeof s === 'string')
    .join('\n');
  if (!text.trim() || /^\s*<(environment_context|user_instructions|permissions)/.test(text) || text.startsWith('# AGENTS.md')) return '';
  return text;
}

const WAKING_ITEMS = new Set(['reasoning', 'function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']);
const WAKING_EVENTS = new Set(['task_started', 'exec_approval_request', 'apply_patch_approval_request', 'request_user_input']);

/** Records that mean the agent is working (or needs the user) again. */
function wakesAgent(rec: Rec): boolean {
  const p: Rec = rec.payload ?? {};
  if (rec.type === 'event_msg') return WAKING_EVENTS.has(p.type);
  if (rec.type !== 'response_item') return false;
  return WAKING_ITEMS.has(p.type) || (p.type === 'message' && !!messageText(p));
}

/**
 * Codex Desktop can import other agents' history (e.g. Claude Code sessions):
 * such a rollout is written in one go, whole turns within a few milliseconds,
 * while a real turn takes seconds.
 */
function looksImported(recs: Rec[]): boolean {
  if (recs[0]?.type !== 'session_meta') return false;
  const start = Date.parse(recs[0].timestamp);
  const end = Date.parse(recs[recs.length - 1].timestamp);
  const completed = recs.some((r) => r.type === 'event_msg' && r.payload?.type === 'task_complete');
  return completed && end - start < 1_500;
}

function walkRollouts(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => /rollout-.*\.jsonl$/.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}
