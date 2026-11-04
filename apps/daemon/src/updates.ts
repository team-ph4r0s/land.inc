import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { OfficeRelease, UpdateState } from '@land/protocol';

const exec = promisify(execFile);
export const APP_ROOT = resolve(import.meta.dirname, '../../..');
export const version = (root = APP_ROOT) => readFileSync(join(root, 'VERSION'), 'utf8').trim();
export const validVersion = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value);
export function newer(a: string, b: string): boolean {
  if (!validVersion(a) || !validVersion(b)) return false;
  const [x, y] = a.split('.').map(Number), [u, v] = b.split('.').map(Number);
  return x > u || (x === u && y > v);
}
export function githubRepo(remote: string): string {
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) throw new Error('Обновление поддерживает origin на github.com без токена в URL');
  return match[1];
}
export type Runner = (command: string, args: string[], cwd: string) => Promise<string>;
export const run: Runner = async (command, args, cwd) => {
  const { stdout } = await exec(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: command === 'gh' || args[0] === 'ls-remote' ? 30_000 : 600_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } });
  return stdout.trim();
};
export async function clean(root: string, runner = run): Promise<void> {
  if (await runner('git', ['status', '--porcelain', '--untracked-files=normal'], root))
    throw new Error('В установленной версии есть локальные изменения. Сохраните их коммитом или уберите вручную перед обновлением; офис их не перезаписывает');
}

/** Prepare a complete independent installation. The running checkout and node_modules are untouched. */
export async function prepareRelease(source: string, base: string, release: OfficeRelease, npm: string, report: (message: string) => void, runner = run): Promise<string> {
  if (!validVersion(release.version) || release.tag !== `v${release.version}` || !/^[a-f0-9]{40,64}$/.test(release.sha)) throw new Error('Некорректный релиз');
  await clean(source, runner);
  const origin = await runner('git', ['remote', 'get-url', 'origin'], source);
  githubRepo(origin);
  const target = join(base, 'versions', `${release.version}-${randomUUID()}`);
  mkdirSync(dirname(target), { recursive: true });
  report('Получаем отдельную копию релиза…');
  await runner('git', ['clone', '--no-hardlinks', '--no-checkout', '--', source, target], base);
  await runner('git', ['remote', 'set-url', 'origin', origin], target);
  await runner('git', ['fetch', '--no-tags', 'origin', `refs/tags/${release.tag}`], target);
  const sha = await runner('git', ['rev-parse', 'FETCH_HEAD^{commit}'], target);
  if (sha !== release.sha) throw new Error('Тег релиза изменился после проверки. Проверьте обновления заново');
  await runner('git', ['checkout', '--detach', sha], target);
  if (version(target) !== release.version) throw new Error('VERSION не соответствует тегу релиза');
  if (!existsSync(npm)) throw new Error('Не найден npm CLI. Запустите офис через npm run dev');
  report('Устанавливаем зависимости в новой папке…');
  await runner(process.execPath, [npm, 'ci', '--engine-strict'], target);
  report('Проверяем TypeScript и тесты…');
  await runner(process.execPath, [npm, 'run', 'typecheck'], target);
  await runner(process.execPath, [npm, 'test'], target);
  report('Собираем новую версию…');
  await runner(process.execPath, [npm, 'run', 'build'], target);
  await clean(source, runner);
  await clean(target, runner);
  return target;
}

export class UpdatesService {
  state: UpdateState;
  private root: string;
  private notify: (state: UpdateState) => void;
  private idle: () => boolean;
  private runner: Runner;
  private checking?: Promise<void>;
  constructor(notify: (state: UpdateState) => void, idle: () => boolean, options: { root?: string; fake?: boolean; runner?: Runner; managed?: boolean } = {}) {
    this.root = options.root ?? APP_ROOT;
    this.notify = notify;
    this.idle = idle;
    this.runner = options.runner ?? run;
    this.state = { current: version(this.root), phase: process.env.LAND_UPDATE_BOOTING ? 'switching' : 'idle', managed: options.managed ?? !!process.send,
      simulated: !!options.fake, message: 'Проверить, не приехала ли новая версия офиса' };
  }
  get busy(): boolean { return ['preparing', 'switching'].includes(this.state.phase); }
  set(patch: Partial<UpdateState>): void { this.state = { ...this.state, ...patch }; this.notify(this.state); }
  async check(): Promise<void> {
    if (this.busy) return;
    if (this.checking) return this.checking;
    this.checking = this.checkNow().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async checkNow(): Promise<void> {
    this.set({ phase: 'checking', message: 'Проверяем GitHub Releases…' });
    try {
      let release: OfficeRelease;
      if (this.state.simulated) {
        const [major, minor] = this.state.current.split('.').map(Number);
        const next = minor < 9999 ? `${major}.${minor + 1}` : `${major + 1}.0`;
        release = { version: next, tag: `v${next}`, sha: 'a'.repeat(40), url: 'https://github.com/ghostoftheeleven/land.inc/releases', notes: 'Демонстрация доставки обновления. Код и зависимости не меняются.' };
      } else {
        const repo = githubRepo(await this.runner('git', ['remote', 'get-url', 'origin'], this.root));
        let data: any;
        try { data = JSON.parse(await this.runner('gh', ['api', `repos/${repo}/releases/latest`], this.root)); }
        catch {
          const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
          if (response.status === 404) throw new Error('Опубликованных релизов нет или репозиторий закрыт. Для закрытого репозитория выполните gh auth login');
          if (!response.ok) throw new Error(`GitHub недоступен (${response.status}). Повторите позже`);
          data = await response.json();
        }
        const next = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : '';
        if (!validVersion(next) || data.draft || data.prerelease) throw new Error('Последний релиз не соответствует формату x.y');
        const refs = await this.runner('git', ['ls-remote', 'origin', `refs/tags/v${next}`, `refs/tags/v${next}^{}`], this.root);
        const lines = refs.split('\n').map((s) => s.trim().split(/\s+/));
        const sha = (lines.find(([, ref]) => ref?.endsWith('^{}')) ?? lines.find(([, ref]) => ref === `refs/tags/v${next}`))?.[0];
        if (!sha || !/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Не удалось проверить тег релиза через Git');
        release = { version: next, tag: `v${next}`, sha, url: `https://github.com/${repo}/releases/tag/v${next}`, notes: String(data.body ?? '').slice(0, 12_000) };
      }
      const available = newer(release.version, this.state.current) ? release : undefined;
      this.set({ phase: available ? 'available' : 'idle', available, checkedAt: Date.now(), message: available ? `В офис приехала версия ${release.version}` : 'У вас свежая версия офиса' });
    } catch (e) { this.set({ phase: 'failed', available: undefined, message: (e as Error).message, checkedAt: Date.now() }); }
  }
  async install(wantedVersion: string, sha: string): Promise<void> {
    if (this.busy || this.checking) throw new Error('Другая операция обновления ещё выполняется');
    const release = this.state.available;
    if (!release || release.version !== wantedVersion || release.sha !== sha) throw new Error('Список релизов изменился. Проверьте обновления заново');
    if (!this.idle()) throw new Error('Дождитесь завершения задач, совместной работы и изменения DNS');
    if (!this.state.simulated) {
      if (!this.state.managed) throw new Error('Для обновления запустите офис через npm run dev, затем повторите');
      await clean(this.root, this.runner);
      // Recheck after the async Git operation: no task may slip into the preparation window.
      if (!this.idle() || this.busy) throw new Error('Появилась активная операция. Дождитесь её завершения');
    }
    this.set({ phase: 'preparing', message: this.state.simulated ? 'Демонстрация: посылка распакована, файлы не менялись.' : 'Подготавливаем отдельную копию новой версии…' });
    if (this.state.simulated) { this.set({ phase: 'done', available: undefined, message: 'Демонстрация обновления завершена. Установленная версия не менялась.' }); return; }
    process.send?.({ type: 'office.update', release });
  }
}
