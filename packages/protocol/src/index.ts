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
  /** A new task starts a new conversation; replies keep the conversation of the task they answer. */
  conversationId?: string;
}

export interface NewTask {
  prompt: string;
  cwd: string;
  executor: Executor;
  model: string;
  effort?: string;
  access: Access;
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
  | { type: 'updates'; state: UpdateState }
  | { type: 'dns.result'; requestId: string; state?: DnsState; probes?: DnsProbe[]; error?: string; message?: string }
  | { type: 'folders'; requestId: string; path?: string; parent?: string; folders?: string[]; error?: string }
  | { type: 'snapshot'; agents: AgentState[]; logs: Record<string, LogEntry[]> }
  | { type: 'upsert'; agent: AgentState }
  | { type: 'remove'; id: string }
  | { type: 'log'; id: string; entry: LogEntry }
  | { type: 'board'; config: BoardConfig; tasks: Task[] }
  | { type: 'task'; task: Task }
  /** Live CLI output of a running task, at most one message per task every 60 ms. */
  | { type: 'task:stream:chunk'; taskId: string; chunk: string; sequence: number }
  | { type: 'artifact:saved'; requestId: string; path: string }
  | { type: 'task.accepted'; requestId: string }
  | { type: 'task.rejected'; requestId: string; message: string }
  | { type: 'collabs'; collabs: Collaboration[] }
  | { type: 'collab'; collab: Collaboration }
  | { type: 'error'; message: string }
  | ServerMessage15;

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
  | { type: 'team.create'; task: NewTask; requestId?: string; colleague?: { model: string; effort?: string } | { executor: Executor; model: string; effort?: string }[]; planner?: { executor: Executor; model: string; effort?: string } }
  | { type: 'task.cancel'; id: string }
  /** Stop a collaboration: the running turn is cancelled and no further turn starts. */
  | { type: 'team.cancel'; id: string }
  /**
   * Reply to the agent of a finished task: it continues in the same session, with what it
   * already knows. Only the task id is sent; the daemon finds the session itself.
   */
  | { type: 'task.reply'; taskId: string; prompt: string; access: Access; model?: string; effort?: string; requestId?: string }
  /** Save a task's full answer into its project folder (a path inside the task's folder). */
  | { type: 'artifact.save'; taskId: string; path: string; format?: 'md' | 'txt'; requestId?: string }
  | ClientMessage15;

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

// ───────────────────────── land.inc 1.5 ─────────────────────────

/** A model as the unified catalog lists it: one entry per CLI model, with what it can do. */
export interface CatalogModel extends ModelOption {
  executor: Executor;
  /** Where the entry came from: the CLI's own cache/config, a CLI listing command, or the built-in list. */
  origin: 'cache' | 'config' | 'cli' | 'builtin';
  /** Short capability badges, e.g. "reasoning", "fast", "vision", "alias". */
  badges?: string[];
}

export interface ModelCatalog {
  models: CatalogModel[];
  scannedAt: number;
  /** Per-CLI problems while scanning (missing cache, `agy models` failed…). */
  notes: Partial<Record<Executor, string>>;
}

export type AgentRoleId = 'writer' | 'critic' | 'editor' | 'architect' | 'coder' | 'security' | 'custom';

export const ROLE_LABEL: Record<AgentRoleId, string> = {
  writer: 'Писатель', critic: 'Критик', editor: 'Редактор', architect: 'Архитектор', coder: 'Кодер', security: 'Безопасник', custom: 'Своя роль',
};

export type TemperaturePreset = 'strict' | 'balanced' | 'creative';
export const TEMPERATURE: Record<TemperaturePreset, number> = { strict: 0.1, balanced: 0.5, creative: 0.85 };

export type OverflowStrategy = 'compact' | 'trim' | 'file';

/** «Тонкие настройки работы»: shared by custom agents and by single team steps. */
export interface AdvancedSettings {
  temperature: TemperaturePreset;
  contextBudget: { maxInputChars: number; maxOutputChars: number; overflow: OverflowStrategy };
  /** 0–3 automatic retries on network / CLI failures, exponential pause. */
  retries: 0 | 1 | 2 | 3;
  /** Step timeout in ms; null means no limit. */
  timeoutMs: number | null;
  allowedPaths: string[];
  ignoredPaths: string[];
  /** Extra CLI flags, each one from the provider's allow-list (see ALLOWED_CLI_FLAGS). */
  cliFlags: string[];
}

export const DEFAULT_ADVANCED: AdvancedSettings = {
  temperature: 'balanced',
  contextBudget: { maxInputChars: 400_000, maxOutputChars: 400_000, overflow: 'compact' },
  retries: 1,
  timeoutMs: 15 * 60_000,
  allowedPaths: [],
  ignoredPaths: [],
  cliFlags: [],
};

/**
 * «Указать кастомный ID модели…» (a local proxy): only a plain identifier, never starting with «-»,
 * since it ends up as a CLI argument.
 */
export function isCustomModelId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][\w.\-:/@[\]]{0,119}$/.test(id);
}

export const TIMEOUT_CHOICES: (number | null)[] = [2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, null];

/** Flags a user may add to a CLI run; anything else is refused by the daemon. */
export const ALLOWED_CLI_FLAGS: Record<Executor, string[]> = {
  claude: ['--verbose', '--fallback-model', '--max-turns'],
  codex: ['--search', '--oss'],
  antigravity: ['--verbose', '--no-color'],
};

export type McpId = 'markitdown' | 'context-budget' | 'strategic-compact' | 'agentic-shield';
export const MCP_IDS: McpId[] = ['markitdown', 'context-budget', 'strategic-compact', 'agentic-shield'];

export interface McpStatus {
  id: McpId;
  state: 'active' | 'missing' | 'installing' | 'failed';
  enabled: boolean;
  version?: string;
  message?: string;
}

export interface Appearance {
  /** Outfit colour, CSS hex. */
  outfit: string;
  accessory: 'none' | 'glasses' | 'headphones' | 'scarf' | 'cap' | 'badge';
}

/** A custom employee (CrewAI-style role / goal / backstory / expected output). */
export interface AgentProfile {
  id: string;
  name: string;
  role: AgentRoleId;
  /** Role title when role is 'custom'. */
  roleTitle?: string;
  goal: string;
  backstory: string;
  expectedOutputFormat: string;
  executor: Executor;
  model: string;
  effort?: string;
  access: Access;
  appearance: Appearance;
  mcp: McpId[];
  advanced: AdvancedSettings;
  createdAt: number;
  updatedAt: number;
}
export type AgentProfileDraft = Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

// ── Teams (Переговорка 1.5) ──

export type Topology = 'sequential' | 'critic-loop' | 'council' | 'manager';

export type ArtifactKind =
  | 'ArchitectureSpec' | 'ImplementationDiff' | 'VerificationReport' | 'SecurityAudit'
  | 'ChapterOutline' | 'ChapterDraft' | 'ContinuityAndLogicCritique' | 'StylisticPolishedManuscript'
  | 'Synthesis' | 'Plan' | 'Generic';

export type Verdict = 'APPROVED' | 'NEEDS_REVISION';

/** MetaGPT-style typed deliverable a step hands to the next one. */
export interface StepArtifact {
  kind: ArtifactKind;
  /** Step that produced it. */
  stepIndex: number;
  iteration: number;
  content: string;
  verdict?: Verdict;
  /** Characters, for the context meter. */
  size: number;
  at: number;
}

export type StepKind = 'worker' | 'critic' | 'fixer' | 'synthesizer' | 'manager';

export interface TeamStepSpec {
  /** Custom agent the step uses, when picked from «Сотрудники». */
  agentId?: string;
  title: string;
  executor: Executor;
  model: string;
  effort?: string;
  access: Access;
  /** What the step must produce. */
  produces: ArtifactKind;
  /** Role in the topology. */
  kind: StepKind;
  advanced?: AdvancedSettings;
}

export interface TeamStep extends TeamStepSpec {
  status: TurnStatus;
  attempts: number;
  taskId?: string;
  error?: string;
}

/** State saved after every finished step: a run resumes from here (LangGraph-style). */
export interface TeamCheckpoint {
  stepIndex: number;
  iteration: number;
  artifacts: StepArtifact[];
  at: number;
}

export interface TeamRun {
  id: string;
  prompt: string;
  cwd: string;
  topology: Topology;
  /** ChatDev-style immutable anchor (world passport, glossary, API invariants) passed to every step. */
  anchor: string;
  maxIterations: number;
  steps: TeamStep[];
  artifacts: StepArtifact[];
  checkpoints: TeamCheckpoint[];
  iteration: number;
  /** Step currently running (or the failed one). */
  current?: number;
  status: 'running' | 'stopping' | 'done' | 'failed' | 'stopped';
  createdAt: number;
  finishedAt?: number;
  result?: string;
  reason?: string;
  presetId?: string;
}

export interface NewTeamRun {
  prompt: string;
  cwd: string;
  topology: Topology;
  anchor?: string;
  maxIterations?: number;
  steps: TeamStepSpec[];
  presetId?: string;
}

export interface WorkflowPreset {
  id: string;
  name: string;
  description: string;
  topology: Topology;
  steps: TeamStepSpec[];
  builtin?: boolean;
}

// ── Settings (Настройки 1.5) ──

export interface LandSettings {
  general: {
    theme: 'system' | 'dark' | 'light';
    /** 0.8 – 1.4 */
    uiScale: number;
    fps: 30 | 60;
    backgroundPowerSave: boolean;
    residents: 'on' | 'calm' | 'off';
    soundOnFinish: boolean;
    browserNotifications: boolean;
  };
  providers: Record<Executor, { pathOverride?: string }>;
  mcp: { enabled: Record<McpId, boolean>; compactThresholdChars: number };
  teams: { maxConcurrentTasks: number; artifactsDir: string; autosaveDrafts: boolean; captureLimitChars: number };
  security: { shieldEnabled: boolean };
}

export const DEFAULT_SETTINGS: LandSettings = {
  general: { theme: 'system', uiScale: 1, fps: 60, backgroundPowerSave: true, residents: 'on', soundOnFinish: false, browserNotifications: false },
  providers: { claude: {}, codex: {}, antigravity: {} },
  mcp: { enabled: { markitdown: true, 'context-budget': true, 'strategic-compact': true, 'agentic-shield': true }, compactThresholdChars: 300_000 },
  teams: { maxConcurrentTasks: 3, artifactsDir: '', autosaveDrafts: true, captureLimitChars: 400_000 },
  security: { shieldEnabled: true },
};

export interface ProviderInfo {
  executor: Executor;
  available: boolean;
  /** Resolved binary / entry point. */
  path?: string;
  version?: string;
  note?: string;
}

export interface DoctorCheck {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** Present when the daemon can fix it itself («Исправить автоматически»). */
  fix?: string;
}

export interface ConversationMeta {
  /** Root task id of the conversation. */
  id: string;
  title?: string;
  pinned?: boolean;
}

export interface BackupFile {
  format: 'land-backup';
  version: '1.5';
  exportedAt: number;
  settings: LandSettings;
  agents: AgentProfile[];
  presets: WorkflowPreset[];
  conversations: ConversationMeta[];
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type ServerMessage15 =
  | { type: 'models:updated'; catalog: ModelCatalog }
  | { type: 'agents'; agents: AgentProfile[] }
  | { type: 'settings'; settings: LandSettings; providers: ProviderInfo[]; mcp: McpStatus[] }
  | { type: 'mcp'; mcp: McpStatus[] }
  | { type: 'teams'; runs: TeamRun[]; presets: WorkflowPreset[] }
  | { type: 'team:updated'; run: TeamRun }
  | { type: 'conversations.meta'; meta: ConversationMeta[] }
  | { type: 'doctor'; checks: DoctorCheck[]; at: number }
  | { type: 'backup'; requestId: string; backup?: BackupFile; error?: string }
  | { type: 'ack'; requestId: string; ok: boolean; message?: string };

export type ClientMessage15 =
  | { type: 'models.rescan' }
  | { type: 'agents.save'; agent: AgentProfileDraft; requestId?: string }
  | { type: 'agents.delete'; id: string }
  | { type: 'agents.duplicate'; id: string }
  | { type: 'settings.update'; patch: DeepPartial<LandSettings>; requestId?: string }
  | { type: 'mcp.install'; id: McpId }
  | { type: 'team.start'; run: NewTeamRun; requestId?: string }
  | { type: 'team.resume'; id: string; fromStep: number; override?: Partial<Pick<TeamStepSpec, 'executor' | 'model' | 'effort'>>; requestId?: string }
  | { type: 'team.stop'; id: string }
  | { type: 'preset.save'; preset: WorkflowPreset; requestId?: string }
  | { type: 'preset.delete'; id: string }
  | { type: 'conversation.meta'; meta: ConversationMeta }
  | { type: 'doctor.run' }
  | { type: 'doctor.fix'; id: string }
  | { type: 'backup.export'; requestId: string }
  | { type: 'backup.import'; requestId: string; backup: BackupFile }
  | { type: 'token.rotate'; requestId?: string }
  | { type: 'cache.clear'; requestId?: string };
