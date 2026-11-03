// Shared contract between land-daemon and the office client.

export type Source = 'claude' | 'codex' | 'antigravity' | 'demo';

/** What the agent is doing right now; each activity maps to a zone of the office. */
export type Activity =
  | 'think' // reasoning between steps: sits at own desk
  | 'write' // editing files: types at own desk
  | 'read' // reading / searching code: archive shelves
  | 'bash' // running commands: server room
  | 'web' // web search / fetch / browser: internet corner
  | 'plan' // todo lists, plans: whiteboard
  | 'talk' // delegating to a subagent: meeting table
  | 'wait' // blocked on the user (permission, question): raises a hand at the desk
  | 'idle'; // turn finished, waiting for the next prompt: kitchen

/** Short-lived reaction to the outcome of a test run. */
export type Mood = 'cool' | 'fail';

export interface AgentState {
  id: string;
  source: Source;
  title: string;
  /** Basename of the working directory; agents of one project sit together. */
  project: string;
  cwd: string;
  parentId?: string;
  activity: Activity;
  /** Short human description of the current action, e.g. "Edit README.md". */
  detail: string;
  /** Model id as the agent reports it, updated every turn (e.g. claude-sonnet-5-5, gpt-6.1-terra). */
  model?: string;
  /** Reasoning effort of the current turn, when the transcript states it. */
  effort?: string;
  /** Codex auto-review passes are service checks, not workers of their own. */
  role?: 'worker' | 'reviewer';
  mood?: Mood;
  moodAt?: number;
  /** A confirmed command failure; clients may animate it for a short time. */
  fireAt?: number;
  /** Set when the agent was launched from the task board. */
  taskId?: string;
  startedAt: number;
  updatedAt: number;
}

export interface LogEntry {
  at: number;
  kind: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
}

export type Executor = 'claude' | 'codex';

/** read: may look but not change anything; write: may edit files inside the project folder. */
export type Access = 'read' | 'write';

export interface ModelOption {
  id: string;
  label: string;
  efforts?: string[];
  defaultEffort?: string;
}

export interface BoardConfig {
  /** Project folders seen in Claude and Codex sessions, most recent first. */
  projects: string[];
  /** Listed projects that are not inside a Git repository: edits there are harder to review and undo. */
  outsideGit: string[];
  executors: Record<Executor, { available: boolean; models: ModelOption[]; note?: string }>;
}

export type TaskStatus = 'starting' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  prompt: string;
  cwd: string;
  executor: Executor;
  model: string;
  effort?: string;
  access: Access;
  /** The folder is not inside a Git repository. */
  outsideGit?: boolean;
  status: TaskStatus;
  createdAt: number;
  finishedAt?: number;
  /** Office agent that works on the task, once its transcript is known. */
  agentId?: string;
  /** Final answer, or the error that stopped the run (trimmed). */
  result?: string;
}

export interface NewTask {
  prompt: string;
  cwd: string;
  executor: Executor;
  model: string;
  effort?: string;
  access: Access;
}

export type ServerMessage =
  | { type: 'snapshot'; agents: AgentState[]; logs: Record<string, LogEntry[]> }
  | { type: 'upsert'; agent: AgentState }
  | { type: 'remove'; id: string }
  | { type: 'log'; id: string; entry: LogEntry }
  | { type: 'board'; config: BoardConfig; tasks: Task[] }
  | { type: 'task'; task: Task }
  | { type: 'task.accepted'; requestId: string }
  | { type: 'task.rejected'; requestId: string; message: string }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'task.create'; task: NewTask; requestId?: string }
  | { type: 'team.create'; task: NewTask; requestId?: string; colleague?: { model: string; effort?: string } }
  | { type: 'task.cancel'; id: string };

export const DAEMON_PORT = 4317;

export interface ModelInfo {
  /** Character the office draws for this model. */
  kind: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'claude' | 'sol' | 'terra' | 'luna' | 'astra' | 'reviewer' | 'codex' | 'demo';
  /** Human name, e.g. "Sonnet 5.5" or "GPT-6.1 Terra". */
  label: string;
}

/**
 * Turn a model id into the character and name the office shows. Unknown ids are
 * kept as they are, so a new model still gets a sensible label.
 */
export function describeModel(source: Source, model?: string): ModelInfo {
  const m = (model ?? '').toLowerCase();
  if (source === 'demo' && !m) return { kind: 'demo', label: 'Демо' };
  const claude = m.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (claude) {
    const family = claude[1] as 'opus' | 'sonnet' | 'haiku' | 'fable';
    const version = claude[3] ? `${claude[2]}.${claude[3]}` : claude[2];
    return { kind: family, label: `${family[0].toUpperCase()}${family.slice(1)} ${version}` };
  }
  if (m === 'codex-auto-review') return { kind: 'reviewer', label: 'Auto Review' };
  const gpt = m.match(/^gpt-(\d+(?:\.\d+)?)(?:-(sol|terra|luna|astra))?$/);
  if (gpt) {
    const tier = gpt[2] as 'sol' | 'terra' | 'luna' | 'astra' | undefined;
    const name = tier ? ` ${tier[0].toUpperCase()}${tier.slice(1)}` : '';
    return { kind: tier ?? 'codex', label: `GPT-${gpt[1]}${name}` };
  }
  if (source === 'antigravity') return { kind: 'codex', label: model || 'Antigravity' };
  if (source === 'claude') return { kind: 'claude', label: model || 'Claude' };
  return { kind: 'codex', label: model || 'Codex' };
}
