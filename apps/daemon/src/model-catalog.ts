import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CatalogModel, ModelCatalog } from '@land/protocol';
import { cliFailure, stripAnsi } from './ansi.ts';
import { jsonFile, record } from './json-store.ts';
import { findAgy } from './executors/files.ts';
import type { Command } from './executors/types.ts';

const exec = promisify(execFile);
const slug = /^[a-z\d][a-z\d._:/-]{0,199}$/i;
const validSlug = (value: unknown): value is string => typeof value === 'string' && slug.test(value);
const basic = ['low', 'medium', 'high'];
const extended = [...basic, 'xhigh'];
const agyEfforts = basic;
const model = (executor: CatalogModel['executor'], origin: CatalogModel['origin'], id: string, label = id, efforts?: string[]): CatalogModel =>
  ({ executor, origin, id, label, ...(efforts?.length ? { efforts, badges: ['reasoning'] } : {}) });

function claudeEfforts(id: string): string[] | undefined {
  if (/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(id)) return basic;
  if (/^claude-(?:(?:opus|sonnet)-[5-9]|(?:haiku|fable)-5|opus-4-[78])/.test(id)) return extended;
}

const claudeBuiltins = [
  ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-opus-4-6', 'Opus 4.6'], ['claude-sonnet-4-6', 'Sonnet 4.6'], ['claude-haiku-4-5', 'Haiku 4.5'], ['claude-3-7-sonnet-latest', 'Sonnet 3.7'],
];

export function claudeModels(home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): CatalogModel[] {
  const settings = record(jsonFile(join(home, 'settings.json')));
  const env = record(settings?.env);
  const modelSetting = (key: string) => /^ANTHROPIC_(?:MODEL|DEFAULT_MODEL|DEFAULT_\w+_MODEL|SMALL_FAST_MODEL|REASONING_MODEL)$/.test(key);
  const configured = (value: unknown): value is string => typeof value === 'string' && validSlug(value.replace(/\[1m\]$/, ''));
  const models = new Map(claudeBuiltins.map(([id, label]) => [id, model('claude', 'builtin', id, label, claudeEfforts(id))]));
  for (const id of [settings?.model, settings?.fallbackModel, ...Object.entries(env ?? {}).filter(([key]) => modelSetting(key)).map(([, value]) => value)]) {
    if (configured(id) && !models.has(id)) models.set(id, model('claude', 'config', id, id, claudeEfforts(id.replace(/\[1m\]$/, ''))));
  }
  for (const alias of ['opus', 'sonnet', 'haiku']) {
    const target = env?.['ANTHROPIC_DEFAULT_' + alias.toUpperCase() + '_MODEL'];
    const item = model('claude', 'builtin', alias, alias, claudeEfforts(configured(target) ? target.replace(/\[1m\]$/, '') : 'claude-' + alias + '-5-5'));
    item.badges = [...(item.badges ?? []), 'alias'];
    models.set(alias, item);
  }
  return [...models.values()];
}

function codexProfiles(home: string): { id: string; effort?: string }[] {
  let text: string;
  try { text = readFileSync(join(home, 'config.toml'), 'utf8'); } catch { return []; }
  const profiles = new Map<string, { id?: string; effort?: string }>();
  let section = '';
  let multiline = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (multiline) {
      if (line.includes(multiline)) multiline = '';
      continue;
    }
    const triple = line.match(/^[^#=]+=\s*("""|''')(.*)$/);
    if (triple) {
      if (!triple[2].includes(triple[1])) multiline = triple[1];
      continue;
    }
    const header = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (line.startsWith('[')) { section = header?.[1].trim() ?? '-'; continue; }
    if (section && !/^profiles\s*\.\s*(?:[\w-]+|"[^"]+"|'[^']+')$/.test(section)) continue;
    const entry = line.match(/^(model|model_reasoning_effort)\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:#.*)?$/);
    if (!entry || !validSlug(entry[2] ?? entry[3])) continue;
    const values = profiles.get(section) ?? {};
    values[entry[1] === 'model' ? 'id' : 'effort'] = entry[2] ?? entry[3];
    profiles.set(section, values);
  }
  const root = profiles.get('');
  return [...profiles.values()].flatMap(({ id, effort }) => id ?? root?.id ? [{ id: (id ?? root?.id)!, effort }] : []);
}

/** The provider's local cache describes capabilities, not account entitlement. */
export function codexModels(home = process.env.CODEX_HOME ?? join(homedir(), '.codex')): CatalogModel[] {
  const cache = record(jsonFile(join(home, 'models_cache.json')));
  const models = new Map<string, CatalogModel>();
  const hidden = new Set<string>();
  for (const raw of Array.isArray(cache?.models) ? cache.models : []) {
    const row = record(raw);
    if (!row || !validSlug(row.slug)) continue;
    if (row.visibility === 'hide' || row.supported_in_api === false) { hidden.add(row.slug); continue; }
    const efforts = Array.isArray(row.supported_reasoning_levels)
      ? [...new Set(row.supported_reasoning_levels.map((value: unknown) => record(value)?.effort ?? value).filter(validSlug))] : [];
    const item = model('codex', 'cache', row.slug, typeof row.display_name === 'string' ? row.display_name : row.slug, efforts);
    if (typeof row.default_reasoning_level === 'string' && efforts.includes(row.default_reasoning_level)) item.defaultEffort = row.default_reasoning_level;
    models.set(item.id, item);
  }
  for (const { id, effort } of codexProfiles(home)) {
    if (hidden.has(id) || models.get(id)?.origin === 'cache') continue;
    const efforts = [...new Set([...(models.get(id)?.efforts ?? []), ...(effort ? [effort] : [])])];
    models.set(id, model('codex', 'config', id, id, efforts));
  }
  return [...models.values()];
}

const agyBuiltins = [
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)'],
].map(([id, label]) => model('antigravity', 'builtin', id, label, agyEfforts));

export function parseAgyModels(output: string): CatalogModel[] {
  return stripAnsi(output).split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([a-z\d][a-z\d._-]+)(?:\t+| {2,})(.+)$/i);
    return match && !/^(model|slug|id|name)$/i.test(match[1])
      ? [model('antigravity', 'cli', match[1], match[2].trim(), agyEfforts)] : [];
  });
}

function agyMetadata(home: string): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const file of ['models.json', 'cache/models.json', 'settings.json', 'config.json']) {
    const data = jsonFile(join(home, file));
    const root = record(data);
    const rows: unknown[] = Array.isArray(data) ? data : Array.isArray(root?.models) ? root.models : [root?.model];
    for (const raw of rows) {
      const row = record(raw);
      const id = row?.id ?? row?.slug ?? raw;
      if (!validSlug(id)) continue;
      const label = row?.display_name ?? row?.label;
      const efforts = Array.isArray(row?.efforts) ? agyEfforts.filter((effort) => (row.efforts as unknown[]).includes(effort)) : agyEfforts;
      models.set(id, model('antigravity', 'cache', id, typeof label === 'string' ? label : id, efforts));
    }
  }
  return [...models.values()];
}

export interface ModelCatalogOptions {
  claudeHome?: string;
  codexHome?: string;
  antigravityHome?: string;
  antigravityCommand?: () => Command | undefined;
  timeoutMs?: number;
  modelsOverride?: CatalogModel[];
}

export class ModelCatalogService {
  private current?: ModelCatalog;
  private scanning?: Promise<ModelCatalog>;
  private options: ModelCatalogOptions;
  constructor(options: ModelCatalogOptions = {}) { this.options = options; }

  private local(): ModelCatalog {
    if (this.options.modelsOverride) return { models: structuredClone(this.options.modelsOverride), scannedAt: Date.now(), notes: {} };
    const codex = codexModels(this.options.codexHome);
    const agy = agyMetadata(this.options.antigravityHome ?? join(homedir(), '.gemini', 'antigravity'));
    const fallback = new Map([...agyBuiltins, ...agy].map((entry) => [entry.id, entry]));
    return {
      models: [...claudeModels(this.options.claudeHome), ...codex, ...fallback.values()],
      scannedAt: Date.now(),
      notes: codex.length ? {} : { codex: 'В кеше и конфигурации Codex нет моделей' },
    };
  }

  get(): ModelCatalog { return this.current ??= this.local(); }

  rescan(restart = false): Promise<ModelCatalog> {
    if (this.scanning) return restart ? this.scanning.then(() => this.rescan()) : this.scanning;
    this.scanning = this.scan().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  private async scan(): Promise<ModelCatalog> {
    const next = this.local();
    if (this.options.modelsOverride) return this.current = next;
    try {
      const cmd = (this.options.antigravityCommand ?? findAgy)();
      if (!cmd) throw new Error('Antigravity CLI (agy) не найден');
      const { stdout } = await exec(cmd.command, [...cmd.args, 'models'], {
        encoding: 'utf8', shell: false, windowsHide: true, timeout: this.options.timeoutMs ?? 950, maxBuffer: 1024 * 1024,
      });
      const found = parseAgyModels(stdout);
      if (!found.length) throw new Error(cliFailure('agy', stdout)?.text ?? 'agy models не вернул список моделей');
      const metadata = next.models.filter((entry) => entry.executor === 'antigravity' && entry.origin === 'cache');
      const agy = new Map([...metadata, ...found].map((entry) => [entry.id, entry]));
      next.models = [...next.models.filter((entry) => entry.executor !== 'antigravity'), ...agy.values()];
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string };
      next.notes.antigravity = cliFailure('agy', e.stdout, e.stderr)?.text ??
        (e.stdout !== undefined || e.stderr !== undefined ? 'Не удалось получить список моделей через agy models' : e.message);
    }
    next.scannedAt = Date.now();
    return this.current = next;
  }
}
