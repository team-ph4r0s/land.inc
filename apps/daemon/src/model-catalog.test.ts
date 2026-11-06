import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelCatalogService } from './model-catalog.ts';

test('catalog joins provider caches, profile configuration and ANSI-coloured agy listing, and caches until rescan', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'land-catalog-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const [codexHome, claudeHome, antigravityHome] = ['codex', 'claude', 'agy'].map((name) => join(root, name));
  for (const home of [codexHome, claudeHome, antigravityHome]) mkdirSync(home);
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ model: 'my-model', env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6', ANTHROPIC_MODEL: 'env-model' } }));
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-test', display_name: 'GPT Test', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }], default_reasoning_level: 'max' },
    { slug: 'hidden', visibility: 'hide' },
  ] }));
  writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-test"\nmodel_reasoning_effort = "low"\n[profiles.deep]\nmodel = "my-provider"\nmodel_reasoning_effort = "xhigh"\n[profiles.hidden]\nmodel = "hidden"\n');
  writeFileSync(join(antigravityHome, 'models.json'), JSON.stringify({ models: [{ id: 'cache-model', efforts: ['low'] }] }));
  const agy = join(root, 'модели CLI.mjs');
  writeFileSync(agy, 'if(process.argv[2]==="models") console.log("\\x1b[32mremote-test\\x1b[0m\\tRemote model");');
  const service = new ModelCatalogService({ codexHome, claudeHome, antigravityHome,
    antigravityCommand: () => ({ command: process.execPath, args: [agy] }), timeoutMs: 4000 });
  const { models } = await service.rescan();
  const find = (id: string) => models.find((model) => model.id === id);
  assert.deepEqual(find('gpt-test')?.efforts, ['medium', 'max']);
  assert.equal(find('gpt-test')?.defaultEffort, 'max');
  assert.deepEqual(find('my-provider')?.efforts, ['xhigh']);
  assert.equal(find('hidden'), undefined);
  assert.equal(find('my-model')?.origin, 'config');
  assert.equal(find('env-model')?.origin, 'config');
  assert.ok(find('opus')?.badges?.includes('alias'));
  assert.deepEqual(find('opus')?.efforts, ['low', 'medium', 'high']);
  assert.equal(find('claude-haiku-4-5')?.efforts, undefined);
  assert.equal(find('remote-test')?.origin, 'cli');
  assert.deepEqual(find('cache-model')?.efforts, ['low']);
  assert.equal(find('gemini-3.8-flash-low'), undefined);
  writeFileSync(agy, 'console.error("Please sign in to view available models"); process.exitCode=1;');
  assert.ok(service.get().models.some((model) => model.id === 'remote-test'));
  const rescanned = await service.rescan();
  assert.ok(rescanned.models.some((model) => model.id === 'gemini-3.8-flash-low'));
  assert.match(rescanned.notes.antigravity ?? '', /agy login/);
});
