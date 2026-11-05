import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g,
  /(^|\n)\s*(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN)\s*=\s*[^\n]+/g,
];
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /system\s+override/i,
  /(?:rm\s+-rf|remove-item\s+-recurse|format\s+[a-z]:|curl[^\n|]*\|\s*(?:sh|bash))/i,
];

export function createSessionToken(): string { return randomBytes(32).toString('hex'); }

export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented || !/^[a-f0-9]{64}$/i.test(presented) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(presented, 'hex'));
}

export function authorizeRequest(headers: IncomingHttpHeaders, expectedToken: string, expectedHost: string): boolean {
  const host = typeof headers.host === 'string' ? headers.host : '';
  const token = typeof headers['x-land-token'] === 'string' ? headers['x-land-token'] : undefined;
  return host === expectedHost && tokenMatches(expectedToken, token);
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED_BY_AGENTIC_SHIELD]'), value);
}

export function containsPromptInjection(value: string): boolean { return INJECTION_PATTERNS.some((pattern) => pattern.test(value)); }

export function validateInterAgentPayload(value: string): string {
  const redacted = redactSecrets(value);
  if (containsPromptInjection(redacted)) throw new Error('Межагентное сообщение заблокировано agentic-shield');
  return redacted;
}

export function envelope(value: string): { open: string; close: string; body: string } {
  const token = randomBytes(12).toString('hex');
  return { open: `<<<LAND_DATA_${token}>>>`, close: `<<<END_LAND_DATA_${token}>>>`, body: redactSecrets(value) };
}

export function sanitizeWorkspacePath(candidate: string, allowedRoot: string): string {
  if (!isAbsolute(candidate) || !isAbsolute(allowedRoot)) throw new Error('Путь должен быть абсолютным');
  const resolved = resolve(candidate);
  const root = resolve(allowedRoot);
  if (parse(resolved).root === resolved) throw new Error('Корень диска запрещён');
  const relativePath = relative(root, resolved);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.includes(`..${sep}`)) throw new Error('Путь выходит за пределы рабочего каталога');
  const forbidden = [resolve(process.env.SystemRoot ?? 'C:\\Windows'), resolve('C:\\Program Files'), resolve('C:\\ProgramData'), '/etc', '/proc', '/usr', '/bin', '/System', joinHome('.ssh'), joinHome('.gnupg'), joinHome('.aws')];
  if (forbidden.some((path) => resolved.toLowerCase() === path.toLowerCase() || resolved.toLowerCase().startsWith(`${path.toLowerCase()}${sep}`))) throw new Error('Системный каталог запрещён');
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (real.toLowerCase() !== resolved.toLowerCase()) throw new Error('Символические ссылки в рабочем пути запрещены');
    if (lstatSync(resolved).isSymbolicLink()) throw new Error('Символические ссылки в рабочем пути запрещены');
  }
  return resolved;
}

export interface WorkspaceSnapshot { root: string; files: Map<string, string>; }

export function snapshotFiles(root: string, paths: string[]): WorkspaceSnapshot {
  const files = new Map<string, string>();
  for (const path of paths) {
    const safe = sanitizeWorkspacePath(path, root);
    if (statSync(safe).isFile()) files.set(safe, createHash('sha256').update(requireFile(safe)).digest('hex'));
  }
  return { root: resolve(root), files };
}

function requireFile(path: string): Buffer { return readFileSync(path); }
function joinHome(name: string): string { return join(homedir(), name); }
