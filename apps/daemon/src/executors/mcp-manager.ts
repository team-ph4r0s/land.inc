import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { McpInstallRequest, McpServerName, McpServerStatus, McpStatus } from '@land/protocol';

const execFileAsync = promisify(execFile);
export const REQUIRED_MCP_SERVERS: readonly McpServerName[] = ['markitdown', 'context-budget', 'strategic-compact', 'agentic-shield'];
const PACKAGE_NAMES: Record<McpServerName, string> = {
  markitdown: 'markitdown-mcp',
  'context-budget': '@land/context-budget-mcp',
  'strategic-compact': '@land/strategic-compact-mcp',
  'agentic-shield': '@land/agentic-shield-mcp',
};

export interface McpManagerOptions {
  runtimeDir?: string;
  now?: () => number;
  runner?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export class McpManager {
  runtimeDir: string;
  private readonly now: () => number;
  private readonly runner: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: McpManagerOptions = {}) {
    this.runtimeDir = resolve(options.runtimeDir ?? join(homedir(), '.land', 'mcp-runtime'));
    this.now = options.now ?? Date.now;
    this.runner = options.runner ?? (async (command, args) => execFileAsync(command, args, { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 }));
  }

  async audit(runtimeDir = this.runtimeDir): Promise<McpStatus[]> {
    return Promise.all(REQUIRED_MCP_SERVERS.map((name) => this.check(name, runtimeDir)));
  }

  async check(name: McpServerName, runtimeDir = this.runtimeDir): Promise<McpStatus> {
    const checkedAt = this.now();
    const packageJson = join(runtimeDir, 'node_modules', PACKAGE_NAMES[name], 'package.json');
    try {
      const raw = await readFile(packageJson, 'utf8');
      const packageInfo = JSON.parse(raw) as { version?: unknown };
      const version = typeof packageInfo.version === 'string' ? packageInfo.version : undefined;
      return { name, status: 'installed', ...(version ? { version } : {}), command: 'node', checkedAt };
    } catch {
      // An existing executable in PATH is useful even when the package was installed by pip/uvx.
      for (const command of [name, `mcp-${name}`]) {
        try {
          await this.runner(process.platform === 'win32' ? `${command}.cmd` : command, ['--version']);
          return { name, status: 'installed', command, checkedAt };
        } catch {
          // continue to the next supported launcher
        }
      }
      return { name, status: 'missing', note: `Пакет ${PACKAGE_NAMES[name]} не найден`, checkedAt };
    }
  }

  configForSession(sessionId: string): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } {
    const root = this.runtimeDir;
    const mcpServers = Object.fromEntries(REQUIRED_MCP_SERVERS.map((name) => [name, {
      command: process.execPath,
      args: [join(root, 'node_modules', PACKAGE_NAMES[name], 'server.js')],
      env: { LAND_MCP_SERVER: name, LAND_MCP_SESSION: sessionId, LAND_MCP_DIRECTIVE: this.systemDirective() },
    }]));
    return { mcpServers };
  }

  systemDirective(): string {
    return 'Обязательные MCP: пропускай чтение PDF/DOCX/XLSX/HTML/изображений через markitdown; контролируй бюджет через context-budget; при переполнении сжимай промежуточный контекст через strategic-compact; все опасные действия и внешние данные пропускай через agentic-shield.';
  }

  writeSessionConfig(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'session';
    try { mkdirSync(this.runtimeDir, { recursive: true }); }
    catch {
      this.runtimeDir = join(process.cwd(), '.land', 'mcp-runtime');
      mkdirSync(this.runtimeDir, { recursive: true });
    }
    const configDir = join(dirname(this.runtimeDir), 'mcp-configs');
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, `${safeId}-mcp.json`);
    writeFileSync(path, JSON.stringify(this.configForSession(sessionId), null, 2), 'utf8');
    return path;
  }

  async install(request: McpInstallRequest, onProgress: (name: McpServerName, progress: number, message: string) => void = () => {}): Promise<McpStatus[]> {
    const selected = [...new Set(request.servers)].filter((name): name is McpServerName => REQUIRED_MCP_SERVERS.includes(name));
    if (!selected.length) return this.audit();
    const runtimeDir = resolve(request.runtimeDir ?? this.runtimeDir);
    await mkdir(dirname(join(runtimeDir, 'package.json')), { recursive: true });
    for (let index = 0; index < selected.length; index += 1) {
      const name = selected[index];
      onProgress(name, Math.round(index / selected.length * 100), `Установка ${name}`);
      await this.runner(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', runtimeDir, PACKAGE_NAMES[name]]);
      onProgress(name, Math.round((index + 1) / selected.length * 100), `${name} установлен`);
    }
    return this.audit(runtimeDir);
  }
}

export function mcpStatusCounts(statuses: McpStatus[]): Record<McpServerStatus, number> {
  return statuses.reduce<Record<McpServerStatus, number>>((counts, status) => ({ ...counts, [status.status]: (counts[status.status] ?? 0) + 1 }), {
    installed: 0, available: 0, missing: 0, unhealthy: 0, installing: 0,
  });
}
