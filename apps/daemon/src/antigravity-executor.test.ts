import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AntigravityExecutor } from './executors/antigravity.ts';
import { TaskBoard } from './tasks.ts';
import { Store } from './store.ts';
import type { Task } from '@land/protocol';
import { createTeamCoordinator } from './team.ts';
import { fakeExecutors } from './fake-executors.ts';

test('Antigravity discovers models separated by tabs', () => {
  const script = fileURLToPath(new URL('../test/fakes/fake-antigravity.mjs', import.meta.url));
  const executor = new AntigravityExecutor({ command: { command: process.execPath, args: [script] } });
  assert.deepEqual(executor.status().models, [{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', efforts: ['low', 'medium', 'high'] }]);
});

test('Antigravity task and reply use the documented stream protocol and retain the conversation', { timeout: 10000 }, async () => {
  const script = fileURLToPath(new URL('../test/fakes/fake-antigravity.mjs', import.meta.url));
  const executor = new AntigravityExecutor({ command: { command: process.execPath, args: [script] }, models: [{ id: 'model-test', label: 'Test', efforts: ['high'] }] });
  const board = new TaskBoard(new Store(), { executors: [executor], file: null });
  const done = (id: string) => new Promise<Task>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    board.on('task', function listener(t) {
      if (t.id === id && ['done', 'failed'].includes(t.status)) { clearTimeout(timer); board.off('task', listener); resolve(t); }
    });
  });
  const first = board.create({ prompt: 'Первая задача', cwd: process.cwd(), executor: 'antigravity', model: 'model-test', effort: 'high', access: 'read' });
  const a = await done(first.id);
  assert.equal(a.status, 'done');
  assert.equal(a.agentId, 'antigravity:87654321-1234-4234-8234-123456789abc');
  const firstOutput = JSON.parse(a.result!.split('\n')[0]);
  assert.equal(firstOutput.prompt, 'Первая задача');
  assert.ok(firstOutput.args.includes('plan'));
  const reply = board.reply(a.id, { prompt: 'Продолжи', access: 'write' });
  const b = await done(reply.id);
  assert.equal(b.status, 'done');
  assert.equal(b.agentId, a.agentId);
  const resumed = JSON.parse(b.result!.split('\n')[0]);
  assert.equal(resumed.args[resumed.args.indexOf('--conversation') + 1], a.agentId!.slice('antigravity:'.length));
  assert.ok(resumed.args.includes('accept-edits'));
});

test('Antigravity can review a Claude task and the author resumes', { timeout: 10000 }, async () => {
  const script = fileURLToPath(new URL('../test/fakes/fake-antigravity.mjs', import.meta.url));
  const agy = new AntigravityExecutor({ command: { command: process.execPath, args: [script] }, models: [{ id: 'model-test', label: 'Test' }] });
  const board = new TaskBoard(new Store(), { executors: [...fakeExecutors(), agy], file: null });
  const coordinator = createTeamCoordinator(board, (error) => { throw new Error(error); }, () => {}, { file: null });
  board.on('task', (task) => coordinator.continueTeam(task));
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('team timeout')), 5000);
    board.on('task', (task) => {
      if (task.status === 'failed') { clearTimeout(timer); reject(new Error(task.result)); }
      if (task.status === 'done' && task.continues) { clearTimeout(timer); resolve(); }
    });
  });
  const collab = coordinator.startTeam({ prompt: 'Проверь проект', cwd: process.cwd(), executor: 'claude', model: 'claude-haiku-5-5', access: 'read' }, [{ executor: 'antigravity', model: 'model-test' }]);
  await completed;
  const card = coordinator.list().find((c) => c.id === collab.id)!;
  assert.equal(card.status, 'done');
  assert.equal(card.turns[1].executor, 'antigravity');
  assert.equal(card.turns[1].access, 'read');
  assert.equal(card.turns[1].handoff, 'Проверено');
});

test('team does not bypass a refused author resume by launching a new session', () => {
  const created: any[] = [];
  const settings = { available: true, models: [{ id: 'm', label: 'M' }] };
  const coordinator = createTeamCoordinator({
    config: () => ({ projects: [], outsideGit: [], executors: { claude: settings, codex: settings, antigravity: settings } }),
    create: (input) => { const task = { ...input, id: String(created.length), status: 'running' as const, createdAt: Date.now() }; created.push(task); return task; },
    reply: () => { throw new Error('Этот агент уже отвечает на другое сообщение'); },
  }, () => {}, () => {}, { file: null });
  const collab = coordinator.startTeam({ prompt: 'Проверка', cwd: process.cwd(), executor: 'claude', model: 'm', access: 'read' }, [{ executor: 'antigravity', model: 'm' }]);
  coordinator.continueTeam({ ...created[0], status: 'done', result: '## Коллеге\nПроверь' });
  coordinator.continueTeam({ ...created[1], status: 'done', result: '## Коллеге\nГотово' });
  assert.equal(created.length, 2);
  assert.equal(coordinator.list().find((item) => item.id === collab.id)?.status, 'failed');
});
