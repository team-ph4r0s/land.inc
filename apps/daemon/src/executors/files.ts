import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';

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
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    return out.split(/\r?\n/).find((l) => l.trim())?.trim();
  } catch {
    return undefined;
  }
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
