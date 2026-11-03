import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSY_LEAVE_AFTER_MS, Store } from './store.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { needsUser } from './activity.ts';

test('pending tools and explicit waits survive inactivity, finished agents leave', () => {
  const store = new Store();
  const old = Date.now() - 46 * 60_000;
  for (const id of ['tool', 'wait', 'done']) store.update(id, { source: 'codex' }, old);
  store.tool('tool', 'shell', 'bash', 'running', old);
  store.waiting('wait', 'approval', old);
  store.turnEnd('done', old);
  (store as any).tick();
  assert.equal(store.has('tool'), true);
  assert.equal(store.has('wait'), true);
  assert.equal(store.has('done'), false);
});

test('new Codex activity restores an expired agent and its metadata', () => {
  const store = new Store();
  const adapter = new CodexAdapter(store) as any;
  const tracked = { id: 'codex:test', titled: false };
  const timestamp = new Date().toISOString();
  adapter.apply(tracked, { type: 'session_meta', timestamp, payload: { cwd: 'C:/project' } });
  adapter.apply(tracked, { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ text: 'Example' }] } });
  store.remove(tracked.id);
  adapter.apply(tracked, { type: 'response_item', timestamp, payload: { type: 'function_call', name: 'shell', arguments: '{}' } });
  const snapshot = store.snapshot();
  assert.equal(snapshot.type, 'snapshot');
  if (snapshot.type !== 'snapshot') return;
  assert.equal(snapshot.agents[0].title, 'Example');
  assert.equal(snapshot.agents[0].project, 'project');
  assert.equal(snapshot.agents[0].activity, 'bash');
});

test('a session killed mid-tool or mid-prompt still leaves eventually', () => {
  const store = new Store();
  const old = Date.now() - BUSY_LEAVE_AFTER_MS - 60_000;
  for (const id of ['tool', 'wait']) store.update(id, { source: 'claude' }, old);
  store.tool('tool', 'Read', 'read', 'Читает a.ts', old);
  store.waiting('wait', 'Claude needs your permission to use Bash', old);
  (store as any).tick();
  assert.equal(store.has('tool'), false);
  assert.equal(store.has('wait'), false);
});

test('only notifications that need the user count as waiting', () => {
  assert.equal(needsUser({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }), true);
  assert.equal(needsUser({ notification_type: 'elicitation_dialog' }), true);
  assert.equal(needsUser({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), false);
  assert.equal(needsUser({ notification_type: 'auth_success', message: 'Login successful' }), false);
  assert.equal(needsUser({ message: 'Claude needs your permission to use Bash' }), true);
  assert.equal(needsUser({ message: 'Claude is waiting for your input' }), false);
});

test('Codex bookkeeping does not bring back an agent that went home', () => {
  const store = new Store();
  const adapter = new CodexAdapter(store) as any;
  const tracked = { id: 'codex:quiet', titled: false };
  const timestamp = new Date().toISOString();
  adapter.apply(tracked, { type: 'session_meta', timestamp, payload: { cwd: 'C:/project' } });
  store.remove(tracked.id);
  for (const type of ['token_count', 'item_completed', 'task_complete'])
    adapter.apply(tracked, { type: 'event_msg', timestamp, payload: { type } });
  adapter.apply(tracked, { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ text: '<environment_context>…' }] } });
  assert.equal(store.has(tracked.id), false);
});

test('Codex agent restored after turn_context keeps its title and new context', () => {
  const store = new Store();
  const adapter = new CodexAdapter(store) as any;
  const tracked = { id: 'codex:ctx', titled: false };
  const timestamp = new Date().toISOString();
  adapter.apply(tracked, { type: 'session_meta', timestamp, payload: { cwd: 'C:/project' } });
  adapter.apply(tracked, { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ text: 'Real title' }] } });
  store.remove(tracked.id);
  adapter.apply(tracked, { type: 'turn_context', timestamp, payload: { cwd: 'C:/other', model: 'gpt-x' } });
  assert.equal(store.has(tracked.id), false);
  adapter.apply(tracked, { type: 'event_msg', timestamp, payload: { type: 'task_started' } });
  const snapshot = store.snapshot();
  if (snapshot.type !== 'snapshot') return assert.fail();
  assert.equal(snapshot.agents[0].title, 'Real title');
  assert.equal(snapshot.agents[0].project, 'other');
  assert.equal(snapshot.agents[0].model, 'gpt-x');
});

test('Claude agent that comes back keeps its title', () => {
  const store = new Store();
  const adapter = new ClaudeAdapter(store) as any;
  const tracked = { id: 'session', titled: false };
  const timestamp = new Date().toISOString();
  adapter.apply(tracked, { type: 'custom-title', customTitle: 'Офис для агентов', sessionId: 'session' });
  adapter.apply(tracked, { type: 'user', timestamp, cwd: 'C:/dev/land.inc', message: { role: 'user', content: 'Сделай прототип' } });
  store.remove(tracked.id);
  adapter.apply(tracked, { type: 'assistant', timestamp, cwd: 'C:/dev/land.inc', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] } });
  const snapshot = store.snapshot();
  if (snapshot.type !== 'snapshot') return assert.fail();
  assert.equal(snapshot.agents[0].title, 'Офис для агентов');
  assert.equal(snapshot.agents[0].activity, 'read');
});

test('an agent brought back by a hook keeps the identity it left with', () => {
  const store = new Store();
  store.update('s', { source: 'claude', title: 'Офис для агентов', project: 'land.inc', cwd: 'C:/dev/land.inc' });
  store.remove('s');
  // What onClaudeHook does for a session it does not have: only source, cwd and project.
  store.update('s', { source: 'claude', cwd: 'C:/dev/land.inc', project: 'land.inc' });
  store.waiting('s', 'Claude needs your permission to use Bash', Date.now());
  const snapshot = store.snapshot();
  if (snapshot.type !== 'snapshot') return assert.fail();
  assert.equal(snapshot.agents[0].title, 'Офис для агентов');
  assert.equal(snapshot.agents[0].activity, 'wait');
});

test('a new prompt drops the unfinished tool of a killed turn', () => {
  const store = new Store();
  const old = Date.now() - 60_000;
  store.update('s', { source: 'claude' }, old);
  store.tool('s', 'Read', 'read', 'Читает a.ts', old);
  store.newTurn('s', 'Читает задачу', Date.now());
  (store as any).tick();
  const snapshot = store.snapshot();
  if (snapshot.type !== 'snapshot') return assert.fail();
  assert.equal(snapshot.agents[0].activity, 'think');
  assert.equal((store as any).agents.get('s').pendingTool, undefined);
});

test('reasoning mid-turn keeps the running tool pending', () => {
  const store = new Store();
  store.update('s', { source: 'codex' });
  store.tool('s', 'shell', 'bash', 'npm test', Date.now());
  store.thinking('s', 'Размышляет', Date.now());
  assert.equal((store as any).agents.get('s').pendingTool?.name, 'shell');
});

test('a prompt seen by the hook and then by the transcript keeps the tool it started', () => {
  const store = new Store();
  const adapter = new ClaudeAdapter(store) as any;
  const tracked = { id: 's', titled: true };
  const prompted = Date.now() - 20_000;
  // Hooks arrive first: the prompt, then the tool that answers it.
  store.update('s', { source: 'claude' }, prompted);
  store.newTurn('s', 'Читает задачу', prompted + 50);
  store.tool('s', 'Read', 'read', 'Читает a.ts', prompted + 1_000);
  // The transcript poll catches up with the same prompt, stamped when it was sent.
  adapter.apply(tracked, { type: 'user', timestamp: new Date(prompted).toISOString(), cwd: 'C:/dev/land.inc', message: { role: 'user', content: 'Сделай прототип' } });
  const a = (store as any).agents.get('s');
  assert.equal(a.pendingTool?.name, 'Read');
  assert.equal(a.state.activity, 'read');
  (store as any).tick();
  assert.equal(a.state.activity, 'wait'); // the permission heuristic still fires for that Read
});
