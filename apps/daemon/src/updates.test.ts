import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newer, validVersion, githubRepo, prepareRelease, UpdatesService, run, type Runner } from './updates.ts';
import type { OfficeRelease } from '@land/protocol';

test('release versions compare numerically and remotes cannot contain credential URLs or arbitrary hosts', () => {
  assert.equal(newer('1.10', '1.9'), true);
  assert.equal(newer('2.0', '1.999'), true);
  assert.equal(newer('1.0', '1.0'), false);
  for (const v of ['1', '1.0.0', '1.00', '01.0', '../1.0']) assert.equal(validVersion(v), false);
  assert.equal(githubRepo('https://github.com/example/office.git'), 'example/office');
  assert.equal(githubRepo('git@github.com:example/office.git'), 'example/office');
  for (const url of ['https://token@github.com/example/office', 'https://evil.example/example/office', 'file:///tmp/repo']) assert.throws(() => githubRepo(url));
});

test('update preflight rejects dirty copies, active work and stale release selections', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'land-version-'));
  writeFileSync(join(root, 'VERSION'), '1.0');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let idle = true;
  const service = new UpdatesService(() => {}, () => idle, { fake: true, root });
  await service.check();
  const release = service.state.available!;
  idle = false;
  await assert.rejects(service.install(release.version, release.sha), /завершения/);
  idle = true;
  await assert.rejects(service.install('1.2', release.sha), /изменился/);
  await service.install(release.version, release.sha);
  assert.equal(service.state.phase, 'done');
  assert.equal(service.state.current, '1.0'); // fake mode never installs code
  const runner: Runner = async (_command, args) => args[0] === 'status' ? ' M user-file' : '';
  const real = new UpdatesService(() => {}, () => true, { managed: true, runner, root });
  real.state.available = release;
  await assert.rejects(real.install(release.version, release.sha), /локальные изменения/);
});

test('release check dereferences annotated tags and ignores stale versions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'land-version-'));
  writeFileSync(join(root, 'VERSION'), '1.0');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner: Runner = async (_command, args) => {
    if (args[0] === 'remote') return 'https://github.com/example/office.git';
    if (args[0] === 'api') return JSON.stringify({ tag_name: 'v1.10', body: 'Notes' });
    return `${'b'.repeat(40)}\trefs/tags/v1.10\n${'c'.repeat(40)}\trefs/tags/v1.10^{}`;
  };
  const service = new UpdatesService(() => {}, () => true, { runner, root });
  await service.check();
  assert.equal(service.state.available?.sha, 'c'.repeat(40));
  assert.equal(service.state.available?.version, '1.10');
});

test('staging a release uses an independent Git checkout and refuses a changed tag before npm', { timeout: 45_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-update-'));
  const origin = join(dir, 'origin'), source = join(dir, 'source'), base = join(dir, 'updates');
  mkdirSync(origin); mkdirSync(base);
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git(origin, ['init']);
    const pkg = { name: 'update-fixture', version: '1.0.0', private: true, scripts: { typecheck: 'node -e ""', test: 'node -e ""', build: 'node -e ""' } };
    writeFileSync(join(origin, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(origin, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } }));
    writeFileSync(join(origin, 'VERSION'), '1.0\n');
    git(origin, ['add', '.']); git(origin, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'first']);
    writeFileSync(join(origin, 'VERSION'), '1.1\n');
    git(origin, ['add', '.']); git(origin, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'second']);
    git(origin, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'tag', '-a', 'v1.1', '-m', '1.1']);
    const sha = git(origin, ['rev-parse', 'HEAD']);
    git(dir, ['clone', origin, source]);
    git(source, ['checkout', '--detach', 'HEAD~1']);
    const release: OfficeRelease = { version: '1.1', tag: 'v1.1', sha, url: '', notes: '' };
    let npmCalls = 0;
    const runner: Runner = async (command, args, cwd) => {
      if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/example/office.git';
      if (command === 'git' && args[0] === 'fetch') return run(command, args.map((a) => a === 'origin' ? origin : a), cwd);
      if (command === process.execPath) { npmCalls++; return ''; } // no network or dependency scripts in this fixture
      return run(command, args, cwd);
    };
    await assert.rejects(prepareRelease(source, base, { ...release, sha: 'a'.repeat(40) }, process.execPath, () => {}, runner), /Тег релиза изменился/);
    assert.equal(npmCalls, 0);
    const target = await prepareRelease(source, base, release, process.execPath, () => {}, runner);
    assert.equal(readFileSync(join(target, 'VERSION'), 'utf8').trim(), '1.1');
    assert.equal(readFileSync(join(source, 'VERSION'), 'utf8').trim(), '1.0');
    assert.equal(npmCalls, 4);
    assert.equal(existsSync(join(base, 'active.json')), false); // preparation alone cannot activate a release
    writeFileSync(join(source, 'user.txt'), 'keep me');
    await assert.rejects(prepareRelease(source, base, release, process.execPath, () => {}, runner), /локальные изменения/);
    assert.equal(readFileSync(join(source, 'user.txt'), 'utf8'), 'keep me');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
