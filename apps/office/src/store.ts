import {
  DEFAULT_SETTINGS,
  type AgentProfile,
  type CatalogModel,
  type ConversationMeta,
  type DoctorCheck,
  type Executor,
  type LandSettings,
  type McpStatus,
  type ModelCatalog,
  type ProviderInfo,
  type ServerMessage,
  type TeamRun,
  type WorkflowPreset,
} from '@land/protocol';

export type StoreEvent =
  | 'catalog'
  | 'agents'
  | 'settings'
  | 'mcp'
  | 'teams'
  | 'conversations'
  | 'doctor'
  | 'providers.scan';

class AppStore {
  /** The daemon is the only source of models, presets, providers and MCP state: until it answers, lists are empty. */
  catalog: ModelCatalog = { models: [], scannedAt: 0, notes: {} };

  agents: AgentProfile[] = [];
  settings: LandSettings = { ...DEFAULT_SETTINGS };
  providers: ProviderInfo[] = [];
  mcp: McpStatus[] = [];
  teamRuns: TeamRun[] = [];
  teamPresets: WorkflowPreset[] = [];
  private acks = new Map<string, (result: { ok: boolean; message?: string }) => void>();

  /** Wait for the daemon's answer to a request; a silent daemon counts as a failure. */
  expectAck(requestId: string, timeoutMs = 15_000): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(requestId);
        resolve({ ok: false, message: 'Демон не ответил. Проверьте, что офис запущен.' });
      }, timeoutMs);
      this.acks.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /** Returns true when someone was waiting for this answer. */
  resolveAck(requestId: string, ok: boolean, message?: string): boolean {
    const waiter = this.acks.get(requestId);
    if (!waiter) return false;
    this.acks.delete(requestId);
    waiter({ ok, message });
    return true;
  }
  conversationsMeta: ConversationMeta[] = [];
  doctorChecks: DoctorCheck[] = [];
  providerScan?: Omit<Extract<ServerMessage, { type: 'providers.scan' }>, 'type'>;
  scanning = false;

  private listeners: Map<StoreEvent, Set<() => void>> = new Map();

  on(event: StoreEvent, listener: () => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  emit(event: StoreEvent): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        try {
          listener();
        } catch (e) {
          console.error(`Error in store listener for ${event}:`, e);
        }
      }
    }
  }

  setCatalog(catalog: ModelCatalog): void {
    this.catalog = catalog;
    this.emit('catalog');
  }

  setAgents(agents: AgentProfile[]): void {
    this.agents = agents;
    this.emit('agents');
  }

  setSettings(settings: LandSettings, providers?: ProviderInfo[], mcp?: McpStatus[]): void {
    this.settings = settings;
    if (providers) this.providers = providers;
    if (mcp) this.mcp = mcp;
    this.emit('settings');
    if (mcp) this.emit('mcp');
  }

  setMcp(mcp: McpStatus[]): void {
    this.mcp = mcp;
    this.emit('mcp');
  }

  setTeams(runs: TeamRun[], presets: WorkflowPreset[]): void {
    this.teamRuns = runs;
    this.teamPresets = presets;
    this.emit('teams');
  }

  updateTeamRun(run: TeamRun): void {
    const idx = this.teamRuns.findIndex((r) => r.id === run.id);
    if (idx >= 0) this.teamRuns[idx] = run;
    else this.teamRuns.unshift(run);
    this.emit('teams');
  }

  setConversationsMeta(meta: ConversationMeta[]): void {
    this.conversationsMeta = meta;
    this.emit('conversations');
  }

  setDoctorChecks(checks: DoctorCheck[]): void {
    this.doctorChecks = checks;
    this.emit('doctor');
  }

  setProviderScan({ candidates, applied, at }: Extract<ServerMessage, { type: 'providers.scan' }>): void {
    this.providerScan = { candidates, applied, at };
    this.scanning = false;
    this.emit('providers.scan');
  }

  /** Helper to get models for an executor */
  getModels(executor?: Executor): CatalogModel[] {
    if (!executor) return this.catalog.models;
    return this.catalog.models.filter((m) => m.executor === executor);
  }

  /** Find specific model in catalog */
  findModel(id: string, executor?: Executor): CatalogModel | undefined {
    return this.catalog.models.find((m) => m.id === id && (!executor || m.executor === executor));
  }
}

export const store = new AppStore();
