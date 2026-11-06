import { DEFAULT_SETTINGS, MCP_IDS, type BackupFile, type ConversationMeta, type DeepPartial, type LandSettings, type WorkflowPreset } from '@land/protocol';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { type AgentService, executorId, integer, text, validAdvanced, validAgents } from './agents.ts';
import { readJson, record, type Validator, writeJson } from './json-store.ts';

export const LAND_HOME = process.env.LAND_HOME ?? join(homedir(), '.land');

type Rule = (value: unknown) => boolean;
type Rules = { [key: string]: Rule | Rules };
const oneOf = (...values: unknown[]): Rule => (value) => values.includes(value);
const bool: Rule = (value) => typeof value === 'boolean';
const path: Rule = (value) => text(value, 4096) && (!value || isAbsolute(value));
const rules: Rules = {
  general: {
    theme: oneOf('system', 'dark', 'light'),
    uiScale: (v) => typeof v === 'number' && v >= 0.8 && v <= 1.4,
    fps: oneOf(30, 60),
    backgroundPowerSave: bool, residents: oneOf('on', 'calm', 'off'), soundOnFinish: bool, browserNotifications: bool,
  },
  providers: { claude: { pathOverride: path }, codex: { pathOverride: path }, antigravity: { pathOverride: path } },
  mcp: { enabled: Object.fromEntries(MCP_IDS.map((id) => [id, bool])), compactThresholdChars: (v) => integer(v, 1, 2_000_000) },
  teams: { maxConcurrentTasks: (v) => integer(v, 1, 8), artifactsDir: path, autosaveDrafts: bool, captureLimitChars: (v) => integer(v, 200_000, 2_000_000) },
  security: { shieldEnabled: bool },
};

function merge(base: object, input: unknown, schema: Rules, parent = ''): object {
  const value = record(input);
  if (!value) throw new Error('Некорректные настройки ' + parent);
  const result: Record<string, unknown> = { ...base };
  for (const [key, field] of Object.entries(value)) {
    const name = parent + key;
    const rule = Object.hasOwn(schema, key) ? schema[key] : undefined;
    if (!rule) throw new Error('Неизвестная настройка ' + name);
    if (typeof rule !== 'function') result[key] = merge(record(result[key]) ?? {}, field, rule, name + '.');
    else if (rule(field)) result[key] = field;
    else throw new Error('Некорректное значение ' + name);
  }
  return result;
}

export function mergeSettings(input: unknown, base = DEFAULT_SETTINGS): LandSettings {
  return merge(base, input, rules) as LandSettings;
}
const settingsPatch: Validator<DeepPartial<LandSettings>> = (v): v is DeepPartial<LandSettings> => {
  try { mergeSettings(v); return true; } catch { return false; }
};

function validMeta(value: unknown): value is ConversationMeta {
  const v = record(value);
  return !!v && text(v.id, 100, true) && (v.title === undefined || text(v.title, 200)) &&
    (v.pinned === undefined || typeof v.pinned === 'boolean');
}
const validMetaList = (v: unknown): v is ConversationMeta[] =>
  Array.isArray(v) && v.every(validMeta) && new Set(v.map((meta) => meta.id)).size === v.length;

export function validPresets(value: unknown): value is WorkflowPreset[] {
  return Array.isArray(value) && value.every((item) => {
    const v = record(item);
    return !!v && text(v.id, 100, true) && text(v.name, 160, true) && text(v.description, 12_000) &&
      (v.builtin === undefined || typeof v.builtin === 'boolean') &&
      typeof v.topology === 'string' && ['sequential', 'critic-loop', 'council', 'manager'].includes(v.topology) &&
      Array.isArray(v.steps) && v.steps.length > 0 && v.steps.every((step: unknown) => {
        const s = record(step);
        return !!s && executorId(s.executor) && text(s.title, 160, true) && text(s.model, 200, true) &&
          (s.agentId === undefined || text(s.agentId, 100, true)) && (s.effort === undefined || text(s.effort, 30, true)) &&
          (s.access === 'read' || s.access === 'write') && typeof s.kind === 'string' && ['worker', 'critic', 'fixer', 'synthesizer', 'manager'].includes(s.kind) &&
          typeof s.produces === 'string' && ['ArchitectureSpec', 'ImplementationDiff', 'VerificationReport', 'SecurityAudit', 'ChapterOutline', 'ChapterDraft',
            'ContinuityAndLogicCritique', 'StylisticPolishedManuscript', 'Synthesis', 'Plan', 'Generic'].includes(s.produces) &&
          (s.advanced === undefined || validAdvanced(s.advanced, s.executor));
      });
  }) && new Set(value.map((v: WorkflowPreset) => v.id)).size === value.length;
}

class Collection<T> {
  private data: T;
  private file: string | null;
  private valid: Validator<T>;
  constructor(file: string | null, initial: T, valid: Validator<T>) {
    this.file = file;
    this.valid = valid;
    this.data = file ? readJson(file, valid) ?? initial : initial;
  }
  get(): T { return structuredClone(this.data); }
  replace(data: T): void {
    if (!this.valid(data)) throw new Error('Некорректные данные');
    if (this.file) writeJson(this.file, data, this.valid);
    this.data = structuredClone(data);
  }
}

export class SettingsService {
  private settings: Collection<DeepPartial<LandSettings>>;
  private conversations: Collection<ConversationMeta[]>;
  private presets: Collection<WorkflowPreset[]>;
  constructor(home: string | null = LAND_HOME) {
    const file = (name: string) => home === null ? null : join(home, name + '.json');
    this.settings = new Collection(file('settings'), {}, settingsPatch);
    this.conversations = new Collection(file('conversations'), [], validMetaList);
    this.presets = new Collection(file('presets'), [], validPresets);
  }

  get(): LandSettings { return mergeSettings(this.settings.get(), structuredClone(DEFAULT_SETTINGS)); }
  update(patch: DeepPartial<LandSettings>): void { this.settings.replace(mergeSettings(patch, this.get())); }
  listPresets(): WorkflowPreset[] { return this.presets.get(); }
  replacePresets(list: WorkflowPreset[]): void { this.presets.replace(list); }
  meta(): ConversationMeta[] { return this.conversations.get(); }
  setMeta(meta: ConversationMeta): void {
    if (!validMeta(meta)) throw new Error('Некорректные метаданные разговора');
    const list = this.meta();
    const old = list.find((item) => item.id === meta.id);
    const next = { id: meta.id, title: meta.title === undefined ? old?.title : meta.title.trim(), pinned: meta.pinned ?? old?.pinned };
    this.conversations.replace([...list.filter((item) => item.id !== meta.id), next]);
  }

  exportBackup(agents: AgentService, presets = this.listPresets()): BackupFile {
    return { format: 'land-backup', version: '1.5', exportedAt: Date.now(), settings: this.get(),
      agents: agents.list(), presets, conversations: this.meta() };
  }

  importBackup(value: unknown, agents: AgentService): boolean {
    const v = record(value);
    if (!v || v.format !== 'land-backup' || v.version !== '1.5' || !integer(v.exportedAt, 0, Number.MAX_SAFE_INTEGER) ||
      !validAgents(v.agents) || !validPresets(v.presets) || !validMetaList(v.conversations)) throw new Error('Некорректный файл резервной копии 1.5');
    const next = mergeSettings(v.settings);
    const previous = this.exportBackup(agents);
    const ignoredOverrides = Object.keys(next.providers).some((id) => executorId(id) &&
      next.providers[id].pathOverride !== previous.settings.providers[id].pathOverride);
    // A backup is data. Importing it cannot select a local executable to launch.
    next.providers = previous.settings.providers;
    const rollback: (() => void)[] = [];
    try {
      this.settings.replace(next);
      rollback.push(() => this.settings.replace(previous.settings));
      agents.replace(v.agents);
      rollback.push(() => agents.replace(previous.agents));
      this.presets.replace(v.presets);
      rollback.push(() => this.presets.replace(previous.presets));
      this.conversations.replace(v.conversations);
    } catch (error) {
      const failures: unknown[] = [];
      for (const undo of rollback.reverse()) try { undo(); } catch (failure) { failures.push(failure); }
      if (failures.length) throw new AggregateError([error, ...failures], 'Не удалось полностью восстановить настройки после ошибки импорта');
      throw error;
    }
    return ignoredOverrides;
  }
}
