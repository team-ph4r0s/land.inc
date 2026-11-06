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

export type Executor = 'claude' | 'codex' | 'antigravity';

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
  /** Final answer, or the error that stopped the run (within the CLI capture limit). */
  result?: string;
  /** This task continues an earlier one in the same agent session (a reply to the agent). */
  continues?: string;
  /** A cancel was not confirmed: processes this run started may still be at work in its session. */
  orphans?: boolean;
  /** Every task owns a clean conversation and CLI session. */
  conversationId?: string;
  /** Pipeline run that owns this task, when it is part of a multi-agent workflow. */
  pipelineRunId?: string;
  /** Full artifact path for this task's result. */
  artifactPath?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  /** Approximate context usage reported by the active provider. */
  context?: { used: number; budget: number; compacted?: boolean };
}

export interface NewTask {
  prompt: string;
  cwd: string;
  executor: Executor;
  model: string;
  effort?: string;
  access: Access;
  conversationId?: string;
  pipelineRunId?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
}

export type AgentProvider = 'claude' | 'codex' | 'antigravity';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type AgentRoleType = 'writer' | 'coder' | 'reviewer' | 'editor' | 'planner' | 'security' | 'custom';
export type AgentAccessMode = 'read-only' | 'workspace-write';

export interface AvatarConfig {
  outfitColor: string;
  accessory?: 'crown' | 'beret' | 'glasses' | 'notebook' | 'companion' | 'none';
  skinTone?: string;
}

export interface AgentPersona {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  roleType: AgentRoleType;
  characterAndSystemPrompt: string;
  defaultAccessMode: AgentAccessMode;
  avatarConfig: AvatarConfig;
  mandatoryMcpServers: string[];
  createdAt: number;
  updatedAt: number;
}

export type AgentProfile = AgentPersona;

export interface PipelineStage {
  id: string;
  agentId: string;
  name: string;
  order: number;
  maxIterations?: number;
  access: Access;
  status?: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  artifactPath?: string;
}

export interface TeamPipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
  loop?: { stageIds: string[]; maxIterations: number };
  createdAt: number;
  updatedAt: number;
}

export type McpServerName = 'markitdown' | 'context-budget' | 'strategic-compact' | 'agentic-shield';
export type McpServerStatus = 'installed' | 'available' | 'missing' | 'unhealthy' | 'installing';

export interface McpStatus {
  name: McpServerName;
  status: McpServerStatus;
  version?: string;
  command?: string;
  note?: string;
  checkedAt: number;
}

export interface McpInstallRequest {
  servers: McpServerName[];
  runtimeDir?: string;
}

export interface DaemonDiagnostics {
  uptimeSeconds: number;
  rssBytes: number;
  activeProcesses: number;
  executors: BoardConfig['executors'];
  mcp: McpStatus[];
}

export interface SecurityToken {
  value: string;
  issuedAt: number;
  expiresAt?: number;
}

export interface TaskArtifact {
  id: string;
  taskId: string;
  stageId?: string;
  path: string;
  kind: 'draft' | 'review' | 'final' | 'summary' | 'log';
  createdAt: number;
  bytes: number;
}

/** author does the task, reviewers check it read-only, the finisher (the author again) wraps up. */
export type TurnRole = 'planner' | 'author' | 'reviewer' | 'finisher';
export type TurnStatus = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface CollabTurn {
  role: TurnRole;
  executor: Executor;
  model: string;
  effort?: string;
  access: Access;
  status: TurnStatus;
  /** Board task of this turn, once it started. */
  taskId?: string;
  /** Office agent of this turn, once its CLI reported one. */
  agentId?: string;
  /** What this turn passed on to the next one (its "## Коллеге" section). */
  handoff?: string;
  artifactPath?: string;
}

/** A task worked on by several agents in turns: one card in «Переговорка». */
export interface Collaboration {
  id: string;
  prompt: string;
  cwd: string;
  access: Access;
  status: 'running' | 'stopping' | 'done' | 'failed' | 'stopped';
  turns: CollabTurn[];
  createdAt: number;
  finishedAt?: number;
  /** The finisher's answer to the user. */
  result?: string;
  /** Why the work did not finish. */
  reason?: string;
}

export interface DnsFamily {
  mode: 'auto' | 'manual' | 'unknown';
  servers: string[];
}

export interface OfficeRelease {
  version: string;
  tag: string;
  sha: string;
  url: string;
  notes: string;
}
export interface UpdateState {
  current: string;
  available?: OfficeRelease;
  phase: 'idle' | 'checking' | 'available' | 'preparing' | 'switching' | 'done' | 'failed';
  message: string;
  managed: boolean;
  simulated: boolean;
  checkedAt?: number;
}
export interface DnsAdapter {
  id: string;
  index: number;
  name: string;
  ipv4: DnsFamily;
  ipv6: DnsFamily;
  revision: string;
  status?: string;
  mediaConnectionState?: string;
  interfaceOperationalStatus?: string;
  operStatus?: number;
  interfaceDescription?: string;
  macAddress?: string;
  physical?: boolean;
}
export interface DnsSettings {
  ipv4: DnsFamily;
  ipv6: DnsFamily;
}
export interface DnsState {
  supported: boolean;
  simulated: boolean;
  adapters: DnsAdapter[];
  backups: { id: string; name: string; at: number; settings: DnsSettings }[];
  note?: string;
}
export interface DnsProbe {
  server: string;
  host: string;
  addresses: string[];
  ms: number;
  error?: string;
}

export type ServerMessage =
  | { type: 'security.session'; token: string; expiresAt?: number }
  | { type: 'agents'; agents: AgentPersona[] }
  | { type: 'agent'; event: Extract<ProtocolEvent, { type: `agent:${string}` }> }
  | { type: 'mcp:status'; statuses: McpStatus[] }
  | { type: 'mcp:install:progress'; name: McpServerName; progress: number; message: string }
  | { type: 'mcp:install:complete'; statuses: McpStatus[] }
  | { type: 'updates'; state: UpdateState }
  | { type: 'dns.result'; requestId: string; state?: DnsState; probes?: DnsProbe[]; error?: string; message?: string }
  | { type: 'folders'; requestId: string; path?: string; parent?: string; folders?: string[]; error?: string }
  | { type: 'snapshot'; agents: AgentState[]; logs: Record<string, LogEntry[]> }
  | { type: 'upsert'; agent: AgentState }
  | { type: 'remove'; id: string }
  | { type: 'log'; id: string; entry: LogEntry }
  | { type: 'board'; config: BoardConfig; tasks: Task[] }
  | { type: 'task'; task: Task }
  | { type: 'task:stream:chunk'; taskId: string; chunk: string; sequence: number }
  | { type: 'artifact:saved'; requestId: string; path: string }
  | { type: 'diagnostics'; diagnostics: DaemonDiagnostics }
  | { type: 'task.accepted'; requestId: string }
  | { type: 'task.rejected'; requestId: string; message: string }
  | { type: 'collabs'; collabs: Collaboration[] }
  | { type: 'collab'; collab: Collaboration }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'updates.check' }
  | { type: 'updates.install'; version: string; sha: string }
  | { type: 'dns.read'; requestId: string }
  | { type: 'dns.test'; requestId: string; servers: string[] }
  | { type: 'dns.apply'; requestId: string; adapterId: string; revision: string; settings: DnsSettings }
  | { type: 'dns.restore'; requestId: string; adapterId: string; revision: string }
  | { type: 'board.refresh' }
  | { type: 'folders.list'; requestId: string; path?: string }
  | { type: 'task.create'; task: NewTask; requestId?: string }
  | { type: 'team.create'; task: NewTask; requestId?: string; colleague?: { model: string; effort?: string } | { executor: Executor; model: string; effort?: string }[]; planner?: { executor: Executor; model: string; effort?: string }; pipeline?: TeamPipeline }
  | { type: 'task.cancel'; id: string }
  /** Stop a collaboration: the running turn is cancelled and no further turn starts. */
  | { type: 'team.cancel'; id: string }
  /**
   * Reply to the agent of a finished task: it continues in the same session, with what it
   * already knows. Only the task id is sent; the daemon finds the session itself.
   */
  | { type: 'task.reply'; taskId: string; prompt: string; access: Access; model?: string; effort?: string; requestId?: string }
  | { type: 'agents.list' }
  | { type: 'agent.create'; agent: Partial<AgentPersona>; requestId?: string }
  | { type: 'agent.update'; id: string; patch: Partial<AgentPersona>; requestId?: string }
  | { type: 'agent.clone'; id: string; name?: string; requestId?: string }
  | { type: 'agent.delete'; id: string; requestId?: string }
  | { type: 'mcp.audit' }
  | { type: 'mcp.install'; request: McpInstallRequest }
  | { type: 'diagnostics.read' }
  | { type: 'artifact.save'; taskId: string; path: string; format?: 'md' | 'txt'; requestId?: string };

export type ProtocolEvent =
  | { type: 'agent:created'; agent: AgentPersona }
  | { type: 'agent:updated'; agent: AgentPersona }
  | { type: 'agent:deleted'; id: string }
  | { type: 'mcp:status'; statuses: McpStatus[] }
  | { type: 'mcp:install:progress'; name: McpServerName; progress: number; message: string }
  | { type: 'mcp:install:complete'; statuses: McpStatus[] }
  | { type: 'pipeline:stage:start'; runId: string; stage: PipelineStage }
  | { type: 'pipeline:stage:stream'; runId: string; stageId: string; chunk: string }
  | { type: 'pipeline:stage:complete'; runId: string; stage: PipelineStage; artifact: TaskArtifact }
  | { type: 'pipeline:artifact:ready'; runId: string; artifact: TaskArtifact }
  | { type: 'task:stream:chunk'; taskId: string; chunk: string; sequence: number };

export type WireMessage = ServerMessage | ClientMessage | ProtocolEvent;

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Runtime guard for messages received from a browser or a CLI hook. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || !isString(value.type)) return false;
  if (value.type === 'task.create' || value.type === 'team.create') {
    const task = value.task;
    return isRecord(task) && isString(task.prompt) && isString(task.cwd) && isString(task.executor) && isString(task.model) && (task.access === 'read' || task.access === 'write');
  }
  if (value.type === 'task.reply') return isString(value.taskId) && isString(value.prompt) && (value.access === 'read' || value.access === 'write');
  if (value.type === 'task.cancel' || value.type === 'team.cancel') return isString(value.id);
  if (value.type === 'folders.list' || value.type === 'dns.read' || value.type === 'dns.test' || value.type === 'dns.apply' || value.type === 'dns.restore') return isString(value.requestId);
  if (value.type === 'updates.install') return isString(value.version) && isString(value.sha);
  if (value.type === 'agents.list' || value.type === 'mcp.audit' || value.type === 'diagnostics.read') return true;
  if (value.type === 'agent.delete' || value.type === 'agent.clone') return isString(value.id);
  if (value.type === 'agent.create') return isRecord(value.agent);
  if (value.type === 'agent.update') return isString(value.id) && isRecord(value.patch);
  if (value.type === 'mcp.install') return isRecord(value.request) && Array.isArray(value.request.servers);
  if (value.type === 'artifact.save') return isString(value.taskId) && isString(value.path);
  return ['updates.check', 'board.refresh'].includes(value.type);
}

/** Runtime guard for events emitted by the daemon. */
export function isProtocolEvent(value: unknown): value is ProtocolEvent {
  if (!isRecord(value) || !isString(value.type)) return false;
  return value.type.startsWith('agent:') || value.type.startsWith('mcp:') || value.type.startsWith('pipeline:') || value.type === 'task:stream:chunk';
}

export function assertClientMessage(value: unknown): ClientMessage {
  if (!isClientMessage(value)) throw new Error('Некорректное сообщение протокола');
  return value;
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || !isString(value.type)) return false;
  return ['security.session', 'agents', 'agent', 'mcp:status', 'mcp:install:progress', 'mcp:install:complete', 'updates', 'dns.result', 'folders', 'snapshot', 'upsert', 'remove', 'log', 'board', 'task', 'task:stream:chunk', 'artifact:saved', 'diagnostics', 'task.accepted', 'task.rejected', 'collabs', 'collab', 'error'].includes(value.type);
}

export function assertServerMessage(value: unknown): ServerMessage {
  if (!isServerMessage(value)) throw new Error('Некорректное сообщение сервера');
  return value;
}

export function isAgentPersona(value: unknown): value is AgentPersona {
  if (!isRecord(value)) return false;
  return isString(value.id) && isString(value.name) && ['claude', 'codex', 'antigravity'].includes(String(value.provider)) && isString(value.model) && ['low', 'medium', 'high', 'xhigh'].includes(String(value.reasoningEffort)) && isString(value.characterAndSystemPrompt) && isFiniteNumber(value.createdAt) && isFiniteNumber(value.updatedAt);
}

export const DAEMON_PORT = 4317;

export interface ModelInfo {
  /** Character the office draws for this model. */
  kind: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'claude' | 'sol' | 'terra' | 'luna' | 'astra' | 'reviewer' | 'codex' | 'antigravity' | 'demo';
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
  // Antigravity does not reliably name its model in the transcript; never guess one.
  if (source === 'antigravity') return { kind: 'antigravity', label: model || 'Antigravity' };
  if (source === 'claude') return { kind: 'claude', label: model || 'Claude' };
  return { kind: 'codex', label: model || 'Codex' };
}
