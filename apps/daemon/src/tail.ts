import { openSync, readSync, closeSync, statSync } from 'node:fs';

/**
 * Incrementally reads complete JSON lines appended to a file. Agents append to
 * their transcripts while they work, so every poll only reads the new bytes;
 * a trailing partial line is kept until its newline arrives.
 */
export class JsonlTail {
  private offset = 0;
  private rest = '';
  private decoder = new TextDecoder();

  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Returns parsed records appended since the previous call. */
  read(): unknown[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Truncated or rewritten: start over.
      this.offset = 0;
      this.rest = '';
      this.decoder = new TextDecoder();
    }
    if (size === this.offset) return [];

    let fd: number;
    try { fd = openSync(this.path, 'r'); } catch { return []; }
    const chunks: string[] = [];
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      while (this.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        chunks.push(this.decoder.decode(buf.subarray(0, n), { stream: true }));
      }
    } finally {
      closeSync(fd);
    }

    const text = this.rest + chunks.join('');
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    const out: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Ignore a corrupt line rather than losing the whole file.
      }
    }
    return out;
  }
}
