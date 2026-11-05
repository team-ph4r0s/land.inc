import type { ChildProcess } from 'node:child_process';

export interface HangRecord { taskId: string; pid?: number; lastActivity: number; warnedAt?: number; }

/** Detects silent CLI processes without killing them; callers choose soft retry or tree termination. */
export class HangDetector {
  private readonly timeoutMs: number;
  private readonly records = new Map<string, HangRecord>();
  constructor(timeoutMs = Number(process.env.LAND_HANG_TIMEOUT_MS ?? 120_000)) { this.timeoutMs = Math.max(1_000, timeoutMs); }
  start(taskId: string, process?: ChildProcess): void { this.records.set(taskId, { taskId, pid: process?.pid, lastActivity: Date.now() }); }
  touch(taskId: string): void { const record = this.records.get(taskId); if (record) this.records.set(taskId, { ...record, lastActivity: Date.now(), warnedAt: undefined }); }
  stop(taskId: string): void { this.records.delete(taskId); }
  check(now = Date.now()): HangRecord[] {
    const stale: HangRecord[] = [];
    for (const record of this.records.values()) if (now - record.lastActivity >= this.timeoutMs && !record.warnedAt) {
      const warned = { ...record, warnedAt: now };
      this.records.set(record.taskId, warned);
      stale.push(warned);
    }
    return stale;
  }
}
