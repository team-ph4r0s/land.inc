import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Command } from './types.ts';

/** Small file helpers the executors share for finding their CLI and history. */

export function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** The first bytes of a file, enough for the metadata line of a transcript. */
export function head(path: string, bytes = 64 * 1024): string {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** The `"cwd":"…"` value in a transcript's first lines. */
export function headCwd(path: string): string | undefined {
  const cwd = head(path).match(/"cwd":"((?:\\.|[^"\\])*)"/);
  return cwd ? JSON.parse(`"${cwd[1]}"`) : undefined;
}

export function onPath(name: string): string | undefined {
  return paths(name).find((path) => !blockedWindowsApps(path));
}

function paths(name: string): string[] {
  const extensions = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat', ''] : [''];
  return (process.env.PATH ?? '').split(delimiter).map((dir) => dir.replace(/^"|"$/g, ''))
    .filter(isAbsolute).flatMap((dir) => extensions.map((extension) => join(dir, name + extension)).filter(existsSync));
}

export function blockedWindowsApps(path: string): boolean {
  return /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(path);
}

type VersionProbe = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;

export function verifyExecutableRunnable(cmd: Command, probe: VersionProbe = spawnSync): { ok: boolean; version?: string } {
  if (blockedWindowsApps(cmd.command) || cmd.args.some(blockedWindowsApps)) return { ok: false };
  const result = probe(cmd.command, [...cmd.args, '--version'], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 2000, maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) return { ok: false };
  const output = result.stdout;
  return { ok: true, version: output?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] };
}

function realFile(path: string): string | undefined {
  try {
    if (blockedWindowsApps(path) || !statSync(path).isFile()) return undefined;
    const real = realpathSync.native(path);
    return blockedWindowsApps(real) ? undefined : real;
  } catch { return undefined; }
}

/** npm shims are never interpreted by a shell. Only their package's declared bin is run. */
export function cliCommand(bin: string, name: string, packageName: string | readonly string[]): Command | undefined {
  if (!isAbsolute(bin) || !realFile(bin)) return undefined;
  if (/\.(?:[cm]?js)$/i.test(bin)) return { command: process.execPath, args: [bin] };
  if (process.platform === 'win32' && /\.(exe|com)$/i.test(bin)) return { command: bin, args: [] };
  const candidates = typeof packageName === 'string' ? [packageName] : packageName;
  for (const pkgName of candidates) {
    try {
      const root = join(dirname(bin), 'node_modules', pkgName);
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin?: string | Record<string, unknown> };
      const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
      if (typeof entry !== 'string') continue;
      const script = resolve(root, entry);
      if (relative(root, script).split(/[\\/]/)[0] === '..' || !realFile(script) || !/\.[cm]?js$/i.test(script)) continue;
      return { command: process.execPath, args: [script] };
    } catch { /* Try the next package. */ }
  }
  return process.platform === 'win32' ? undefined : { command: bin, args: [] };
}

/**
 * npm's global folders: an office started from a shortcut may not have them on PATH,
 * yet that is where `npm i -g` puts claude, codex and agy.
 */
export function npmGlobalBins(name: string): string[] {
  const dirs = process.platform === 'win32'
    ? [process.env.APPDATA && join(process.env.APPDATA, 'npm'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'npm'), join(homedir(), 'AppData', 'Roaming', 'npm')]
    : [join(homedir(), '.npm-global', 'bin'), join(homedir(), '.local', 'bin')];
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return [...new Set(dirs.filter((dir): dir is string => !!dir))].flatMap((dir) => extensions.map((extension) => join(dir, name + extension))).filter(existsSync);
}

export function findCli(name: string, packageName: string | readonly string[], candidates: string[] = [], probe = verifyExecutableRunnable): Command | undefined {
  for (const bin of new Set([...candidates, ...paths(name), ...npmGlobalBins(name)])) {
    const cmd = cliCommand(bin, name, packageName);
    if (cmd && probe(cmd).ok) return cmd;
  }
  return undefined;
}

export function cliOnPath(name: string, packageName: string): Command | undefined {
  return findCli(name, packageName);
}

export function findAgy(pathOverride?: string): Command | undefined {
  const installed = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : join(homedir(), '.local', 'bin', 'agy');
  const candidates = [pathOverride, process.env.LAND_AGY_BIN, installed].filter((value): value is string => !!value);
  return findCli('agy', ['agy', '@google/agy', '@google/antigravity'], candidates);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
