import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const origin = 'http://localhost:5173';

test('daemon rejects unauthenticated HTTP and WebSocket and revokes connections on rotation', { timeout: 20_000 }, async (t) => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  reservation.close();
  await once(reservation, 'close');
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url)), '--fake-agents', '--no-real'], {
    env: { ...process.env, LAND_PORT: String(port), LAND_ALLOWED_ORIGINS: origin },
    windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = '';
  daemon.stderr.setEncoding('utf8').on('data', (chunk) => { error += chunk; });
  t.after(() => { daemon.kill(); });
  const base = 'http://127.0.0.1:' + port;
  const wsBase = 'ws://127.0.0.1:' + port;
  const get = (path: string, source?: string) => fetch(base + path, { headers: source ? { Origin: source } : {} });
  for (let attempts = 0; ; attempts++) {
    try { assert.equal((await get('/health')).status, 200); break; }
    catch (failure) {
      if (attempts === 100 || daemon.exitCode !== null) assert.fail(error || 'daemon startup timed out: ' + String((failure as Error).cause ?? failure));
    }
    await delay(40);
  }
  assert.equal((await get('/', origin)).status, 401);
  assert.equal((await get('/?token=invalid', origin)).status, 401);
  assert.equal((await get('/token')).status, 403);
  assert.equal((await get('/token', 'https://example.org')).status, 403);
  assert.equal((await fetch(base + '/hook', { method: 'POST', body: '{}' })).status, 204);

  const response = await get('/token', origin);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const { token } = await response.json() as { token: string };
  assert.equal((await get('/?token=' + token)).status, 200);
  const rejects = async (url: string, status = 401, from = origin) => {
    const ws = new WebSocket(url, { origin: from });
    const [rejection] = await once(ws, 'error');
    assert.ok(String(rejection).endsWith(String(status)), String(rejection));
  };
  await rejects(wsBase);
  await rejects(wsBase + '/?token=' + token, 403, 'https://example.org');

  const ws = new WebSocket(wsBase + '/?token=' + token, { origin });
  t.after(() => ws.terminate());
  const received = new Map<string, unknown>();
  const initialized = new Promise<void>((done) => {
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string };
      received.set(message.type, message);
      if (['models:updated', 'agents', 'settings', 'conversations.meta'].every((type) => received.has(type))) done();
    });
  });
  await initialized;
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'token.rotate', requestId: 'rotate' }));
  const [code] = await closed;
  assert.equal(code, 4001);
  assert.equal((received.get('ack') as { ok: boolean }).ok, true);
  assert.equal((await get('/?token=' + token)).status, 401);
  await rejects(wsBase + '/?token=' + token);
  const updated = await (await get('/token', origin)).json() as { token: string };
  assert.notEqual(updated.token, token);
  assert.equal((await get('/?token=' + updated.token)).status, 200);
});
