import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_SETTINGS, type Task } from '@land/protocol';
import { ClaudeExecutor } from './executors/claude.ts';
import { Store } from './store.ts';
import { TaskBoard } from './tasks.ts';

function finished(board: TaskBoard, id: string): Promise<Task> {
  return new Promise((resolve) => {
    const listener = (task: Task) => {
      if (task.id !== id || !task.finishedAt) return;
      board.off('task', listener);
      resolve(task);
    };
    board.on('task', listener);
  });
}

const input = (cwd: string, prompt: string) =>
  ({ cwd, prompt, executor: 'claude', model: 'claude-opus-4-6', access: 'read' } as const);

test('cancelling a streaming task stops a real grandchild and persists redacted partial output', { timeout: 15_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'land-stream-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const script = join(cwd, 'подзадача CLI.mjs');
  writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "if (process.argv.includes('auth')) { console.log('{\"loggedIn\":true}'); }",
    "else {",
    "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });",
    "  process.stdout.write('partial answer sk-abcdefghijklmnop\\n', () => writeFileSync('started', String(child.pid)));",
    "  setInterval(() => {}, 1000);",
    "}",
  ].join('\n'));
  const executor = new ClaudeExecutor({ command: { command: process.execPath, args: [script] } });
  const file = join(cwd, 'tasks.json');
  const board = new TaskBoard(new Store(), { executors: [executor], file });
  const task = board.create(input(cwd, 'stream'));
  t.after(() => board.cancel(task.id));
  const completion = finished(board, task.id);
  const started = join(cwd, 'started');
  for (let attempts = 0; !existsSync(started); attempts++) {
    if (attempts === 120) assert.fail('CLI did not start');
    await delay(30);
  }
  const pid = Number(readFileSync(started, 'utf8'));
  board.cancel(task.id);
  const result = await completion;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.result, 'partial answer [СЕКРЕТ СКРЫТ]');
  if (process.platform === 'win32') assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(new TaskBoard(new Store(), { executors: [executor], file }).list()[0].result, result.result);
});

test('eight tasks can stream independent large outputs with a configured capture limit', { timeout: 20_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'land-parallel-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const script = join(cwd, 'cli.mjs');
  writeFileSync(script, [
    "if (process.argv.includes('auth')) console.log('{\"loggedIn\":true}');",
    "else { let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;",
    "for (let n = 0; n < 48; n++) process.stdout.write('x'.repeat(16_384));",
    "console.log('FINISH ' + prompt); }",
  ].join('\n'));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.teams.maxConcurrentTasks = 8;
  settings.teams.captureLimitChars = 300_000;
  const file = join(cwd, 'tasks.json');
  const executors = [new ClaudeExecutor({ command: { command: process.execPath, args: [script] } })];
  const board = new TaskBoard(new Store(), { settings: () => settings, file, executors });
  const tasks = Array.from({ length: 8 }, (_, n) => board.create(input(cwd, 'task-' + n)));
  t.after(() => { for (const task of tasks) board.cancel(task.id); });
  const completed = Promise.all(tasks.map((task) => finished(board, task.id)));
  assert.throws(() => board.create(input(cwd, 'extra')), /не больше 8/);
  const results = await completed;
  const recovered = new TaskBoard(new Store(), { settings: () => settings, file, executors }).list();
  for (const [n, task] of results.entries()) {
    assert.equal(recovered.find(({ id }) => id === task.id)?.result, task.result);
    assert.equal(task.status, 'done');
    assert.match(task.result ?? '', new RegExp('FINISH task-' + n + '$'));
    assert.ok(task.result && task.result.length >= 299_999 && task.result.length <= 300_000);
  }
});
