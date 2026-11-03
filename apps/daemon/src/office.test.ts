import { spawn } from 'node:child_process';
import type { Task } from '@land/protocol';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeModel } from '@land/protocol';
import { Store } from './store.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { describeTool, testOutcome } from './activity.ts';
import { TaskBoard } from './tasks.ts';

test('model ids become the character and the name the office shows', () => {
  assert.deepEqual(describeModel('claude', 'claude-sonnet-5-5'), { kind: 'sonnet', label: 'Sonnet 5.5' });
  assert.deepEqual(describeModel('claude', 'claude-opus-5-5-20261001'), { kind: 'opus', label: 'Opus 5.5' });
  assert.deepEqual(describeModel('claude', 'claude-fable-5-1'), { kind: 'fable', label: 'Fable 5.1' });
  assert.deepEqual(describeModel('codex', 'gpt-6.1-terra'), { kind: 'terra', label: 'GPT-6.1 Terra' });
  assert.deepEqual(describeModel('codex', 'gpt-6-luna'), { kind: 'luna', label: 'GPT-6 Luna' });
  assert.deepEqual(describeModel('codex', 'codex-auto-review'), { kind: 'reviewer', label: 'Auto Review' });
  assert.deepEqual(describeModel('codex', 'o9-mini'), { kind: 'codex', label: 'o9-mini' });
  assert.deepEqual(describeModel('claude'), { kind: 'claude', label: 'Claude' });
});

test('Codex code mode is read through the JavaScript it runs', () => {
  assert.deepEqual(describeTool('exec', { code: 'await tools.exec_command({cmd:"npm test",workdir:"C:\\dev"})' }), { activity: 'bash', detail: 'npm test', test: true });
  assert.equal(describeTool('exec', { code: 'await tools.exec_command({cmd:"git diff; git status --short"})' }).activity, 'read');
  assert.equal(describeTool('exec', { code: 'text(await tools.apply_patch("*** Begin Patch"))' }).activity, 'write');
  assert.equal(describeTool('exec', { code: 'await tools.web__run({search_query:[{"q":"sandbox"}]})' }).activity, 'web');
});

test('test output decides the mood', () => {
  assert.equal(testOutcome('ℹ pass 11\nℹ fail 0'), true);
  assert.equal(testOutcome('Tests: 2 failed, 40 passed'), false);
  assert.equal(testOutcome('done'), undefined);
});

test('a green Codex test run puts on the shades, the model and effort follow each turn', () => {
  const store = new Store();
  const adapter = new CodexAdapter(store) as any;
  const tracked = { id: 'codex:t', titled: true };
  const timestamp = new Date().toISOString();
  adapter.apply(tracked, { type: 'session_meta', timestamp, payload: { cwd: 'C:/p' } });
  adapter.apply(tracked, { type: 'turn_context', timestamp, payload: { model: 'gpt-6.1-sol', effort: 'high' } });
  adapter.apply(tracked, { type: 'response_item', timestamp, payload: { type: 'custom_tool_call', name: 'exec', input: 'await tools.exec_command({cmd:"npm test"})' } });
  adapter.apply(tracked, { type: 'response_item', timestamp, payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'ℹ pass 11\nℹ fail 0' }] } });
  adapter.apply(tracked, { type: 'turn_context', timestamp, payload: { model: 'codex-auto-review', effort: 'low' } });
  const a = (store as any).agents.get('codex:t').state;
  assert.equal(a.mood, 'cool');
  assert.equal(a.model, 'codex-auto-review');
  assert.equal(a.role, 'reviewer');
  assert.equal(a.effort, 'low');
});

test('the task board refuses bad input before starting anything', () => {
  const board = new TaskBoard(new Store());
  const base = { prompt: 'x', cwd: process.cwd(), executor: 'codex', model: 'gpt-6-luna', access: 'read' } as const;
  assert.throws(() => board.create({ ...base, prompt: '  ' }), /Опишите задачу/);
  assert.throws(() => board.create({ ...base, cwd: 'C:/definitely/missing/folder' }), /Папка проекта не найдена/);
  assert.throws(() => board.create({ ...base, executor: 'bash' as any }), /Неизвестный исполнитель/);
  assert.throws(() => board.create({ ...base, access: 'admin' as any }), /Неизвестный режим доступа/);
});

test('unknown model ids are shown as they are, not cut to a known prefix', () => {
  assert.deepEqual(describeModel('codex', 'gpt-6-new'), { kind: 'codex', label: 'gpt-6-new' });
  assert.deepEqual(describeModel('claude', 'claude-sonnet-5-5-experimental'), { kind: 'claude', label: 'claude-sonnet-5-5-experimental' });
});

test('only a summary of the whole run counts as green', () => {
  assert.equal(testOutcome('✔ parses config (1ms)'), undefined); // one passing test, the run is not over
  assert.equal(testOutcome('PASS src/a.test.ts'), undefined);
  assert.equal(testOutcome('Process running with session ID 3'), undefined);
  assert.equal(testOutcome('Tests:       40 passed, 40 total'), true);
  assert.equal(testOutcome('==== 12 passed in 0.4s ===='), true);
  assert.equal(testOutcome('test result: FAILED. 3 passed; 1 failed'), false);
});

test('a relative or empty project path is refused, not resolved against the daemon folder', () => {
  const board = new TaskBoard(new Store());
  const base = { prompt: 'x', executor: 'codex', model: 'gpt-6-luna', access: 'read' } as const;
  assert.throws(() => board.create({ ...base, cwd: '' }), /полный путь/);
  assert.throws(() => board.create({ ...base, cwd: '.' }), /полный путь/);
  assert.throws(() => board.create({ ...base, cwd: 'apps/daemon' }), /полный путь/);
});

/** A task whose "CLI" is a sleeping node process, so cancel paths run for real without an agent. */
function sleepingTask(board: any) {
  board.spawnCodex = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  board.save = () => {}; // keep the user's ~/.land/tasks.json out of tests
  const task: Task = { id: 't1', prompt: 'x', cwd: process.cwd(), executor: 'codex', model: 'm', access: 'read', status: 'starting', createdAt: Date.now() };
  board.tasks.unshift(task);
  board.run(task);
  return task;
}

const settled = (board: TaskBoard, status: string) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`task never became ${status}`)), 5_000);
    board.on('task', (t) => {
      if (t.status === status) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

/** Leave no sleeping process behind, whatever the test did. */
const cleanup = (board: any) => {
  for (const p of board.procs.values()) p.kill();
};

test('a cancel whose tree kill fails is not reported as a clean cancel', { timeout: 10_000 }, async () => {
  const board = new TaskBoard(new Store()) as any;
  try {
    board.killTree = (_p: unknown, _sync: boolean, onResult: (e?: string) => void) => onResult('Access is denied');
    const task = sleepingTask(board);
    await settled(board, 'running');
    board.cancel(task.id);
    assert.equal(task.status, 'cancelling');
    assert.match(task.result ?? '', /Не удалось остановить/);
    const done = settled(board, 'failed');
    board.procs.get(task.id).kill(); // only the CLI dies
    await done;
    assert.match(task.result ?? '', /Отмена не подтверждена/);
  } finally {
    cleanup(board);
  }
});

test('a cancel waits for the tree kill even when the CLI closes first', { timeout: 10_000 }, async () => {
  const board = new TaskBoard(new Store()) as any;
  try {
    let report: (e?: string) => void = () => {};
    board.killTree = (p: any, _sync: boolean, onResult: (e?: string) => void) => {
      p.kill(); // the CLI goes down right away...
      report = onResult; // ...but the verdict on its children comes later
    };
    const task = sleepingTask(board);
    await settled(board, 'running');
    board.cancel(task.id);
    await new Promise((r) => board.procs.get(task.id)?.once('close', r) ?? r(null));
    assert.equal(task.status, 'cancelling'); // closed, but not settled yet; still holds its slot
    const done = settled(board, 'failed');
    report('Access is denied');
    await done;
    assert.match(task.result ?? '', /Отмена не подтверждена/);
  } finally {
    cleanup(board);
  }
});

test('a confirmed tree kill ends as cancelled', { timeout: 10_000 }, async () => {
  const board = new TaskBoard(new Store()) as any;
  try {
    board.killTree = (p: any, _sync: boolean, onResult: (e?: string) => void) => {
      p.kill();
      onResult();
    };
    const task = sleepingTask(board);
    await settled(board, 'running');
    const done = settled(board, 'cancelled');
    board.cancel(task.id);
    assert.equal(task.status, 'cancelling');
    await done;
  } finally {
    cleanup(board);
  }
});
