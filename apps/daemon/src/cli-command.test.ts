import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliCommand, cliOnPath } from './executors/files.ts';

test('native CLI runs directly', () => {
  assert.deepEqual(cliCommand(process.execPath, 'node', 'unused'), { command: process.execPath, args: [] });
});

for (const [name, packageName] of [['codex', '@openai/codex'], ['claude', '@anthropic-ai/claude-code']]) {
  test(`Windows npm ${name}: bypass shims and preserve literal arguments and stdin`, { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'land npm cli '));
    try {
      const pkg = join(root, 'node_modules', packageName);
      mkdirSync(join(pkg, 'bin'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ bin: { [name]: 'bin/cli.js' }, type: 'module' }));
      writeFileSync(join(pkg, 'bin', 'cli.js'), "let input = ''; for await (const chunk of process.stdin) input += chunk; console.log(JSON.stringify({ args: process.argv.slice(2), input }));");
      writeFileSync(join(root, name), '#!/bin/sh\nexit 1\n');
      writeFileSync(join(root, `${name}.cmd`), '@exit /b 1\r\n');
      // Reproduce the old discovery result: Windows cannot execute the Unix shim.
      assert.ok(spawnSync(join(root, name), [], { windowsHide: true }).error);
      for (const suffix of ['', '.cmd']) {
        const cmd = cliCommand(join(root, name + suffix), name, packageName)!;
        assert.equal(cmd.command, process.execPath);
        const args = ['a path with spaces', '"quoted" & echo bad | more', '%PATH%', 'Привет'];
        const out = execFileSync(cmd.command, [...cmd.args, ...args], { input: 'task\n', encoding: 'utf8', windowsHide: true });
        assert.deepEqual(JSON.parse(out), { args, input: 'task\n' });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('Windows PATH search skips unlaunchable entries and finds a later npm install', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'land cli path '));
  const oldPath = process.env.PATH;
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    const pkg = join(second, 'node_modules', '@test', 'cli');
    mkdirSync(first);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(first, 'land-test-cli.cmd'), '@exit /b 1\r\n');
    writeFileSync(join(second, 'land-test-cli.cmd'), '@exit /b 1\r\n');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ bin: 'cli.js' }));
    writeFileSync(join(pkg, 'cli.js'), '');
    // Search only this fixture and System32 (where.exe), not the hosted runner's
    // unrelated toolchain directories and network entries.
    process.env.PATH = `${first};${second};${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}`;
    assert.equal(cliCommand(join(first, 'land-test-cli.cmd'), 'land-test-cli', '@test/cli'), undefined);
    assert.deepEqual(cliOnPath('land-test-cli', '@test/cli'), { command: process.execPath, args: [join(pkg, 'cli.js')] });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
