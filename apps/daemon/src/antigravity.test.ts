import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { Store } from './store.ts';

test('Antigravity discovers a recent transcript and consumes appended events once', () => {
  const root = mkdtempSync(join(tmpdir(), 'land-antigravity-'));
  try {
    const dir = join(root, 'session', '.system_generated', 'logs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'transcript.jsonl');
    const at = new Date().toISOString();
    writeFileSync(path, JSON.stringify({ type: 'USER_INPUT', created_at: at, content: '<USER_REQUEST>\nhello\n</USER_REQUEST>\n<context>extra</context>' }) + '\n');
    const store = new Store();
    const adapter = new AntigravityAdapter(store, root);
    adapter.poll();
    appendFileSync(path, JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: at, tool_calls: [{ name: 'read_file', args: { Path: '/src/app.ts' } }] }) + '\n');
    adapter.poll();
    const interim = store.snapshot();
    if (interim.type !== 'snapshot') throw new Error('Expected snapshot');
    assert.equal(interim.agents[0].activity, 'read');
    appendFileSync(path, JSON.stringify({ type: 'GENERIC', created_at: at, content: 'tool output' }) + '\n');
    appendFileSync(path, JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: at, content: 'done' }) + '\n');
    adapter.poll();
    adapter.poll();
    const snapshot = store.snapshot();
    assert.equal(snapshot.type, 'snapshot');
    if (snapshot.type !== 'snapshot') return;
    assert.equal(snapshot.agents[0].source, 'antigravity');
    assert.equal(snapshot.agents[0].id, 'antigravity:session');
    assert.equal(snapshot.agents[0].title, 'hello');
    assert.equal(snapshot.agents[0].activity, 'idle');
    assert.deepEqual(snapshot.logs['antigravity:session'].filter(x => x.kind !== 'tool').map(x => x.text), ['hello', 'done']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { describeTool } from './activity.ts';

test('Antigravity tools map their arguments and activities', () => {
  assert.deepEqual(describeTool('run_command', { CommandLine: 'npm test', toolSummary: 'run tests' }), { activity: 'bash', detail: 'run tests', test: true });
  assert.equal(describeTool('run_command', { CommandLine: 'git status' }).activity, 'read');
  assert.equal(describeTool('view_file', { AbsolutePath: '/src/app.ts' }).activity, 'read');
  assert.equal(describeTool('write_to_file', { TargetFile: '/src/app.ts' }).activity, 'write');
  assert.equal(describeTool('search_web', { query: 'test' }).activity, 'web');
  assert.equal(describeTool('ask_question').activity, 'wait');
  assert.equal(describeTool('invoke_subagent').activity, 'talk');
  assert.equal(describeTool('send_message').activity, 'talk');
});

test('Antigravity reads workspace and parent metadata and interprets completed test results', () => {
  const root = mkdtempSync(join(tmpdir(), 'land-ag-meta-'));
  try {
    const brain = join(root, 'brain');
    const dir = join(brain, 'child', '.system_generated', 'logs');
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(root, 'conversation_summaries.db'));
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, workspace_uris TEXT, parent_conversation_id TEXT)');
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run('child', JSON.stringify([pathToFileURL(root).href]), 'parent');
    db.close();
    const at = new Date().toISOString();
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, [
      { type: 'USER_INPUT', created_at: at, content: 'test' },
      { type: 'PLANNER_RESPONSE', created_at: at, tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify('npm test'), toolSummary: JSON.stringify('Run tests') } }] },
      { type: 'GENERIC', created_at: at, status: 'RUNNING', content: 'still running' },
      { type: 'GENERIC', created_at: at, status: 'DONE', content: 'Process exited with code 1' },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const store = new Store();
    new AntigravityAdapter(store, brain).poll();
    const snapshot = store.snapshot();
    if (snapshot.type !== 'snapshot') throw new Error('Expected snapshot');
    const agent = snapshot.agents[0];
    assert.equal(agent.cwd, root);
    assert.equal(agent.parentId, 'antigravity:parent');
    assert.equal(agent.mood, 'fail');
    assert.ok(agent.fireAt);
    assert.equal(snapshot.logs[agent.id].find((entry) => entry.kind === 'tool')?.text, 'Run tests');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
