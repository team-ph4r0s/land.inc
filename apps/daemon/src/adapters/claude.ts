import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Store } from '../store.ts';
import { JsonlTail } from '../tail.ts';
import { clip, describeTool } from '../activity.ts';

/** Sessions untouched for longer than this are not brought into the office. */
const RECENT_MS = 45 * 60_000;
const POLL_MS = 1_000;

interface Tracked {
  tail: JsonlTail;
  id: string;
  parentId?: string;
  titled: boolean;
}

type Rec = Record<string, any>;

/**
 * Claude Code (CLI, IDE, and the Code tab of Claude Desktop) appends every
 * session to ~/.claude/projects/<project>/<session>.jsonl as it runs, and
 * subagents to <session>/subagents/agent-*.jsonl. We tail those files.
 */
export class ClaudeAdapter {
  private root: string;
  private files = new Map<string, Tracked>();

  private store: Store;

  constructor(store: Store) {
    this.store = store;
    const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    this.root = join(base, 'projects');
  }

  start(): void {
    if (!existsSync(this.root)) {
      console.log(`[claude] ${this.root} не найден — Claude Code не установлен?`);
      return;
    }
    console.log(`[claude] слежу за ${this.root}`);
    this.poll();
    setInterval(() => this.poll(), POLL_MS).unref();
  }

  private poll(): void {
    const now = Date.now();
    for (const path of this.discover()) {
      let tracked = this.files.get(path);
      if (!tracked) {
        let mtime: number;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtime > RECENT_MS) continue;
        tracked = this.track(path);
      }
      for (const rec of tracked.tail.read()) this.apply(tracked, rec as Rec);
    }
  }

  private *discover(): Generator<string> {
    for (const project of safeDir(this.root)) {
      if (!project.isDirectory()) continue;
      const dir = join(this.root, project.name);
      for (const entry of safeDir(dir)) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) yield join(dir, entry.name);
        else if (entry.isDirectory()) {
          const sub = join(dir, entry.name, 'subagents');
          for (const f of safeDir(sub)) if (f.isFile() && f.name.endsWith('.jsonl')) yield join(sub, f.name);
        }
      }
    }
  }

  private track(path: string): Tracked {
    const name = basename(path, '.jsonl');
    const isSub = basename(join(path, '..')) === 'subagents';
    let tracked: Tracked;
    if (isSub) {
      const sessionId = basename(join(path, '..', '..'));
      tracked = { tail: new JsonlTail(path), id: `${sessionId}:${name}`, parentId: sessionId, titled: false };
      const meta = readMeta(path.replace(/\.jsonl$/, '.meta.json'));
      if (meta) {
        this.store.update(tracked.id, { source: 'claude', parentId: sessionId, title: meta });
        tracked.titled = true;
      }
    } else {
      tracked = { tail: new JsonlTail(path), id: name, titled: false };
    }
    this.files.set(path, tracked);
    return tracked;
  }

  private apply(t: Tracked, rec: Rec): void {
    const at = Date.parse(rec.timestamp) || Date.now();
    // Older Claude Code versions inline subagent turns into the parent transcript.
    let id = t.id;
    let parentId = t.parentId;
    if (rec.isSidechain && !t.parentId) {
      parentId = t.id;
      id = `${t.id}:sidechain`;
    }

    if (rec.type === 'custom-title' || rec.type === 'agent-name' || rec.type === 'summary') {
      const title = rec.customTitle ?? rec.agentName ?? rec.summary;
      if (typeof title === 'string' && !t.parentId) {
        this.store.update(id, { source: 'claude', title: clip(title, 48) });
        t.titled = true;
      }
      return;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') return;

    const patch: Parameters<Store['update']>[1] = { source: 'claude', parentId };
    if (typeof rec.cwd === 'string') {
      patch.cwd = rec.cwd;
      patch.project = basename(rec.cwd);
    }
    if (rec.message?.model && !String(rec.message.model).startsWith('<')) patch.model = rec.message.model;
    if (!this.store.has(id)) patch.startedAt = at;
    this.store.update(id, patch, at);

    const content = rec.message?.content;
    const blocks: Rec[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

    if (rec.type === 'user') {
      for (const b of blocks) {
        if (b.type === 'tool_result') this.store.toolDone(id, at);
        else if (b.type === 'text' && !rec.isMeta && isHumanText(b.text)) {
          if (b.text.startsWith('[Request interrupted')) {
            this.store.turnEnd(id, at);
            continue;
          }
          const isPrompt = !rec.toolUseResult;
          if (!t.titled && isPrompt) {
            this.store.update(id, { source: 'claude', title: clip(b.text, 48) }, at);
            t.titled = true;
          }
          this.store.log(id, { at, kind: 'user', text: b.text });
          this.store.thinking(id, 'Читает задачу', at);
        }
      }
      return;
    }

    for (const b of blocks) {
      if (b.type === 'tool_use') {
        const { activity, detail } = describeTool(b.name, b.input);
        this.store.tool(id, b.name, activity, detail, at);
      } else if (b.type === 'text' && b.text?.trim()) {
        this.store.log(id, { at, kind: 'assistant', text: b.text });
      } else if (b.type === 'thinking') {
        this.store.thinking(id, 'Размышляет', at);
      }
    }
    if (rec.message?.stop_reason === 'end_turn') this.store.turnEnd(id, at);
  }
}

function isHumanText(text: unknown): text is string {
  if (typeof text !== 'string' || !text.trim()) return false;
  // Slash-command wrappers, system reminders, hook output and similar plumbing.
  return !/^\s*<[a-z-]+[ >]/i.test(text) && !text.startsWith('Caveat:');
}

function readMeta(path: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8'));
    const label = meta.description ?? meta.agentType ?? meta.name;
    return typeof label === 'string' ? clip(label, 48) : undefined;
  } catch {
    return undefined;
  }
}

function safeDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
