import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

for (const fails of [false, true]) {
  test(`supervisor ${fails ? 'restores prior code and data after a failed boot' : 'activates a healthy release and persists its path'}`, { timeout: 45_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'land-boot-'));
    const base = join(root, '.land-updates'), target = join(base, 'versions', 'candidate'), data = join(root, 'data');
    mkdirSync(target, { recursive: true }); mkdirSync(data);
    writeFileSync(join(data, 'tasks.json'), 'original-data');
    const daemonPort = await freePort(), officePort = await freePort();
    const fixture = (folder: string, version: string, broken: boolean) => {
      mkdirSync(join(folder, 'apps/daemon/src'), { recursive: true }); mkdirSync(join(folder, 'apps/office'), { recursive: true }); mkdirSync(join(folder, 'node_modules/vite/bin'), { recursive: true });
      writeFileSync(join(folder, 'package.json'), '{"type":"module"}');
      writeFileSync(join(folder, 'VERSION'), version);
      writeFileSync(join(folder, 'apps/daemon/src/main.ts'), broken ? `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(data, 'tasks.json'))}, 'changed-by-candidate'); writeFileSync(${JSON.stringify(join(data, 'teams.json'))}, 'created-by-candidate'); process.exit(1);` : `
        import {createServer} from 'node:http'; import {existsSync, unlinkSync} from 'node:fs';
        createServer((req,res)=>res.end(JSON.stringify({version:${JSON.stringify(version)},pid:process.pid}))).listen(Number(process.env.LAND_PORT),'127.0.0.1');
        process.on('message',message=>{
          if (message.type==='office.update.status' && message.patch.phase==='idle' && existsSync(${JSON.stringify(join(root, 'trigger'))})) { unlinkSync(${JSON.stringify(join(root, 'trigger'))}); process.send({type:'office.update',release:{version:'1.1'}}); }
        });`);
      writeFileSync(join(folder, 'node_modules/vite/bin/vite.js'), `import {createServer} from 'node:http'; createServer((req,res)=>res.end('office')).listen(Number(process.env.LAND_OFFICE_PORT),'127.0.0.1');`);
    };
    fixture(root, '1.0', false); fixture(target, '1.1', fails);
    writeFileSync(join(root, 'trigger'), 'update');
    const moduleUrl = new URL('../../../scripts/supervisor.mjs', import.meta.url).href;
    const worker = join(root, 'worker.mjs');
    writeFileSync(worker, `import {startOffice} from ${JSON.stringify(moduleUrl)}; await startOffice({root:${JSON.stringify(root)},dataRoot:${JSON.stringify(data)},bootTimeoutMs:8000,prepare:async()=>${JSON.stringify(target)}});`);
    let output = '';
    const child = spawn(process.execPath, [worker], { windowsHide: true, env: { ...process.env, LAND_PORT: String(daemonPort), LAND_OFFICE_PORT: String(officePort) } });
    child.stdout.on('data', (s) => { output += s; }); child.stderr.on('data', (s) => { output += s; });
    try {
      const until = Date.now() + 30_000;
      while (Date.now() < until && !output.includes(fails ? 'Прежняя версия сохранена' : 'Запущена версия 1.1')) {
        if (child.exitCode !== null) break;
        await delay(100);
      }
      assert.match(output, fails ? /Прежняя версия сохранена/ : /Запущена версия 1.1/);
      const saved = JSON.parse(readFileSync(join(base, 'active.json'), 'utf8'));
      assert.equal(saved.active, fails ? root : target);
      assert.equal(readFileSync(join(data, 'tasks.json'), 'utf8'), 'original-data');
      assert.equal(existsSync(join(data, 'teams.json')), false);
      assert.equal(readFileSync(join(root, 'VERSION'), 'utf8'), '1.0');
      assert.ok(existsSync(join(base, 'update.log')));
    } finally {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { }
      } else {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
      await delay(150);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
