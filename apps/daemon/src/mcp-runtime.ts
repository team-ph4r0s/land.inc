import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findNpmCli } from './updates.ts';

const exec = promisify(execFile);
export const MCP_VERSION = '1.5.0';
const name = '@land/mcp-tools';
export const mcpEntry = (runtime: string) => join(runtime, 'node_modules', name, 'server.mjs');
const script = (runtime: string) => 'import { serveMcp } from ' + JSON.stringify(new URL('./mcp-stdio.ts', import.meta.url).href) +
  ';\nawait serveMcp(' + JSON.stringify(runtime) + ');\n';

export async function bundledInstalled(runtime: string): Promise<boolean> {
  try { return await readFile(mcpEntry(runtime), 'utf8') === script(runtime); }
  catch { return false; }
}

export async function installBundledMcp(runtime: string): Promise<string> {
  if (await bundledInstalled(runtime)) return MCP_VERSION;
  const source = join(runtime, 'bundled');
  const npm = findNpmCli();
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name, version: MCP_VERSION, private: true, type: 'module', files: ['server.mjs'] }));
  await writeFile(join(source, 'server.mjs'), script(runtime), 'utf8');
  await exec(process.execPath, [npm, 'install', '--prefix', runtime, '--cache', join(runtime, 'npm-cache'),
    '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--install-links', '--no-save', source],
  { shell: false, windowsHide: true, timeout: 30_000 });
  if (!(await bundledInstalled(runtime))) throw new Error('npm не установил локальный MCP');
  return MCP_VERSION;
}
