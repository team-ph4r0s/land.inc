import { EventEmitter } from 'node:events';
import type { Activity, AgentState, LogEntry, ServerMessage } from '@land/protocol';

const LOG_LIMIT = 40;
/** Turn ended but no new record yet: the agent heads to the kitchen. */
const IDLE_AFTER_MS = 90_000;
/** A tool call without a result for this long is most likely a permission prompt. */
const WAIT_AFTER_MS = 12_000;
/** Tools that legitimately run for a long time and should not be mistaken for a prompt. */
const LONG_TOOLS = /^(Bash|PowerShell|Monitor|Agent|Task|WebSearch|WebFetch|shell|exec_command|local_shell|container\.exec|spawn_agent|wait)/;
const LEAVE_AFTER_MS = 45 * 60_000;
const SUBAGENT_LEAVE_AFTER_MS = 2 * 60_000;
/**
 * A running tool or an open prompt keeps the agent in the office past the usual
 * timeout, but not forever: a session killed mid-prompt never writes a result.
 */
export const BUSY_LEAVE_AFTER_MS = 4 * 60 * 60_000;

interface Internal {
  state: AgentState;
  log: LogEntry[];
  pendingTool?: { name: string; at: number };
  /** Set when the transcript says the turn ended (or a hook said so). */
  turnEnded: boolean;
  /** Activity forced by a hook, e.g. a permission prompt; cleared by the next record. */
  hookWait?: string;
}

export type AgentPatch = Partial<Omit<AgentState, 'id' | 'source'>> & { source: AgentState['source'] };

/** What an agent that went home is remembered by, so it comes back as itself. */
type Identity = Pick<AgentState, 'title' | 'project' | 'cwd' | 'parentId' | 'model'>;
const DEPARTED_LIMIT = 500;

/**
 * Holds every agent the adapters have seen and turns raw transcript facts into
 * office activities. Adapters only report what happened; time-based transitions
 * (idle, waiting, leaving) are applied here on a timer.
 */
export class Store extends EventEmitter<{ message: [ServerMessage] }> {
  private agents = new Map<string, Internal>();
  private departed = new Map<string, Identity>();

  constructor() {
    super();
    setInterval(() => this.tick(), 2_000).unref();
  }

  snapshot(): ServerMessage {
    const agents: AgentState[] = [];
    const logs: Record<string, LogEntry[]> = {};
    for (const a of this.agents.values()) {
      agents.push(a.state);
      logs[a.state.id] = a.log;
    }
    return { type: 'snapshot', agents, logs };
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  /** Create or update an agent. `at` is the transcript time of the fact being applied. */
  update(id: string, patch: AgentPatch, at = Date.now()): void {
    let a = this.agents.get(id);
    if (!a) {
      a = {
        state: {
          id,
          source: patch.source,
          title: 'Агент',
          project: '',
          cwd: '',
          activity: 'think',
          detail: '',
          startedAt: at,
          updatedAt: at,
        },
        log: [],
        turnEnded: false,
      };
      // Whoever brings the agent back (a hook, a transcript record) may know only part
      // of it; start from what it was when it left.
      const known = this.departed.get(id);
      if (known) {
        Object.assign(a.state, known);
        this.departed.delete(id);
      }
      this.agents.set(id, a);
    }
    Object.assign(a.state, patch);
    a.state.updatedAt = Math.max(a.state.updatedAt, at);
    this.publish(a);
  }

  /** Agent started a tool call. */
  tool(id: string, name: string, activity: Activity, detail: string, at: number): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.pendingTool = { name, at };
    a.turnEnded = false;
    a.hookWait = undefined;
    this.setActivity(a, activity, detail, at);
    this.log(id, { at, kind: 'tool', text: detail });
  }

  toolDone(id: string, at: number): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.pendingTool = undefined;
    a.hookWait = undefined;
    if (a.state.activity === 'wait') this.setActivity(a, 'think', 'Обдумывает результат', at);
    else this.touch(a, at);
  }

  /**
   * The user sent a new prompt. Anything still pending belongs to an earlier turn
   * that never finished (the session was killed mid-tool), so it is dropped.
   *
   * The same prompt can arrive twice, from the UserPromptSubmit hook and later from
   * the transcript poll. A tool that started after the prompt belongs to this very
   * turn, so a late copy of the prompt must leave it, and the activity, alone.
   */
  newTurn(id: string, detail: string, at: number): void {
    const a = this.agents.get(id);
    if (!a) return;
    if (a.pendingTool && a.pendingTool.at >= at) return this.touch(a, at);
    a.pendingTool = undefined;
    this.thinking(id, detail, at);
  }

  /** The model kept reasoning: back to the desk. */
  thinking(id: string, detail: string, at: number): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.turnEnded = false;
    a.hookWait = undefined;
    this.setActivity(a, 'think', detail, at);
  }

  turnEnd(id: string, at: number): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.turnEnded = true;
    a.pendingTool = undefined;
    a.hookWait = undefined;
    this.setActivity(a, 'idle', 'Ждёт следующую задачу', at);
  }

  /** Explicit "needs the user" signal (Codex approval request, Claude Notification hook). */
  waiting(id: string, detail: string, at: number): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.hookWait = detail;
    this.setActivity(a, 'wait', detail, at);
  }

  log(id: string, entry: LogEntry): void {
    const a = this.agents.get(id);
    if (!a || !entry.text) return;
    entry.text = entry.text.length > 400 ? entry.text.slice(0, 400) + '…' : entry.text;
    a.log.push(entry);
    if (a.log.length > LOG_LIMIT) a.log.shift();
    this.emit('message', { type: 'log', id, entry });
  }

  remove(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    const { title, project, cwd, parentId, model } = a.state;
    this.departed.set(id, { title, project, cwd, parentId, model });
    if (this.departed.size > DEPARTED_LIMIT) this.departed.delete(this.departed.keys().next().value!);
    this.agents.delete(id);
    this.emit('message', { type: 'remove', id });
  }

  private setActivity(a: Internal, activity: Activity, detail: string, at: number): void {
    a.state.activity = activity;
    a.state.detail = detail;
    this.touch(a, at);
  }

  private touch(a: Internal, at: number): void {
    a.state.updatedAt = Math.max(a.state.updatedAt, at);
    this.publish(a);
  }

  private publish(a: Internal): void {
    this.emit('message', { type: 'upsert', agent: { ...a.state } });
  }

  private tick(): void {
    const now = Date.now();
    for (const a of [...this.agents.values()]) {
      const quiet = now - a.state.updatedAt;
      const busy = !!a.pendingTool || !!a.hookWait;
      const leaveAfter = busy ? BUSY_LEAVE_AFTER_MS : a.state.parentId ? SUBAGENT_LEAVE_AFTER_MS : LEAVE_AFTER_MS;
      if (quiet > leaveAfter) {
        this.remove(a.state.id);
        continue;
      }
      const p = a.pendingTool;
      if (p && !a.hookWait && a.state.activity !== 'wait' && now - p.at > WAIT_AFTER_MS && !LONG_TOOLS.test(p.name)) {
        a.state.activity = 'wait';
        a.state.detail = `Ждёт разрешения: ${p.name}`;
        this.publish(a);
      } else if (!p && !a.turnEnded && a.state.activity !== 'idle' && a.state.activity !== 'wait' && quiet > IDLE_AFTER_MS) {
        a.state.activity = 'idle';
        a.state.detail = 'Перерыв';
        this.publish(a);
      }
    }
  }
}
