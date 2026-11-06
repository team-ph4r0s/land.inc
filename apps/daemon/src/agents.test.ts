import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_ADVANCED, type AgentProfileDraft } from '@land/protocol';
import { AgentService } from './agents.ts';
import { ModelCatalogService } from './model-catalog.ts';
import { SettingsService } from './settings.ts';

test('agent lifecycle validates models, efforts and flags and persists all role fields', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'land-agents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new ModelCatalogService({ claudeHome: root, codexHome: root, antigravityHome: root });
  const file = join(root, 'agents.json');
  const agents = new AgentService(catalog, file);
  const draft: AgentProfileDraft = { name: 'Ирина', role: 'custom', roleTitle: 'Рецензент',
    goal: 'Проверить факты', backstory: 'Редактор', expectedOutputFormat: 'Таблица',
    executor: 'claude', model: 'claude-opus-4-6', effort: 'medium', access: 'read',
    appearance: { outfit: '#cc00ff', accessory: 'glasses' }, mcp: ['agentic-shield'],
    advanced: { ...DEFAULT_ADVANCED, cliFlags: ['--verbose'] } };
  const original = agents.save(draft);
  const edited = agents.save({ ...draft, id: original.id, goal: 'Найти расхождения' });
  assert.equal(edited.createdAt, original.createdAt);
  const copy = agents.duplicate(edited.id);
  assert.notEqual(copy.id, edited.id);
  assert.equal(copy.goal, 'Найти расхождения');
  // A custom model id is allowed only as a plain identifier: it becomes a CLI argument.
  const custom = agents.save({ ...draft, model: 'local-proxy/model-1' });
  assert.equal(custom.model, 'local-proxy/model-1');
  agents.delete(custom.id);
  assert.throws(() => agents.save({ ...draft, model: 'bad id; rm -rf /' }), /Некорректный ID модели/);
  assert.throws(() => agents.save({ ...draft, effort: 'xhigh' }), /уровень/);
  assert.throws(() => agents.save({ ...draft, advanced: { ...DEFAULT_ADVANCED, cliFlags: ['--dangerously-skip-permissions'] } }), /флаг/);
  agents.delete(original.id);
  assert.deepEqual(new AgentService(catalog, file).list(), [copy]);
  assert.equal(copy.roleTitle, draft.roleTitle);
  assert.equal(copy.backstory, draft.backstory);
  assert.equal(copy.expectedOutputFormat, draft.expectedOutputFormat);
});

test('settings merge nested patches, validate bounds and round-trip backup and conversation metadata', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'land-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agents = new AgentService(new ModelCatalogService(), null);
  const settings = new SettingsService(root);
  settings.update({ general: { uiScale: 1.25 }, teams: { maxConcurrentTasks: 8 } });
  settings.update({ general: { theme: 'dark' } });
  settings.setMeta({ id: 'thread', title: 'Важный разговор' });
  settings.setMeta({ id: 'thread', pinned: true });
  assert.throws(() => settings.update({ teams: { captureLimitChars: 100 } }), /captureLimitChars/);
  assert.throws(() => settings.update({ teams: { maxConcurrentTasks: 9 } }), /maxConcurrentTasks/);
  assert.throws(() => settings.update({ general: { uiScale: 2 } }), /uiScale/);
  assert.throws(() => settings.update(JSON.parse('{"general":{"__proto__":{"polluted":true}}}')), /Неизвестная/);
  const backup = settings.exportBackup(agents);
  assert.equal(backup.settings.general.uiScale, 1.25);
  assert.equal(backup.settings.general.theme, 'dark');
  const imported = new SettingsService(null);
  imported.importBackup(backup, agents);
  assert.deepEqual(imported.meta(), [{ id: 'thread', title: 'Важный разговор', pinned: true }]);
  assert.deepEqual(imported.get(), new SettingsService(root).get());
  backup.settings.providers.codex.pathOverride = join(root, 'untrusted.mjs');
  assert.equal(imported.importBackup(backup, agents), true);
  assert.equal(imported.get().providers.codex.pathOverride, undefined);
  assert.throws(() => imported.importBackup({ ...backup, conversations: [{ id: 1 }] }, agents), /Некорректный файл/);
});
