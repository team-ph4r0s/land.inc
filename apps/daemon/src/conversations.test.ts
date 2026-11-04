import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@land/protocol';
import { Store } from './store.ts';
import { TaskBoard } from './tasks.ts';
import { conversations, messageHtml } from '../../office/src/conversations.ts';

const task = (id: string, createdAt: number, continues?: string): Task => ({ id, createdAt, continues, prompt: id, cwd: process.cwd(), executor: 'codex', model: 'm', access: 'read', status: 'done' });

test('conversations preserve chronological replies and separate unrelated sessions', () => {
  const groups = conversations([task('reply', 3, 'root'), task('unrelated', 2), task('root', 1)]);
  assert.deepEqual(groups.map((c) => [c.id, c.turns.map((t) => t.id)]), [['root', ['root', 'reply']], ['unrelated', ['unrelated']]]);
  assert.deepEqual(conversations([task('a', 1, 'expired'), task('b', 2, 'expired')]).map((c) => c.turns.length), [2]);
});

test('long answers survive board persistence and observed messages keep their tail', () => {
  const answer = 'Полный ответ\n'.repeat(1000) + 'КОНЕЦ';
  const store = new Store();
  store.update('a', { source: 'codex' }, Date.now());
  store.log('a', { kind: 'assistant', text: answer, at: Date.now() });
  const snapshot = store.snapshot();
  assert.equal(snapshot.type === 'snapshot' && snapshot.logs.a[0].text, answer);
  const file = join(mkdtempSync(join(tmpdir(), 'land-answer-')), 'tasks.json');
  const board = new TaskBoard(store, { file }) as any;
  const t = task('long', 1);
  board.tasks.push(t);
  board.finish(t, 'done', answer);
  const loaded = new TaskBoard(new Store(), { file });
  assert.equal(loaded.list()[0].result, answer);
});

test('message formatting preserves long code and escapes agent HTML', () => {
  const html = messageHtml('**Ответ**\n```html\n<img src=x onerror=alert(1)>\n```\n' + 'x'.repeat(6000) + 'КОНЕЦ');
  assert.ok(html.includes('<strong>Ответ</strong>'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.endsWith('КОНЕЦ'));
});
