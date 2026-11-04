import { fork, spawn, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, realpathSync, appendFileSync, rmSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareRelease, version, APP_ROOT, validVersion } from '../apps/daemon/src/updates.ts';

export function installedRoot(base, fallback, key = 'active') {
  try {
    const saved = JSON.parse(readFileSync(join(base, 'active.json'), 'utf8'));
    const root = realpathSync(saved[key]);
    const rel = relative(realpathSync(join(base, 'versions')), root);
    if (!rel || isAbsolute(rel) || rel.startsWith('..') || resolve(root) === resolve(fallback) || !validVersion(version(root))) return fallback;
    return root;
  } catch { return fallback; }
}

export async function startOffice(options = {}) {
  const launchRoot = options.root ?? APP_ROOT;
  const dataRoot = options.dataRoot ?? join(homedir(), '.land');
  const dataFiles = ['tasks.json', 'tasks.json.tmp', 'teams.json', 'teams.json.tmp', 'dns-backups.json', 'dns-backups.json.tmp'];
  const base = join(launchRoot, '.land-updates');
  let root = installedRoot(base, launchRoot);
  let children = [];
  let daemon;
  let transition = true;
  let closing = false;
  let updating = false;
  mkdirSync(base, { recursive: true });
  console.log(`[land] launcher PID ${process.pid}, версия ${version(root)}`);
  const saveActive = (active, previous) => {
    const statePath = join(base, 'active.json');
    writeFileSync(statePath + '.tmp', JSON.stringify({ active, previous, version: version(active) }));
    renameSync(statePath + '.tmp', statePath);
  };
  const log = (message) => {
    console.log(`[update] ${message}`);
    appendFileSync(join(base, 'update.log'), `${new Date().toISOString()} ${message}\n`);
  };
  const status = (phase, message) => {
    log(message);
    if (daemon?.connected) daemon.send({ type: 'office.update.status', patch: { phase, message } });
  };
  const stopChildren = async () => {
    const procs = children;
    children = [];
    await Promise.all(procs.map((child) => new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', done);
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
    })));
  };
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    transition = true;
    await stopChildren();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const boot = async (target, booting = true) => {
    const env = { ...process.env, LAND_LAUNCH_ROOT: launchRoot, ...(booting ? { LAND_UPDATE_BOOTING: '1' } : {}) };
    const args = process.argv.includes('--demo') ? ['--demo'] : [];
    if (process.argv.includes('--fake-agents')) args.push('--fake-agents', '--no-real');
    daemon = fork(join(target, 'apps/daemon/src/main.ts'), args, { cwd: target, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env, detached: process.platform !== 'win32' });
    const vite = spawn(process.execPath, [join(target, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', process.env.LAND_OFFICE_PORT ?? '5173', '--strictPort'], { cwd: join(target, 'apps/office'), stdio: 'inherit', env, detached: process.platform !== 'win32' });
    children = [daemon, vite];
    for (const child of children) {
      child.on('exit', () => { if (!transition && !closing) void shutdown(1); });
      child.on('error', (error) => log(error.message));
    }
    daemon.on('message', (message) => {
      if (message?.type === 'office.update' && !updating && !closing && !transition) void install(message.release);
    });
    const until = Date.now() + (options.bootTimeoutMs ?? 45_000);
    while (Date.now() < until) {
      if (children.some((child) => child.exitCode !== null || child.signalCode !== null)) throw new Error('Новая версия завершилась при запуске');
      try {
        const response = await fetch(`http://127.0.0.1:${process.env.LAND_PORT ?? '4317'}/health`, { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        const page = await fetch(`http://127.0.0.1:${process.env.LAND_OFFICE_PORT ?? '5173'}`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && page.ok && health.version === version(target) && health.pid === daemon.pid) return;
      } catch { }
      await delay(250);
    }
    throw new Error('Офис не подтвердил готовность за 45 секунд');
  };

  const install = async (release) => {
    updating = true;
    const previous = root;
    let backup;
    let switching = false;
    try {
      const target = await (options.prepare ?? prepareRelease)(root, base, release, process.env.npm_execpath, (message) => status('preparing', message));
      backup = join(base, 'backups', `${Date.now()}`);
      mkdirSync(backup, { recursive: true });
      const missing = [];
      for (const name of dataFiles) {
        const source = join(dataRoot, name);
        if (existsSync(source)) copyFileSync(source, join(backup, name));
        else missing.push(name);
      }
      writeFileSync(join(backup, 'missing.json'), JSON.stringify(missing));
      status('switching', 'Посылка готова. Перезапускаем офис…');
      transition = true;
      switching = true;
      await stopChildren();
      await boot(target, true);
      saveActive(target, previous);
      root = target;
      daemon.send({ type: 'office.update.status', patch: { phase: 'done', message: `Добро пожаловать в офис ${release.version}!`, available: undefined } });
      transition = false;
      log(`Запущена версия ${release.version}`);
    } catch (error) {
      const message = String(error.stderr || error.message || error).slice(-4000);
      if (switching) {
        await stopChildren();
        if (backup) for (const name of dataFiles) {
          if (existsSync(join(backup, name))) copyFileSync(join(backup, name), join(dataRoot, name));
          else if (JSON.parse(readFileSync(join(backup, 'missing.json'), 'utf8')).includes(name)) rmSync(join(dataRoot, name), { force: true });
        }
        try { await boot(previous); root = previous; saveActive(previous, launchRoot); }
        catch (failure) { log(`Не удалось запустить прежнюю версию: ${failure.message}. Запустите npm run dev из исходного каталога.`); await shutdown(1); return; }
      }
      status('failed', `Обновление не установлено. Прежняя версия сохранена. ${message}`);
      transition = false;
    } finally { updating = false; }
  };

  try {
    await boot(root);
    transition = false;
    daemon.send({ type: 'office.update.status', patch: { phase: 'idle', message: 'Офис готов. Проверить, не приехала ли новая версия?' } });
  }
  catch (error) {
    await stopChildren();
    if (root !== launchRoot) {
      root = installedRoot(base, launchRoot, 'previous');
      try { await boot(root); saveActive(root, launchRoot); status('failed', 'Сохранённая версия не запустилась. Открыта прежняя версия офиса.'); transition = false; }
      catch (failure) { log(failure.message); await shutdown(1); }
    } else { log(error.message); await shutdown(1); }
  }
}
