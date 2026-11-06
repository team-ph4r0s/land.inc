import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/**
 * A folder the daemon may start a CLI in or write an artifact to: absolute, inside its root,
 * not a drive root, a system folder or a credentials folder, and not reached through a link.
 */
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

function joinHome(name: string): string { return join(homedir(), name); }
