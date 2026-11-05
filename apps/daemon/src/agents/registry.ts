import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentPersona } from '@land/protocol';

const MAX_PROMPT = 40_000;
const DEFAULT_MCP = ['markitdown', 'context-budget', 'strategic-compact', 'agentic-shield'];

export interface AgentRegistryOptions { file?: string | null; }

function validate(input: Partial<AgentPersona>): void {
  if (!input.name?.trim() || input.name.length > 120) throw new Error('Имя агента должно быть от 1 до 120 символов');
  if (!['claude', 'codex', 'antigravity'].includes(input.provider ?? '')) throw new Error('Неизвестный провайдер агента');
  if (!input.model?.trim() || input.model.length > 200) throw new Error('Укажите модель агента');
  if (!['low', 'medium', 'high', 'xhigh'].includes(input.reasoningEffort ?? '')) throw new Error('Неизвестный уровень рассуждений');
  if (!['writer', 'coder', 'reviewer', 'editor', 'planner', 'security', 'custom'].includes(input.roleType ?? '')) throw new Error('Неизвестная роль агента');
  if (!input.characterAndSystemPrompt?.trim() || input.characterAndSystemPrompt.length > MAX_PROMPT) throw new Error(`Системный промпт должен быть от 1 до ${MAX_PROMPT} символов`);
  if (!['read-only', 'workspace-write'].includes(input.defaultAccessMode ?? '')) throw new Error('Неизвестный режим доступа агента');
}

function defaults(input: Partial<AgentPersona>): AgentPersona {
  const now = Date.now();
  return {
    id: input.id ?? randomUUID(),
    name: input.name ?? 'Новый агент',
    provider: input.provider ?? 'codex',
    model: input.model ?? 'gpt-6.1-sol',
    reasoningEffort: input.reasoningEffort ?? 'medium',
    roleType: input.roleType ?? 'custom',
    characterAndSystemPrompt: input.characterAndSystemPrompt ?? 'Работай точно, проверяй входные данные и описывай результат кратко.',
    defaultAccessMode: input.defaultAccessMode ?? 'read-only',
    avatarConfig: input.avatarConfig ?? { outfitColor: '#4f7b68', accessory: 'none' },
    mandatoryMcpServers: [...new Set(input.mandatoryMcpServers ?? DEFAULT_MCP)],
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}

export const BUILTIN_AGENT_PRESETS: AgentPersona[] = [
  defaults({ id: 'preset-architect', name: 'Архитектор', provider: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'high', roleType: 'planner', defaultAccessMode: 'read-only', characterAndSystemPrompt: 'Проектируй простые проверяемые решения, фиксируй контракты и риски.' }),
  defaults({ id: 'preset-senior-coder', name: 'Senior Coder', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', roleType: 'coder', defaultAccessMode: 'workspace-write', characterAndSystemPrompt: 'Пиши production-ready код, валидируй границы и запускай необходимые проверки.' }),
  defaults({ id: 'preset-security-reviewer', name: 'QA и Security Reviewer', provider: 'claude', model: 'claude-opus-4-6', reasoningEffort: 'high', roleType: 'security', defaultAccessMode: 'read-only', characterAndSystemPrompt: 'Ищи уязвимости, регрессии и нарушения контрактов, формулируй воспроизводимые замечания.' }),
  defaults({ id: 'preset-author', name: 'Ведущий Автор', provider: 'claude', model: 'claude-opus-4-6', reasoningEffort: 'high', roleType: 'writer', defaultAccessMode: 'workspace-write', characterAndSystemPrompt: 'Пиши связный текст с устойчивым голосом, сохраняя лор и факты проекта.' }),
  defaults({ id: 'preset-fact-checker', name: 'Логик и Фактчекер сюжета', provider: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'high', roleType: 'reviewer', defaultAccessMode: 'read-only', characterAndSystemPrompt: 'Проверяй причинность, факты, противоречия и непрерывность сюжета.' }),
  defaults({ id: 'preset-editor', name: 'Литературный Редактор и Стилист', provider: 'antigravity', model: 'agy-default', reasoningEffort: 'medium', roleType: 'editor', defaultAccessMode: 'workspace-write', characterAndSystemPrompt: 'Полируй стиль, ясность и ритм, сохраняя смысл и авторский голос.' }),
];

export class AgentRegistry {
  private agents: AgentPersona[] = [];
  private readonly file: string | null;

  constructor(options: AgentRegistryOptions = {}) {
    this.file = options.file === undefined ? join(homedir(), '.land', 'agents.json') : options.file;
    this.loadSync();
  }

  list(): AgentPersona[] { return this.agents.map((agent) => structuredClone(agent)); }

  get(id: string): AgentPersona | undefined { const found = this.agents.find((agent) => agent.id === id); return found ? structuredClone(found) : undefined; }

  create(input: Partial<AgentPersona>): AgentPersona {
    const agent = defaults(input);
    validate(agent);
    if (this.agents.some((item) => item.id === agent.id)) throw new Error('Агент с таким id уже существует');
    this.agents = [...this.agents, agent];
    this.saveSync();
    return structuredClone(agent);
  }

  update(id: string, patch: Partial<AgentPersona>): AgentPersona {
    const current = this.agents.find((agent) => agent.id === id);
    if (!current) throw new Error('Агент не найден');
    const next = defaults({ ...current, ...patch, id: current.id, createdAt: current.createdAt });
    validate(next);
    this.agents = this.agents.map((agent) => agent.id === id ? next : agent);
    this.saveSync();
    return structuredClone(next);
  }

  clone(id: string, name?: string): AgentPersona {
    const source = this.get(id);
    if (!source) throw new Error('Агент не найден');
    return this.create({ ...source, id: randomUUID(), name: name ?? `${source.name} (копия)` });
  }

  remove(id: string): void {
    if (!this.agents.some((agent) => agent.id === id)) throw new Error('Агент не найден');
    this.agents = this.agents.filter((agent) => agent.id !== id);
    this.saveSync();
  }

  exportJson(): string { return JSON.stringify(this.agents, null, 2); }

  importJson(raw: string): AgentPersona[] {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 200) throw new Error('Некорректный список агентов');
    const imported = parsed.map((item) => {
      if (!item || typeof item !== 'object') throw new Error('Некорректный профиль агента');
      const agent = defaults(item as Partial<AgentPersona>);
      validate(agent);
      return agent;
    });
    this.agents = imported;
    this.saveSync();
    return this.list();
  }

  private loadSync(): void {
    if (!this.file) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.agents = parsed.map((item) => defaults(item as Partial<AgentPersona>)).filter((agent) => { try { validate(agent); return true; } catch { return false; } });
    } catch {
      this.agents = [...BUILTIN_AGENT_PRESETS];
    }
  }

  private saveSync(): void {
    if (!this.file) return;
    const path = this.file;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify(this.agents, null, 2), 'utf8');
      renameSync(temp, path);
    } catch (error) {
      throw new Error(`Не удалось сохранить профили агентов: ${(error as Error).message}`);
    }
  }
}

