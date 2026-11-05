import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from './types.ts';

export interface CliProbe {
  ok: boolean;
  command: Command;
  code: number | null;
  error?: string;
  output?: string;
}

export interface CliCandidate {
  command: Command;
  path: string;
  source: 'npm-global' | 'path' | 'app-execution-alias' | 'environment';
}

const WINDOWS_APPS = /[\\/]Program Files[\\/]WindowsApps(?:[\\/]|$)/i;

export function isWindowsAppsPath(path: string): boolean {
  return process.platform === 'win32' && WINDOWS_APPS.test(path);
}

export function probeCommand(command: Command, args: string[] = ['--version'], timeout = 3_000): CliProbe {
  try {
    const result = spawnSync(command.command, [...command.args, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      shell: false,
      maxBuffer: 128 * 1024,
    });
    const error = result.error as NodeJS.ErrnoException | undefined;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return { ok: !error && result.status === 0, command, code: result.status, ...(error ? { error: error.code ?? error.message } : {}), output };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return { ok: false, command, code: null, error: e.code ?? e.message };
  }
}

function packageEntry(root: string, name: string, packageName: string): Command | undefined {
  try {
    const packageRoot = join(root, 'node_modules', packageName);
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name] ?? Object.values(pkg.bin ?? {})[0];
    if (!entry) return undefined;
    const script = resolve(packageRoot, entry);
    if (!existsSync(script) || !/\.(?:m?js|cjs)$/i.test(script)) return undefined;
    return { command: process.execPath, args: [script] };
  } catch {
    return undefined;
  }
}

function globalRoots(): string[] {
  const roots = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm') : undefined,
    join(homedir(), 'AppData', 'Roaming', 'npm'),
    join(homedir(), '.npm-global'),
  ].filter((root): root is string => !!root);
  return [...new Set(roots)];
}

function pathEntries(name: string): string[] {
  const path = process.env.PATH ?? '';
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const result: string[] = [];
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, process.platform === 'win32' && !/\.[^.]+$/.test(name) ? `${name}${extension}` : name);
      if (existsSync(candidate)) result.push(candidate);
    }
  }
  return [...new Set(result)];
}

/** Returns candidates in safe priority order. WindowsApps paths are data only and never spawnable. */
export function locateCli(name: string, packageName: string, explicit?: string): CliCandidate[] {
  const out: CliCandidate[] = [];
  const add = (path: string, source: CliCandidate['source']) => {
    if (!path || isWindowsAppsPath(path) || out.some((candidate) => candidate.path.toLowerCase() === path.toLowerCase())) return;
    const command = packageEntry(dirname(path), name, packageName) ?? ({ command: path, args: [] } satisfies Command);
    out.push({ command, path, source });
  };
  if (explicit) add(explicit, 'environment');
  for (const root of globalRoots()) {
    const command = packageEntry(root, name, packageName);
    if (command) out.push({ command, path: command.args[0], source: 'npm-global' });
  }
  for (const path of pathEntries(name)) add(path, 'path');
  if (process.platform === 'win32') {
    const aliasRoot = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps');
    for (const path of [join(aliasRoot, `${name}.exe`), join(aliasRoot, name)]) add(path, 'app-execution-alias');
  }
  return out;
}

export function resolveCli(name: string, packageName: string, explicit?: string, probeArgs = ['--version']): CliProbe | undefined {
  for (const candidate of locateCli(name, packageName, explicit)) {
    const probe = probeCommand(candidate.command, probeArgs);
    if (probe.ok) return probe;
    if (probe.error !== 'EPERM' && probe.error !== 'EACCES') continue;
  }
  return undefined;
}
