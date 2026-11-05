import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  return paths(name)[0];
}

/** Probe a candidate before it is cached as an available CLI. Never uses a shell. */
export function verifyExecutableRunnable(candidateCommand: Command, args: string[] = ['--version']): boolean {
  try {
    const result = spawnSync(candidateCommand.command, [...candidateCommand.args, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 3_500, maxBuffer: 128 * 1024,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function paths(name: string): string[] {
  if (process.platform === 'win32') {
    const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
    const found: string[] = [];
    for (const dir of (process.env.PATH ?? '').split(';').filter(Boolean)) {
      for (const extension of extensions) {
        const candidate = join(dir, /\.[^.]+$/.test(name) ? name : `${name}${extension}`);
        if (existsSync(candidate)) found.push(candidate);
      }
    }
    return [...new Set(found)];
  }
  try {
    const out = execFileSync('which', [name], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** npm installs Unix, cmd and PowerShell shims together. Run the package's JS
 * entry with Node on Windows, keeping arguments out of a command shell. */
export function cliCommand(bin: string, name: string, packageName: string): Command | undefined {
  if (!existsSync(bin)) return undefined;
  if (process.platform === 'win32' && /[\\/]Program Files[\\/]WindowsApps(?:[\\/]|$)/i.test(bin)) return undefined;
  if (process.platform !== 'win32' || /\.(exe|com)$/i.test(bin)) return { command: bin, args: [] };
  try {
    const root = join(dirname(bin), 'node_modules', packageName);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
    if (typeof entry !== 'string') return undefined;
    const script = resolve(root, entry);
    if (!existsSync(script) || !/\.(m?js|cjs)$/i.test(script)) return undefined;
    const node = join(dirname(bin), 'node.exe');
    return { command: existsSync(node) ? node : process.execPath, args: [script] };
  } catch {
    return undefined;
  }
}

export function cliOnPath(name: string, packageName: string): Command | undefined {
  for (const bin of paths(name)) {
    const cmd = cliCommand(bin, name, packageName);
    if (cmd) return cmd;
  }
  return undefined;
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
