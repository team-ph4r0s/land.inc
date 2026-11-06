import { execFile, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
export function killTree(child: ChildProcess, sync = false, done?: (error?: string) => void): void {
  if (!child.pid) return done?.();
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T', '/F'];
    if (sync) { spawnSync(taskkill, args, { windowsHide: true, shell: false, timeout: 5000 }); return; }
    execFile(taskkill, args, { windowsHide: true, shell: false, timeout: 5000 },
      (error, stdout, stderr) => done?.(error ? (stderr || stdout).trim() || error.message : undefined));
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
    done?.();
  } catch (error) {
    done?.((error as Error).message);
  }
}

export class ProcessSupervisor {
  private children = new Map<number, ChildProcess>();

  register(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    this.children.set(pid, child);
    child.once('close', () => this.children.delete(pid));
  }

  shutdown(): void {
    for (const child of this.children.values()) killTree(child, true);
    this.children.clear();
  }

  bind(): void {
    process.once('exit', () => this.shutdown());
    process.once('SIGINT', () => { this.shutdown(); process.exit(130); });
    process.once('SIGTERM', () => { this.shutdown(); process.exit(143); });
  }
}
