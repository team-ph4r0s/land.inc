import { randomBytes, timingSafeEqual } from 'node:crypto';

export class SessionToken {
  private token = randomBytes(32).toString('base64url');

  current(): string { return this.token; }

  rotate(): void { this.token = randomBytes(32).toString('base64url'); }

  matches(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || candidate.length !== this.token.length) return false;
    const input = Buffer.from(candidate);
    const expected = Buffer.from(this.token);
    return input.length === expected.length && timingSafeEqual(input, expected);
  }
}

export function requestUrl(target?: string): URL | undefined {
  if (!target?.startsWith('/') || target.startsWith('//') || target.includes('\\')) return undefined;
  try { return new URL(target, 'http://127.0.0.1'); } catch { return undefined; }
}
