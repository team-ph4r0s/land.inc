import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { DnsAdapter, DnsFamily, DnsProbe, DnsSettings, DnsState } from '@land/protocol';
import { readRecoverable, writeAtomic } from './tasks.ts';

type Adapter = Omit<DnsAdapter, 'revision'>;
export interface DnsBackend {
  supported: boolean;
  simulated?: boolean;
  read(): Promise<Adapter[]>;
  /** Must check before again after elevation, verify the result and roll back on failure. */
  change(before: Adapter, settings: DnsSettings): Promise<void>;
}
const HOSTS = ['chatgpt.com', 'api.anthropic.com', 'cloudcode-pa.googleapis.com'];
const exec = promisify(execFile);
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = () => readFileSync(new URL('./windows-dns.ps1', import.meta.url), 'utf8');
const encoded = (value: string) => Buffer.from(value, 'utf16le').toString('base64');
const revision = (a: Adapter) => createHash('sha256').update(JSON.stringify([a.id, a.index, a.name, a.ipv4.mode, a.ipv4.servers, a.ipv6.mode, a.ipv6.servers])).digest('hex');

function servers(value: unknown, family?: 4 | 6): string[] {
  if (!Array.isArray(value) || value.length > (family ? 8 : 16) || value.some((s) => typeof s !== 'string' || !isIP(s) || (family && isIP(s) !== family) || s === '0.0.0.0' || s === '::'))
    throw new Error('Укажите от одного до восьми IP-адресов DNS нужного семейства, без портов и URL');
  if (new Set(value).size !== value.length) throw new Error('Адреса DNS не должны повторяться');
  return [...value];
}

export function validateDnsSettings(value: unknown): DnsSettings {
  const v = value as DnsSettings | undefined;
  const family = (item: DnsFamily | undefined, ip: 4 | 6): DnsFamily => {
    if (!item || (item.mode !== 'auto' && item.mode !== 'manual')) throw new Error('Не удалось определить режим DNS. Обновите список адаптеров');
    if (item.mode === 'auto') return { mode: 'auto', servers: [] };
    const list = servers(item.servers, ip);
    if (!list.length) throw new Error(`Укажите основной DNS IPv${ip}`);
    return { mode: 'manual', servers: list };
  };
  return { ipv4: family(v?.ipv4, 4), ipv6: family(v?.ipv6, 6) };
}

export class WindowsDnsBackend implements DnsBackend {
  supported = process.platform === 'win32';
  async read(): Promise<Adapter[]> {
    try {
      const { stdout } = await exec(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script() + '\nConvertTo-Json -InputObject @(Get-LandDnsAdapters) -Depth 8 -Compress')], { windowsHide: true, timeout: 30_000, encoding: 'utf8', maxBuffer: 512 * 1024 });
      return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    } catch { throw new Error('Не удалось прочитать DNS Windows. Проверьте доступ к сетевым адаптерам и повторите обновление.'); }
  }
  async change(before: Adapter, settings: DnsSettings): Promise<void> {
    const payload = Buffer.from(JSON.stringify({ before, settings }), 'utf8').toString('base64');
    const command = script() + `\n$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\nInvoke-LandDnsChange $request`;
    // No elevated file writes, arbitrary paths or client-supplied commands. Only an exit code is returned.
    const wrapper = `$ErrorActionPreference = 'Stop'\ntry { $p = Start-Process -FilePath '${ps.replaceAll("'", "''")}' -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded(command)}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; Write-Output $p.ExitCode } catch { Write-Output 'UAC_CANCELLED' }`;
    let stdout: string;
    try {
      ({ stdout } = await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', wrapper], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 }));
    } catch {
      throw new Error('Не получен результат системного помощника. Обновите DNS и проверьте текущее состояние; копия прежних настроек сохранена');
    }
    const code = stdout.trim();
    if (code === '0') return;
    if (code === 'UAC_CANCELLED') throw new Error('Изменение DNS не выполнено: запрос прав администратора отменён или недоступен');
    if (code === '10') throw new Error('Не удалось применить DNS. Помощник восстановил настройки до попытки');
    if (code === '11') throw new Error('Не удалось применить DNS и подтвердить автоматический откат. Обновите состояние и восстановите сохранённые настройки');
    if (code === '12') throw new Error('Адаптер или его DNS изменились. Обновите список и повторите действие');
    if (code === '13') throw new Error('Системный помощник DNS уже выполняет другую операцию. Дождитесь её завершения и обновите состояние');
    throw new Error(`Системный помощник завершился с кодом ${code || 'неизвестно'}. Обновите состояние DNS`);
  }
}

/** No Windows or network operations: used by --fake-agents and tests. */
export class FakeDnsBackend implements DnsBackend {
  supported = true;
  simulated = true;
  adapters: Adapter[] = [{ id: '00000000-0000-0000-0000-000000000001', index: 1, name: 'Тестовый Wi-Fi', ipv4: { mode: 'auto', servers: ['192.0.2.53'] }, ipv6: { mode: 'auto', servers: [] } }];
  async read(): Promise<Adapter[]> { return structuredClone(this.adapters); }
  async change(before: Adapter, settings: DnsSettings): Promise<void> {
    const index = this.adapters.findIndex((a) => a.id === before.id);
    if (index < 0 || revision(this.adapters[index]) !== revision(before)) throw new Error('Адаптер изменился');
    this.adapters[index] = { ...before, ...structuredClone(settings) };
  }
}

export class DnsService {
  private backend: DnsBackend;
  private file: string | null;
  private backups: DnsState['backups'] = [];
  private busy = false;
  private loadError = false;
  get changing(): boolean { return this.busy; }
  constructor(options: { backend?: DnsBackend; file?: string | null } = {}) {
    this.backend = options.backend ?? new WindowsDnsBackend();
    this.file = options.file === undefined ? join(homedir(), '.land', 'dns-backups.json') : options.file;
    if (this.file && (existsSync(this.file) || existsSync(this.file + '.tmp'))) {
      try {
        const saved = JSON.parse(readRecoverable(this.file) ?? 'null');
        if (!Array.isArray(saved) || saved.length > 100) throw new Error('Invalid backups');
        this.backups = saved.map((b) => {
          if (!b || typeof b.id !== 'string' || typeof b.name !== 'string' || !Number.isFinite(b.at)) throw new Error('Invalid backup');
          return { id: b.id, name: b.name, at: b.at, settings: validateDnsSettings(b.settings) };
        });
      } catch { this.loadError = true; }
    }
  }
  async state(): Promise<DnsState> {
    const supported = this.backend.supported;
    return {
      supported: supported && !this.loadError, simulated: !!this.backend.simulated,
      adapters: supported ? (await this.backend.read()).map((a) => ({ ...a, revision: revision(a) })) : [],
      backups: structuredClone(this.backups),
      note: this.loadError ? 'Файл резервных копий DNS повреждён. Изменения заблокированы, чтобы не потерять прежние настройки.' : !supported ? 'Изменение DNS из офиса поддерживается только в Windows.' : this.backend.simulated ? 'Демонстрация: тестовый адаптер. Реальные DNS компьютера не меняются.' : undefined,
    };
  }
  async test(input: unknown): Promise<DnsProbe[]> {
    const list = servers(input);
    if (!list.length) throw new Error('Укажите хотя бы один IP-адрес DNS для проверки');
    if (this.backend.simulated) return list.flatMap((server) => HOSTS.map((host) => ({ server, host, addresses: ['192.0.2.1'], ms: 12 })));
    return Promise.all(list.flatMap((server) => HOSTS.map(async (host): Promise<DnsProbe> => {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers([server]);
      const start = Date.now();
      try { return { server, host, addresses: await resolver.resolve4(host), ms: Date.now() - start }; }
      catch (e) { return { server, host, addresses: [], ms: Date.now() - start, error: (e as NodeJS.ErrnoException).code ?? 'Ошибка DNS' }; }
    })));
  }
  async change(id: string, expected: string, input?: DnsSettings): Promise<DnsState> {
    if (this.busy) throw new Error('Другая операция DNS ещё выполняется');
    if (!this.backend.supported || this.loadError) throw new Error('Изменение DNS недоступно');
    this.busy = true;
    try {
      const adapter = (await this.backend.read()).find((a) => a.id === id);
      if (!adapter || revision(adapter) !== expected) throw new Error('Адаптер или DNS изменились. Обновите список перед применением');
      const before = validateDnsSettings(adapter);
      const backup = this.backups.find((b) => b.id === id);
      const settings = input === undefined ? backup?.settings : validateDnsSettings(input);
      if (!settings) throw new Error('Нет сохранённых настроек для этого адаптера');
      if (!backup) {
        this.backups.push({ id, name: adapter.name, at: Date.now(), settings: before });
        try { this.save(); } catch (e) { this.backups = this.backups.filter((b) => b.id !== id); throw e; }
      }
      await this.backend.change(adapter, settings);
      if (input === undefined) {
        const old = this.backups;
        this.backups = old.filter((b) => b.id !== id);
        try { this.save(); } catch (e) { this.backups = old; throw e; }
      }
      return await this.state();
    } finally { this.busy = false; }
  }
  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.backups, null, 2));
  }
}
