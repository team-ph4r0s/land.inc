// Shared contract between land-daemon and the office client.

export type Source = 'claude' | 'codex' | 'demo';

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
  model?: string;
  startedAt: number;
  updatedAt: number;
}

export interface LogEntry {
  at: number;
  kind: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
}

export type ServerMessage =
  | { type: 'snapshot'; agents: AgentState[]; logs: Record<string, LogEntry[]> }
  | { type: 'upsert'; agent: AgentState }
  | { type: 'remove'; id: string }
  | { type: 'log'; id: string; entry: LogEntry };

export const DAEMON_PORT = 4317;
