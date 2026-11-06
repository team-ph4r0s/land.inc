import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Validator<T> = (value: unknown) => value is T;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function jsonFile(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return undefined; }
}

function atomic(path: string, text: string): void {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, path); break; }
      catch (error) {
        if (attempt === 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  } finally { rmSync(tmp, { force: true }); }
}

/** Synchronous transactions serialize callers in the daemon, including read/modify/write. */
export function readJson<T>(path: string, valid: Validator<T>): T | undefined {
  for (const file of [path + '.tmp', path, path + '.bak']) {
    const data = jsonFile(file);
    if (!valid(data)) continue;
    if (file !== path) {
      try {
        atomic(path, JSON.stringify(data, null, 2));
        if (file.endsWith('.tmp')) rmSync(file, { force: true });
      } catch { /* Still return the valid recovery copy. */ }
    }
    return data;
  }
  return undefined;
}

export function writeJson<T>(path: string, data: T, valid: Validator<T>): void {
  const text = JSON.stringify(data, null, 2);
  if (text === undefined || !valid(JSON.parse(text))) throw new Error('Некорректные данные JSON');
  mkdirSync(dirname(path), { recursive: true });
  const previous = readJson(path, valid);
  atomic(path + '.bak', previous === undefined ? text : JSON.stringify(previous, null, 2));
  atomic(path, text);
  // Older versions used a fixed .tmp as a recovery copy.
  try { rmSync(path + '.tmp', { force: true }); } catch { /* Already committed. */ }
}
