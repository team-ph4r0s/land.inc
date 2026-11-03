import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store.ts';
import { JsonlTail } from '../tail.ts';
import { clip, commandOutcome, describeTool, testOutcome } from '../activity.ts';

type Metadata = { cwd?: string; project?: string; parentId?: string };

function workspacePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const uri = new URL(value);
    if (uri.protocol !== 'file:') return undefined;
    return fileURLToPath(uri);
  } catch { return undefined; }
}

function projectName(path: string): string {
  return (path.includes('\\') ? win32.basename(path) : basename(path)) || path;
}

function decodeArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, v]) => {
    if (typeof v !== 'string' || !v.startsWith('"')) return [key, v];
    try { const decoded = JSON.parse(v); return [key, typeof decoded === 'string' ? decoded : v]; } catch { return [key, v]; }
  }));
}

// Antigravity's generated transcript is an implementation detail, not a public API.
// Only sessions with a recently updated transcript enter the office.
export class AntigravityAdapter {
  private readonly root: string;
  private readonly files = new Map<string, JsonlTail>();
  private readonly store: Store;
  private readonly dbPath: string;
  private readonly metadata = new Map<string, { at: number; value: Metadata }>();
  constructor(store: Store, root = join(homedir(), '.gemini', 'antigravity', 'brain')) {
    this.store = store;
    this.root = root;
    this.dbPath = join(dirname(root), 'conversation_summaries.db');
  }
  start(): void {
    this.poll();
    setInterval(() => this.poll(), 1000).unref();
  }
  poll(): void {
    let dirs;
    try { dirs = readdirSync(this.root, { withFileTypes: true }); } catch { return; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const path = join(this.root, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
      let tail = this.files.get(path);
      if (!tail) {
        try { if (Date.now() - statSync(path).mtimeMs > 45 * 60_000) continue; } catch { continue; }
        tail = new JsonlTail(path);
        this.files.set(path, tail);
      }
      try {
        const records = tail.read();
        if (records.length) {
          const meta = this.readMetadata(dir.name);
          for (const record of records) this.apply(`antigravity:${dir.name}`, record, meta);
        }
      } catch { /* A transcript can disappear or be replaced during a poll. */ }
    }
  }
  private readMetadata(id: string): Metadata {
    const cached = this.metadata.get(id);
    if (cached && Date.now() - cached.at < 5_000) return cached.value;
    let value: Metadata = {};
    try {
      const db = new DatabaseSync(this.dbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT workspace_uris, parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?').get(id);
        if (row) {
          const uris: unknown = JSON.parse(String(row.workspace_uris));
          const cwd = Array.isArray(uris) ? uris.map(workspacePath).find(Boolean) : undefined;
          const parent = typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id : '';
          value = { ...(cwd ? { cwd, project: projectName(cwd) } : {}), ...(parent && parent !== id ? { parentId: `antigravity:${parent}` } : {}) };
        }
      } finally { db.close(); }
    } catch { value = cached?.value ?? {}; }
    this.metadata.set(id, { at: Date.now(), value });
    return value;
  }
  private apply(id: string, value: unknown, metadata: Metadata): void {
    if (!value || typeof value !== 'object') return;
    const r = value as Record<string, any>;
    if (!['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC'].includes(r.type)) return;
    const at = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN;
    if (!Number.isFinite(at)) return;
    const contextCwd = r.type === 'USER_INPUT' && typeof r.content === 'string' ? r.content.match(/^Command Working Directory:\s*(.+)$/im)?.[1]?.trim() : undefined;
    const cwd = metadata.cwd ?? contextCwd;
    this.store.update(id, { source: 'antigravity', ...metadata, ...(cwd ? { cwd, project: projectName(cwd) } : {}) }, at);
    if (r.type === 'USER_INPUT' && typeof r.content === 'string' && r.content.trim()) {
      const content = r.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i)?.[1]?.trim() || r.content.trim();
      this.store.update(id, { source: 'antigravity', title: clip(content, 48) }, at);
      this.store.log(id, { at, kind: 'user', text: content });
      this.store.newTurn(id, 'Читает задачу', at);
    } else if (r.type === 'PLANNER_RESPONSE') {
      this.store.thinking(id, 'Размышляет', at);
      const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
      if (typeof r.content === 'string' && r.content.trim()) this.store.log(id, { at, kind: 'assistant', text: r.content.trim() });
      for (const call of calls) {
        if (!call || typeof call.name !== 'string') continue;
        const { activity, detail, test } = describeTool(call.name, decodeArgs(call.args));
        this.store.tool(id, call.name, activity, detail, at, test);
      }
      // A response without tool calls is treated as a completed turn, heuristically.
      if (!calls.length && typeof r.content === 'string' && r.content.trim()) this.store.turnEnd(id, at);
    } else if (r.type === 'GENERIC' && r.status !== 'RUNNING') {
      const content = typeof r.content === 'string' ? r.content : '';
      this.store.toolDone(id, at, commandOutcome(content) ?? testOutcome(content) ?? (r.status === 'ERROR' ? false : undefined));
    }
  }
}
