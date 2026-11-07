import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import type { Executor, ScanCandidate } from '@land/protocol';
import { blockedWindowsApps, cliCommand, compareVersions } from './executors/files.ts';

/**
 * «Сканер»: finds the agent CLIs wherever this computer keeps them. Static paths break on
 * machines where Codex Desktop, Claude Desktop, nvm, scoop or a custom folder put them elsewhere.
 */

const win = process.platform === 'win32';
const SKIP = new Set(['node_modules', '.git', '$recycle.bin', 'windowsapps', 'cache', 'code cache', 'gpucache']);

/** Breadth-first search for files named `names`, without following links and within a budget. */
export async function findFiles(root: string, names: readonly string[], maxDepth: number, limit = 50, maxDirs = 20_000): Promise<string[]> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const results: string[] = [];
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length && results.length < limit && visited < maxDirs) {
    const { path, depth } = queue.shift()!;
    visited++;
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      // Linked folders are never entered; a linked file (npm's bin under nvm) is fine — it is probed later.
      if (entry.isSymbolicLink()) {
        if (wanted.has(entry.name.toLowerCase()) && await isFile(full)) results.push(full);
        if (results.length >= limit) break;
        continue;
      }
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP.has(entry.name.toLowerCase())) queue.push({ path: full, depth: depth + 1 });
      } else if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
        results.push(full);
        if (results.length >= limit) break;
      }
    }
  }
  return results;
}

/** `<cmd> --version` without blocking the daemon. */
export function probeVersion(command: string, args: string[], timeoutMs = 4000): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolve) => {
    let done = false;
    let stdout = '';
    const finish = (result: { ok: boolean; version?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args, '--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false });
      return;
    }
    const timer = setTimeout(() => { killTree(child.pid); child.kill('SIGKILL'); finish({ ok: false }); }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { if (stdout.length < 128 * 1024) stdout += chunk; });
    child.stderr?.resume();
    child.once('error', () => finish({ ok: false }));
    child.once('close', (code) => finish(code === 0
      ? { ok: true, version: stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] }
      : { ok: false }));
  });
}

/** An npm shim runs node, which runs the native CLI: a timeout must stop all of them. */
function killTree(pid: number | undefined): void {
  if (!pid || !win) return;
  try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => {}); }
  catch { /* The direct kill below still runs. */ }
}

/** `run` over `items`, at most `width` at a time. */
async function pool<T, R>(items: T[], width: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await run(items[i], i); }
  }));
  return out;
}

interface Spec { name: string; packages: string[] }
export const SPECS: Record<Executor, Spec> = {
  claude: { name: 'claude', packages: ['@anthropic-ai/claude-code'] },
  codex: { name: 'codex', packages: ['@openai/codex'] },
  antigravity: { name: 'agy', packages: ['agy', '@google/agy', '@google/antigravity'] },
};

/** A folder to look in: `depth` 0 checks only the folder itself. */
interface Place { dir: string; depth: number; source: string }

export function places(executor: Executor, env: NodeJS.ProcessEnv = process.env, home = homedir()): Place[] {
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const list: Place[] = (env.PATH ?? '').split(delimiter).map((dir) => dir.replace(/^"|"$/g, ''))
    .filter((dir) => dir && isAbsolute(dir)).map((dir) => ({ dir, depth: 0, source: 'PATH' }));
  const add = (source: string, depth: number, ...dirs: (string | undefined)[]) => {
    for (const dir of dirs) if (dir) list.push({ dir, depth, source });
  };
  if (win) {
    add('npm', 0, join(roaming, 'npm'), join(local, 'npm'), env.NVM_SYMLINK, env.VOLTA_HOME && join(env.VOLTA_HOME, 'bin'), join(local, 'Volta', 'bin'),
      env.PNPM_HOME, join(local, 'pnpm'), join(home, '.bun', 'bin'), join(home, 'scoop', 'shims'), join(local, 'Microsoft', 'WinGet', 'Links'),
      env.ProgramFiles && join(env.ProgramFiles, 'nodejs'));
    add('nvm', 1, env.NVM_HOME ?? join(roaming, 'nvm'));
  } else {
    add('npm', 0, join(home, '.npm-global', 'bin'), join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'),
      '/usr/local/bin', '/opt/homebrew/bin');
    add('nvm', 3, join(home, '.nvm', 'versions', 'node'));
  }
  if (executor === 'claude') {
    add('Claude Desktop', 4, join(local, 'Claude-Data'), join(local, 'AnthropicClaude'), join(local, 'Claude'));
    add('Claude Code', 1, join(home, '.claude', 'local'), join(home, '.local', 'bin'));
    if (!win) add('Claude Desktop', 5, join(home, 'Library', 'Application Support', 'Claude'));
  } else if (executor === 'codex') {
    // Only the vendors' own folders are searched deeply: a file merely named codex.exe elsewhere is not run.
    add('Codex Desktop', 2, join(local, 'OpenAI', 'Codex', 'bin'), join(local, 'Programs', 'Codex'));
    if (!win) add('Codex Desktop', 3, '/Applications/Codex.app/Contents/Resources');
  } else {
    add('Antigravity', 2, join(local, 'agy'), join(local, 'Programs', 'Antigravity'), join(local, 'Programs', 'Antigravity IDE'));
    add('Antigravity', 0, join(home, '.local', 'bin'));
  }
  return list;
}

function fileNames(name: string): string[] {
  return win ? [name + '.exe', name + '.cmd', name + '.bat', name] : [name];
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** Every copy of the executor's CLI on disk, checked with `--version`; the best one first. */
export async function scanExecutor(executor: Executor, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<ScanCandidate[]> {
  const { name, packages } = SPECS[executor];
  const names = fileNames(name);
  const found = new Map<string, string>();
  for (const place of places(executor, env, home)) {
    const files = place.depth === 0
      ? (await Promise.all(names.map(async (file) => (await isFile(join(place.dir, file))) ? join(place.dir, file) : ''))).filter(Boolean)
      : await findFiles(place.dir, names, place.depth, 30, 4_000);
    for (const file of files) {
      const key = win ? file.toLowerCase() : file;
      if (!found.has(key) && !blockedWindowsApps(file) && fileNames(name).includes(basename(file).toLowerCase())) found.set(key, file + '\0' + place.source);
    }
  }
  const candidates = await pool([...found.values()].slice(0, 20), 3, async (entry, order) => {
    const [path, source] = entry.split('\0');
    const cmd = cliCommand(path, name, packages);
    const probe = cmd ? await probeVersion(cmd.command, cmd.args) : { ok: false };
    return { candidate: { executor, path, source, works: probe.ok, ...(probe.version ? { version: probe.version } : {}) } as ScanCandidate, order };
  });
  // Working first, then the newest version, then the order of `places` (PATH wins a tie).
  candidates.sort((a, b) => Number(b.candidate.works) - Number(a.candidate.works) ||
    compareVersions(b.candidate.version ?? '0', a.candidate.version ?? '0') || a.order - b.order);
  return candidates.map((c) => c.candidate);
}

export async function scanAgents(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<ScanCandidate[]> {
  const all: ScanCandidate[] = [];
  // One provider at a time keeps at most three probes running.
  for (const executor of Object.keys(SPECS) as Executor[]) all.push(...await scanExecutor(executor, env, home));
  return all;
}

/** The path to set for each provider that does not work now and has a working copy on disk. */
export function pickOverrides(candidates: ScanCandidate[], broken: Executor[]): Partial<Record<Executor, string>> {
  const out: Partial<Record<Executor, string>> = {};
  for (const executor of broken) {
    const best = candidates.find((c) => c.executor === executor && c.works);
    if (best) out[executor] = best.path;
  }
  return out;
}
