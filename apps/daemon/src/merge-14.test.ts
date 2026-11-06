// What 1.3–1.4 brought that 1.5 keeps: workspace path checks, the hang detector,
// migration of 1.4 «персоны», and custom model ids end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCustomModelId } from '@land/protocol';
import { AgentService, migrateLegacyAgents, validAgents } from './agents.ts';
import { ModelCatalogService } from './model-catalog.ts';
import { HangDetector } from './process-supervisor.ts';
import { sanitizeWorkspacePath } from './workspace-path.ts';

const persona = (over: Record<string, unknown> = {}) => ({
  id: 'preset-editor', name: 'Литературный Редактор', provider: 'antigravity', model: 'agy-default', reasoningEffort: 'medium',
  roleType: 'editor', characterAndSystemPrompt: 'Полируй стиль, сохраняя смысл.', defaultAccessMode: 'workspace-write',
  avatarConfig: { outfitColor: '#aa3355', accessory: 'beret' }, mandatoryMcpServers: ['markitdown', 'agentic-shield', 'unknown'],
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...over,
});

test('1.4 personas in agents.json become 1.5 profiles, the old file is kept as .v1.4.bak', () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-migrate-'));
  const file = join(dir, 'agents.json');
  const legacy = [persona(), persona({ id: 'p2', name: 'Ревьюер', provider: 'codex', model: 'gpt-6.1-terra', roleType: 'reviewer', defaultAccessMode: 'read-only', avatarConfig: { outfitColor: 'red' } })];
  writeFileSync(file, JSON.stringify(legacy));
  const agents = new AgentService(new ModelCatalogService({ modelsOverride: [] }), file).list();
  assert.equal(agents.length, 2);
  const [editor, reviewer] = agents;
  assert.equal(editor.executor, 'antigravity');
  assert.equal(editor.role, 'editor');
  assert.equal(editor.backstory, 'Полируй стиль, сохраняя смысл.');
  assert.equal(editor.access, 'write');
  assert.deepEqual(editor.appearance, { outfit: '#aa3355', accessory: 'cap' });
  assert.deepEqual(editor.mcp, ['markitdown', 'agentic-shield']);
  assert.equal(editor.createdAt, 1_700_000_000_000);
  assert.equal(reviewer.role, 'critic');
  assert.equal(reviewer.access, 'read');
  assert.equal(reviewer.appearance.outfit, '#4f7b68');
  assert.ok(validAgents(JSON.parse(readFileSync(file, 'utf8'))));
  assert.equal(readFileSync(file + '.v1.4.bak', 'utf8'), JSON.stringify(legacy));
  // A second start reads the migrated file and does not migrate again.
  assert.deepEqual(new AgentService(new ModelCatalogService({ modelsOverride: [] }), file).list().map((x) => x.id), ['preset-editor', 'p2']);
  // 1.5 files are left alone.
  assert.equal(migrateLegacyAgents(agents), undefined);
  assert.equal(migrateLegacyAgents([]), undefined);
});

test('workspace paths stay inside their root, away from system and credential folders', () => {
  const root = mkdtempSync(join(tmpdir(), 'land-ws-'));
  assert.equal(sanitizeWorkspacePath(join(root, 'out.md'), root), join(root, 'out.md'));
  assert.throws(() => sanitizeWorkspacePath(join(root, '..', 'evil.md'), root), /пределы/);
  assert.throws(() => sanitizeWorkspacePath('relative/out.md', root), /абсолютным/);
  if (process.platform === 'win32') assert.throws(() => sanitizeWorkspacePath('C:\\', 'C:\\'), /Корень/);
});

test('the hang detector warns once per silent process and again only after new silence', () => {
  const detector = new HangDetector(1_000);
  detector.start('task');
  assert.equal(detector.check(Date.now() + 1_100).length, 1);
  assert.equal(detector.check(Date.now() + 2_200).length, 0);
  detector.touch('task');
  assert.equal(detector.check(Date.now() + 1_100).length, 1);
  detector.stop('task');
  assert.equal(detector.check(Date.now() + 5_000).length, 0);
});

test('custom model ids are plain identifiers that can never pose as a CLI flag', () => {
  for (const ok of ['local-proxy/model-1', 'gpt-6.1-sol', 'qwen3:32b', 'org/model@v2']) assert.ok(isCustomModelId(ok), ok);
  for (const bad of ['', '-m', '--dangerously-skip-permissions', 'a b', 'x;rm -rf /', 'a'.repeat(121), 42]) assert.ok(!isCustomModelId(bad), String(bad));
});
