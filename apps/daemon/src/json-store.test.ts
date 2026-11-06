import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJson, writeJson } from './json-store.ts';

const valid = (value: unknown): value is number[] => Array.isArray(value) && value.every(Number.isInteger);

test('concurrent read/modify/write transactions preserve all entries and recover from a schema-invalid primary', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'land-json-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const file = join(root, 'data.json');
  await Promise.all(Array.from({ length: 24 }, (_, n) => new Promise<void>((done, reject) => setImmediate(() => {
    try {
      writeJson(file, [...(readJson(file, valid) ?? []), n], valid);
      done();
    } catch (error) { reject(error); }
  }))));
  const all = readJson(file, valid);
  assert.deepEqual(all, Array.from({ length: 24 }, (_, n) => n));
  writeFileSync(file, '{"unexpected":true}');
  assert.deepEqual(readJson(file, valid), all?.slice(0, -1));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), all?.slice(0, -1));
  writeFileSync(file, '{"interrupted":');
  assert.deepEqual(readJson(file, valid), all?.slice(0, -1));
  assert.throws(() => writeJson(file, ['wrong'] as unknown as number[], valid), /Некорректные/);
});
