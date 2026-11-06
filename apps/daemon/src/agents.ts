import { randomUUID } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ALLOWED_CLI_FLAGS, DEFAULT_ADVANCED, MCP_IDS, ROLE_LABEL, isCustomModelId, type AgentRoleId, type Appearance, type McpId, type AgentProfile, type AgentProfileDraft, type AdvancedSettings } from '@land/protocol';
import { jsonFile, readJson, record, writeJson } from './json-store.ts';
import type { ModelCatalogService } from './model-catalog.ts';

export const text = (v: unknown, max: number, required = false): v is string =>
  typeof v === 'string' && v.length <= max && (!required || !!v.trim()) && !v.includes('\0');
export const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export const executorId = (v: unknown): v is AgentProfile['executor'] => v === 'claude' || v === 'codex' || v === 'antigravity';
const strings = (v: unknown, max: number, length: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((value) => text(value, length, true));

export function validAdvanced(value: unknown, executor: AgentProfile['executor']): value is AdvancedSettings {
  const v = record(value);
  const budget = record(v?.contextBudget);
  return !!v && !!budget && typeof v.temperature === 'string' && ['strict', 'balanced', 'creative'].includes(v.temperature) &&
    integer(budget.maxInputChars, 1, 2_000_000) && integer(budget.maxOutputChars, 1, 2_000_000) &&
    typeof budget.overflow === 'string' && ['compact', 'trim', 'file'].includes(budget.overflow) && integer(v.retries, 0, 3) &&
    (v.timeoutMs === null || integer(v.timeoutMs, 1, 24 * 60 * 60_000)) &&
    strings(v.allowedPaths, 100, 4096) && strings(v.ignoredPaths, 100, 4096) &&
    strings(v.cliFlags, 20, 64) && v.cliFlags.every((flag) => ALLOWED_CLI_FLAGS[executor].includes(flag));
}

function validDraft(value: unknown): value is AgentProfileDraft {
  const a = record(value);
  const appearance = record(a?.appearance);
  return !!a && text(a.name, 120, true) && typeof a.role === 'string' && Object.hasOwn(ROLE_LABEL, a.role) &&
    (a.roleTitle === undefined || text(a.roleTitle, 120)) &&
    text(a.goal, 12_000) && text(a.backstory, 12_000) && text(a.expectedOutputFormat, 12_000) &&
    executorId(a.executor) && text(a.model, 200, true) && (a.effort === undefined || text(a.effort, 30, true)) &&
    (a.access === 'read' || a.access === 'write') && !!appearance && typeof appearance.outfit === 'string' &&
    /^#[0-9a-f]{6}$/i.test(appearance.outfit) &&
    typeof appearance.accessory === 'string' && ['none', 'glasses', 'headphones', 'scarf', 'cap', 'badge'].includes(appearance.accessory) &&
    Array.isArray(a.mcp) && a.mcp.every((id) => MCP_IDS.includes(id)) && new Set(a.mcp).size === a.mcp.length &&
    validAdvanced(a.advanced, a.executor) && (a.id === undefined || text(a.id, 100, true));
}

export function validAgents(value: unknown): value is AgentProfile[] {
  return Array.isArray(value) && value.every((a) => {
    const data = record(a);
    return validDraft(a) && !!a.id && integer(data?.createdAt, 0, Number.MAX_SAFE_INTEGER) && integer(data?.updatedAt, 0, Number.MAX_SAFE_INTEGER);
  }) && new Set(value.map((a: AgentProfile) => a.id)).size === value.length;
}

const LEGACY_ROLE: Record<string, AgentRoleId> = {
  writer: 'writer', coder: 'coder', reviewer: 'critic', editor: 'editor', planner: 'architect', security: 'security', custom: 'custom',
};
const LEGACY_ACCESSORY: Record<string, Appearance['accessory']> = {
  glasses: 'glasses', crown: 'cap', beret: 'cap', notebook: 'badge', companion: 'badge', none: 'none',
};

/**
 * land.inc 1.3–1.4 kept «персоны» (provider, roleType, characterAndSystemPrompt…) in the same
 * agents.json. Turn them into 1.5 profiles instead of dropping them; undefined when the file is not that format.
 */
export function migrateLegacyAgents(value: unknown): AgentProfile[] | undefined {
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof record(v)?.characterAndSystemPrompt === 'string')) return undefined;
  const now = Date.now();
  const seen = new Set<string>();
  const out: AgentProfile[] = [];
  for (const item of value) {
    const p = record(item)!;
    const executor = executorId(p.provider) ? p.provider : 'codex';
    const id = typeof p.id === 'string' && p.id && p.id.length <= 100 && !seen.has(p.id) ? p.id : randomUUID();
    seen.add(id);
    const avatar = record(p.avatarConfig);
    const outfit = typeof avatar?.outfitColor === 'string' && /^#[0-9a-f]{6}$/i.test(avatar.outfitColor) ? avatar.outfitColor : '#4f7b68';
    const mcp = Array.isArray(p.mandatoryMcpServers) ? MCP_IDS.filter((m: McpId) => (p.mandatoryMcpServers as unknown[]).includes(m)) : [...MCP_IDS];
    const effort = typeof p.reasoningEffort === 'string' && ['low', 'medium', 'high', 'xhigh'].includes(p.reasoningEffort) ? p.reasoningEffort : undefined;
    out.push({
      id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 120) : 'Сотрудник',
      role: LEGACY_ROLE[String(p.roleType)] ?? 'custom',
      goal: '',
      backstory: String(p.characterAndSystemPrompt).slice(0, 12_000),
      expectedOutputFormat: '',
      executor,
      model: typeof p.model === 'string' && p.model.trim() ? p.model.trim().slice(0, 200) : '',
      ...(effort ? { effort } : {}),
      access: p.defaultAccessMode === 'workspace-write' ? 'write' : 'read',
      appearance: { outfit, accessory: LEGACY_ACCESSORY[String(avatar?.accessory ?? 'none')] ?? 'none' },
      mcp,
      advanced: structuredClone(DEFAULT_ADVANCED),
      createdAt: typeof p.createdAt === 'number' && Number.isSafeInteger(p.createdAt) && p.createdAt >= 0 ? p.createdAt : now,
      updatedAt: now,
    });
  }
  return out.filter((agent) => agent.model);
}

export class AgentService {
  private agents: AgentProfile[];
  private catalog: ModelCatalogService;
  private file: string | null;
  constructor(catalog: ModelCatalogService, file: string | null = join(homedir(), '.land', 'agents.json')) {
    this.catalog = catalog;
    this.file = file;
    const legacy = file ? migrateLegacyAgents(jsonFile(file)) : undefined;
    if (file && legacy && validAgents(legacy)) {
      // Keep the 1.4 file as it was: writeJson's .bak holds only valid 1.5 data.
      copyFileSync(file, file + '.v1.4.bak');
      writeJson(file, legacy, validAgents);
      this.agents = legacy;
    } else this.agents = file ? readJson(file, validAgents) ?? [] : [];
  }

  list(): AgentProfile[] { return structuredClone(this.agents); }
  get(id: string): AgentProfile | undefined { return structuredClone(this.agents.find((agent) => agent.id === id)); }

  private validateModel(agent: AgentProfileDraft): void {
    const model = this.catalog.get().models.find((entry) => entry.executor === agent.executor && entry.id === agent.model);
    if (!model) {
      // «Указать кастомный ID модели…» (a local proxy): allowed, but only a plain identifier, since it becomes a CLI argument.
      if (!isCustomModelId(agent.model)) throw new Error('Некорректный ID модели: ' + String(agent.model).slice(0, 60));
      return;
    }
    if (agent.effort && !model.efforts?.includes(agent.effort)) throw new Error('Модель не поддерживает выбранный уровень рассуждений');
  }

  save(input: AgentProfileDraft): AgentProfile {
    if (!validDraft(input)) throw new Error('Некорректный профиль агента или недопустимый флаг CLI');
    this.validateModel(input);
    const existing = input.id && this.agents.find((agent) => agent.id === input.id);
    if (input.id && !existing) throw new Error('Агент не найден');
    const now = Date.now();
    const agent: AgentProfile = { ...structuredClone(input), name: input.name.trim(), id: input.id ?? randomUUID(),
      createdAt: existing ? existing.createdAt : now, updatedAt: now };
    this.replace(existing ? this.agents.map((item) => item.id === agent.id ? agent : item) : [...this.agents, agent]);
    return structuredClone(agent);
  }

  duplicate(id: string): AgentProfile {
    const agent = this.get(id);
    if (!agent) throw new Error('Агент не найден');
    return this.save({ ...agent, id: undefined, name: agent.name.slice(0, 110) + ' (копия)' });
  }

  delete(id: string): void {
    if (!this.agents.some((agent) => agent.id === id)) throw new Error('Агент не найден');
    this.replace(this.agents.filter((agent) => agent.id !== id));
  }

  replace(agents: AgentProfile[]): void {
    if (!validAgents(agents)) throw new Error('Некорректный список агентов');
    if (this.file) writeJson(this.file, agents, validAgents);
    this.agents = structuredClone(agents);
  }
}
