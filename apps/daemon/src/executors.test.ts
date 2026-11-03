import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewTask, Task } from '@land/protocol';
import { Store } from './store.ts';
import { TaskBoard } from './tasks.ts';
import { createTeamCoordinator } from './team.ts';
import { fakeExecutors } from './fake-executors.ts';

// End to end through the real board and executors; only the CLIs are fakes (test/fakes).

const cwd = process.cwd();
const newBoard = () => new TaskBoard(new Store(), { executors: fakeExecutors(), file: null });

/** Wait until the board reports a task in a final state. */
function settled(board: TaskBoard, id: string): Promise<Task> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`task ${id} did not finish`)), 8_000);
    const check = (t: Task) => {
      if (t.id === id && ['done', 'failed', 'cancelled'].includes(t.status)) {
        clearTimeout(timer);
        board.off('task', check);
        resolve(t);
      }
    };
    board.on('task', check);
  });
}

const args = (t: Task) => JSON.parse(t.result!.match(/^ARGS (.+)$/m)![1]);
const run = async (board: TaskBoard, input: NewTask) => {
  const task = board.create(input);
  return settled(board, task.id);
};
const cleanup = (board: any) => {
  for (const p of board.procs.values()) p.kill();
};

test('Claude: print mode, the chosen model and effort, plan for read-only, a known session id', { timeout: 15_000 }, async () => {
  const board = newBoard();
  const task = await run(board, { prompt: 'Что тут?', cwd, executor: 'claude', model: 'claude-sonnet-5-5', effort: 'high', access: 'read' });
  assert.equal(task.status, 'done');
  const a = args(task);
  assert.deepEqual([a.print, a.model, a.effort, a.mode], [true, 'claude-sonnet-5-5', 'high', 'plan']);
  assert.equal(a.session, task.agentId); // the office can link the worker before its transcript appears
  assert.match(task.result!, /PROMPT_CHARS 8/); // the prompt went through stdin
});

test('Claude: write access means acceptEdits', { timeout: 15_000 }, async () => {
  const task = await run(newBoard(), { prompt: 'Поправь', cwd, executor: 'claude', model: 'claude-haiku-5-5', access: 'write' });
  assert.equal(args(task).mode, 'acceptEdits');
});

test('Claude: a lost sign-in fails the task with a hint, and a signed-out CLI is offered as unavailable', { timeout: 15_000 }, async () => {
  const task = await run(newBoard(), { prompt: '[signed-out]', cwd, executor: 'claude', model: 'claude-haiku-5-5', access: 'read' });
  assert.equal(task.status, 'failed');
  assert.match(task.result!, /не авторизован/);
  process.env.FAKE_SIGNED_OUT = '1';
  try {
    const status = newBoard().config().executors.claude;
    assert.equal(status.available, false);
    assert.match(status.note!, /auth login/);
  } finally {
    delete process.env.FAKE_SIGNED_OUT;
  }
});

test('Codex: JSON events, the thread links the worker, the final message is the answer', { timeout: 15_000 }, async () => {
  const board = newBoard();
  const task = await run(board, { prompt: 'Что тут?', cwd, executor: 'codex', model: 'gpt-fake', effort: 'high', access: 'read' });
  assert.equal(task.status, 'done');
  assert.match(task.agentId!, /^codex:[0-9a-f-]{36}$/);
  assert.doesNotMatch(task.result!, /Смотрю проект/); // the intermediate message is not the answer
  const a = args(task);
  assert.deepEqual([a.exec, a.json, a.sandbox, a.cd, a.model, a.stdin], ['exec', true, 'read-only', cwd, 'gpt-fake', true]);
  assert.ok(a.configs.includes('approval_policy="never"'));
  assert.ok(a.configs.includes('model_reasoning_effort="high"'));
});

test('Codex: write access means the workspace-write sandbox', { timeout: 15_000 }, async () => {
  const task = await run(newBoard(), { prompt: 'Поправь', cwd, executor: 'codex', model: 'gpt-fake-2', access: 'write' });
  assert.equal(args(task).sandbox, 'workspace-write');
});

test('Codex: a failed turn and a crashed CLI both fail the task with their reason', { timeout: 15_000 }, async () => {
  const board = newBoard();
  const refused = await run(board, { prompt: '[turn-failed]', cwd, executor: 'codex', model: 'gpt-fake', access: 'read' });
  assert.equal(refused.status, 'failed');
  assert.match(refused.result!, /model refused/);
  const crashed = await run(board, { prompt: '[fail]', cwd, executor: 'codex', model: 'gpt-fake', access: 'read' });
  assert.equal(crashed.status, 'failed');
  assert.match(crashed.result!, /boom/);
});

test('a running writer locks its folder for other writers, not for readers', { timeout: 15_000 }, async () => {
  const board = newBoard();
  try {
    board.create({ prompt: '[sleep]', cwd, executor: 'claude', model: 'claude-haiku-5-5', access: 'write' });
    assert.throws(() => board.create({ prompt: 'тоже пишу', cwd, executor: 'codex', model: 'gpt-fake', access: 'write' }), /уже работает задача с правом записи/);
    const reader = board.create({ prompt: 'только смотрю', cwd, executor: 'codex', model: 'gpt-fake', access: 'read' });
    assert.equal((await settled(board, reader.id)).status, 'done');
  } finally {
    cleanup(board);
  }
});

test('a Claude + Codex team runs three real turns: the colleague reviews read-only, the author finishes with write access', { timeout: 30_000 }, async () => {
  const board = newBoard();
  const team = createTeamCoordinator(board, (e) => assert.fail(e), () => {}, { file: null });
  const done: Task[] = [];
  const finished = new Promise<void>((resolve) =>
    board.on('task', (t) => {
      team.continueTeam(t);
      if (t.status === 'done' || t.status === 'failed') {
        done.push(t);
        if (done.length === 3 || t.status === 'failed') resolve();
      }
    }),
  );
  team.startTeam({ prompt: 'Почини сборку', cwd, executor: 'claude', model: 'claude-sonnet-5-5', access: 'write' }, [{ executor: 'codex', model: 'gpt-fake' }]);
  await finished;
  assert.deepEqual(done.map((t) => `${t.executor}:${t.status}`), ['claude:done', 'codex:done', 'claude:done']);
  assert.equal(args(done[0]).mode, 'acceptEdits');
  assert.equal(args(done[1]).sandbox, 'read-only'); // the reviewer cannot write
  assert.equal(args(done[2]).mode, 'acceptEdits');
  // Only the colleague sections travel, quoted as data.
  assert.match(done[1].prompt, /<<<СООБЩЕНИЕ 1 от claude\nСообщение от claude \(acceptEdits\)\nСООБЩЕНИЕ 1>>>/);
  assert.match(done[2].prompt, /Сообщение от codex \(read-only\)/);
  assert.doesNotMatch(done[2].prompt, /ARGS/);
  // The card in «Переговорка» saw it all: three finished turns, each with its office agent.
  const [collab] = team.list();
  assert.equal(collab.status, 'done');
  assert.deepEqual(collab.turns.map((t) => `${t.role}:${t.status}`), ['author:done', 'reviewer:done', 'finisher:done']);
  assert.ok(collab.turns.every((t) => t.agentId));
  assert.match(collab.result!, /fake claude answer/);
});

test('retrying a failed team stop: the old warning goes away, extra clicks wait, the confirmed stop ends the team', { timeout: 20_000 }, async () => {
  const board = newBoard() as any;
  const events: import('@land/protocol').Collaboration[] = [];
  const team = createTeamCoordinator(board, () => {}, () => {}, { file: null, onCollab: (c) => events.push(c) });
  board.on('task', (t: Task) => team.continueTeam(t));
  const kills: ((error?: string) => void)[] = [];
  board.killTree = (_p: unknown, _sync: boolean, onResult: (error?: string) => void) => kills.push(onResult);
  try {
    const collab = team.startTeam({ prompt: '[sleep]', cwd, executor: 'claude', model: 'claude-haiku-5-5', access: 'read' }, [{ executor: 'codex', model: 'gpt-fake' }]);
    const card = () => team.list().find((c) => c.id === collab.id)!;
    await new Promise<void>((r) => board.on('task', (t: Task) => t.status === 'running' && r()));
    team.cancelTeam(collab.id);
    kills[0]('Access is denied'); // the first kill fails
    assert.match(card().reason!, /Не удалось остановить/);
    team.cancelTeam(collab.id); // "Остановить ещё раз"
    assert.equal(kills.length, 2);
    assert.equal(card().reason, undefined); // the stale warning is gone while the retry runs
    team.cancelTeam(collab.id); // a click while the retry is still running
    assert.equal(kills.length, 2); // no overlapping attempt
    const stopped = new Promise<void>((r) => board.on('task', (t: Task) => t.status === 'cancelled' && r()));
    for (const p of board.procs.values()) p.kill();
    kills[1](); // the retry succeeds
    await stopped;
    assert.equal(card().status, 'stopped');
    assert.deepEqual(card().turns.map((t) => t.status), ['cancelled', 'skipped', 'skipped']);
  } finally {
    cleanup(board);
  }
});
