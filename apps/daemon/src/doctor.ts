import { Resolver } from 'node:dns/promises';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_IDS, type DoctorCheck, type LandSettings, type ProviderInfo } from '@land/protocol';
import { ClaudeExecutor } from './executors/claude.ts';
import { CodexExecutor } from './executors/codex.ts';
import { AntigravityExecutor } from './executors/antigravity.ts';
import { verifyExecutableRunnable } from './executors/files.ts';
import type { Executor } from './executors/types.ts';
import { ModelCatalogService } from './model-catalog.ts';
import { McpService } from './mcp.ts';
import { LAND_HOME, SettingsService } from './settings.ts';

export function providerExecutors(settings: () => LandSettings): Executor[] {
  return [
    new ClaudeExecutor({ pathOverride: () => settings().providers.claude.pathOverride }),
    new CodexExecutor({ pathOverride: () => settings().providers.codex.pathOverride }),
    new AntigravityExecutor({ pathOverride: () => settings().providers.antigravity.pathOverride }),
  ];
}

export class DoctorService {
  private home: string;
  private executors: Executor[];
  private catalog: ModelCatalogService;
  private mcp: McpService;
  private providersCache?: ProviderInfo[];
  /** Running CLI processes, for the daemon line (1.4's «Здоровье» tab). */
  activeProcesses: () => number = () => 0;
  constructor(home: string, executors: Executor[], catalog: ModelCatalogService, mcp: McpService) {
    this.home = home;
    this.executors = executors;
    this.catalog = catalog;
    this.mcp = mcp;
  }

  providers(refresh = false): ProviderInfo[] {
    if (!refresh && this.providersCache) return this.providersCache;
    return this.providersCache = this.executors.map((executor) => {
      const cmd = executor.command();
      if (!cmd) return { executor: executor.id, available: false, note: 'CLI не найден или не запускается' };
      const verified = verifyExecutableRunnable(cmd);
      return { executor: executor.id, available: verified.ok, path: cmd.args[0] ?? cmd.command, version: verified.version,
        ...(!verified.ok ? { note: 'Не удалось выполнить проверку версии CLI' } : {}) };
    });
  }

  async run(): Promise<DoctorCheck[]> {
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;
    const checks: DoctorCheck[] = [{ id: 'node', title: 'Node.js', status: nodeOk ? 'ok' : 'fail', detail: process.version + ' (требуется 24 или новее)' }];
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const uptime = Math.round(process.uptime() / 60);
    checks.push({ id: 'daemon', title: 'Демон', status: rss > 1_024 ? 'warn' : 'ok',
      detail: `работает ${uptime} мин · память ${rss} МиБ · CLI-процессов: ${this.activeProcesses()}` });
    let probe: string | undefined;
    try {
      probe = mkdtempSync(join(this.home, '.doctor-'));
      writeFileSync(join(probe, 'probe'), '', { flag: 'wx' });
      checks.push({ id: 'land-home', title: 'Права на папку данных', status: 'ok', detail: this.home });
    } catch {
      checks.push({ id: 'land-home', title: 'Права на папку данных', status: 'fail', detail: 'Нет папки или прав на запись: ' + this.home, fix: 'land-home' });
    } finally {
      if (probe) {
        try { rmSync(join(probe, 'probe'), { force: true }); rmdirSync(probe); }
        catch { /* The probe does not contain user data. */ }
      }
    }
    for (const provider of this.providers(true)) {
      checks.push({ id: 'cli-' + provider.executor, title: provider.executor, status: provider.available ? 'ok' : 'fail',
        detail: [provider.path, provider.version, provider.note].filter(Boolean).join(' · ') });
    }
    const catalog = this.catalog.get();
    const notes = Object.values(catalog.notes);
    checks.push({ id: 'models', title: 'Каталог моделей', status: notes.length ? 'warn' : 'ok',
      detail: catalog.models.length + ' моделей' + (notes.length ? '. ' + notes.join('. ') : ''), ...(notes.length ? { fix: 'models' } : {}) });
    for (const mcp of this.mcp.status()) {
      checks.push({ id: mcp.id, title: mcp.id, status: mcp.state === 'active' || !mcp.enabled ? 'ok' : 'warn',
        detail: !mcp.enabled ? 'Выключен в настройках' : mcp.message ?? mcp.version ?? mcp.state,
        ...(mcp.enabled && ['missing', 'failed'].includes(mcp.state) ? { fix: 'mcp:' + mcp.id } : {}) });
    }
    try {
      const fs = statfsSync(probe ? this.home : process.cwd());
      const mib = Math.floor(fs.bavail * fs.bsize / (1024 * 1024));
      checks.push({ id: 'disk', title: 'Свободное место', status: mib < 512 ? 'warn' : 'ok', detail: mib + ' МиБ доступно' });
    } catch { checks.push({ id: 'disk', title: 'Свободное место', status: 'warn', detail: 'Не удалось прочитать состояние диска' }); }

    const resolver = new Resolver({ timeout: 1500, tries: 1 });
    const hosts = ['api.anthropic.com', 'chatgpt.com', 'cloudcode-pa.googleapis.com'];
    const network = await Promise.all(hosts.map(async (host) => {
      try { await resolver.resolve4(host); return host + ' ✓'; }
      catch { return host + ' ✗'; }
    }));
    checks.push({ id: 'network', title: 'Доступность DNS провайдеров', status: network.some((result) => result.endsWith('✗')) ? 'warn' : 'ok', detail: network.join(', ') });
    return checks;
  }

  async fix(id: string): Promise<void> {
    if (id === 'land-home') { mkdirSync(this.home, { recursive: true }); return; }
    if (id === 'models') {
      for (const executor of this.executors) executor.refresh?.();
      await this.catalog.rescan();
      return;
    }
    const mcp = MCP_IDS.find((id_) => 'mcp:' + id_ === id);
    if (mcp) { await this.mcp.install(mcp); return; }
    throw new Error('Неизвестное исправление');
  }
}

if (import.meta.main) {
  const settings = new SettingsService();
  const executors = providerExecutors(() => settings.get());
  const catalog = new ModelCatalogService({ antigravityCommand: () => executors.find((cli) => cli.id === 'antigravity')?.command() });
  const mcp = new McpService();
  await Promise.all([catalog.rescan(), mcp.detect()]);
  for (const check of await new DoctorService(LAND_HOME, executors, catalog, mcp).run())
    console.log('[' + check.status + '] ' + check.title + ' — ' + check.detail);
}
