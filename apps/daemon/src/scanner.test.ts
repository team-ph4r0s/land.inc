import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Executor, ScanCandidate } from '@land/protocol';
import { findFiles, pickOverrides, places } from './scanner.ts';

function withRoot(run: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'land-scan-'));
    try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}
const touch = (...parts: string[]) => {
  mkdirSync(join(...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(...parts), '');
};

describe('findFiles', () => {
  it('respects maxDepth', withRoot(async (root) => {
    touch(root, 'a', 'b', 'codex.exe');
    assert.deepEqual(await findFiles(root, ['codex.exe'], 2), [join(root, 'a', 'b', 'codex.exe')]);
    assert.deepEqual(await findFiles(root, ['codex.exe'], 1), []);
  }));

  it('matches names case-insensitively', withRoot(async (root) => {
    touch(root, 'CODEX.EXE');
    assert.deepEqual(await findFiles(root, ['codex.exe'], 0), [join(root, 'CODEX.EXE')]);
  }));

  it('does not look inside node_modules', withRoot(async (root) => {
    touch(root, 'node_modules', 'codex.exe');
    assert.deepEqual(await findFiles(root, ['codex.exe'], 2), []);
  }));

  it('stops at the limit', withRoot(async (root) => {
    for (let i = 0; i < 5; i++) touch(root, `folder${i}`, 'codex.exe');
    assert.equal((await findFiles(root, ['codex.exe'], 1, 2)).length, 2);
  }));

  it('ignores a missing root', async () => {
    assert.deepEqual(await findFiles(join(tmpdir(), 'land-scan-missing-' + Date.now()), ['codex.exe'], 3), []);
  });
});

describe('pickOverrides', () => {
  it('takes the first working candidate of each broken provider', () => {
    const candidates: ScanCandidate[] = [
      { executor: 'claude', path: '/claude1', source: 'PATH', works: true },
      { executor: 'codex', path: '/codex1', source: 'npm', works: false },
      { executor: 'antigravity', path: '/agy1', source: 'Antigravity', works: true },
      { executor: 'claude', path: '/claude2', source: 'npm', works: true },
    ];
    const broken: Executor[] = ['claude', 'codex'];
    assert.deepEqual(pickOverrides(candidates, broken), { claude: '/claude1' });
  });
});

describe('places', () => {
  it('looks in Codex Desktop and the PATH', () => {
    const env = { PATH: process.platform === 'win32' ? 'C:\\tools;relative' : '/tools:relative', LOCALAPPDATA: join(tmpdir(), 'local'), APPDATA: join(tmpdir(), 'roaming') };
    const list = places('codex', env, tmpdir());
    assert.ok(list.some((p) => p.source === 'PATH' && p.depth === 0));
    assert.ok(!list.some((p) => p.dir === 'relative'));
    if (process.platform === 'win32') assert.ok(list.some((p) => p.dir === join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') && p.depth > 0));
    // Generic program folders are not searched deeply: only the vendors' own ones.
    assert.ok(!list.some((p) => p.depth > 0 && /[\\/]Programs$|Program Files/i.test(p.dir)));
  });
});
