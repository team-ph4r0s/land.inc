import type { ClientMessage, DnsAdapter, DnsFamily, DnsSettings, DnsState, ServerMessage } from '@land/protocol';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const summary = (value: DnsFamily) => value.mode === 'auto' ? 'Автоматически (DHCP)' : value.mode === 'unknown' ? 'Источник не определён' : value.servers.join(', ');
type Operation = 'read' | 'test' | 'apply' | 'restore';
type DnsResult = Extract<ServerMessage, { type: 'dns.result' }>;

export class DnsPanel {
  private el: HTMLElement;
  private send: (message: ClientMessage) => boolean;
  private state?: DnsState;
  private selected = '';
  private draft?: DnsSettings;
  private dirty = false;
  private pending?: { id: string; op: Operation };
  private needsRead = true;
  private online = false;
  private active = false;

  constructor(el: HTMLElement, send: (message: ClientMessage) => boolean) {
    this.el = el;
    this.send = send;
    el.addEventListener('dns-open', () => { this.active = true; if (!this.state && !this.pending && this.online) this.request('read'); });
    this.render();
  }
  setOnline(online: boolean): void {
    this.online = online;
    if (!online && this.pending) {
      this.pending = undefined;
      this.needsRead = true;
      this.message('Связь прервалась. Результат операции не подтверждён. Обновите состояние DNS перед следующими изменениями.', true);
    }
    this.buttons();
    if (online && this.active && !this.pending) this.request('read');
  }
  result(result: DnsResult): void {
    if (result.requestId !== this.pending?.id) return;
    const op = this.pending.op;
    this.pending = undefined;
    if (result.error) {
      if (op === 'apply' || op === 'restore') this.needsRead = true;
      this.buttons();
      this.message(result.error, true);
      return;
    }
    if (result.state) {
      this.state = result.state;
      this.needsRead = false;
      const adapter = this.state.adapters.find((a) => a.id === this.selected) ?? this.state.adapters[0];
      if (adapter) {
        if (adapter.id !== this.selected || !this.dirty || op === 'apply' || op === 'restore') {
          this.draft = { ipv4: structuredClone(adapter.ipv4), ipv6: structuredClone(adapter.ipv6) };
          this.dirty = false;
        }
        this.selected = adapter.id;
      } else { this.selected = ''; this.draft = undefined; }
      this.render();
    }
    if (result.probes) {
      this.el.querySelector<HTMLElement>('[data-probes]')!.innerHTML = `<details><summary>Результаты проверки: ${result.probes.length}, ошибок: ${result.probes.filter((p) => p.error).length}</summary>${result.probes.map((p) => `<div class="dns-probe ${p.error ? 'failed' : ''}"><strong>${esc(p.server)}</strong><br>${esc(p.host)}<br>${p.error ? esc(p.error) : esc(p.addresses.join(', '))} · ${p.ms} мс</div>`).join('')}</details>`;
      this.message(this.state?.simulated ? 'Тестовые ответы: настоящие DNS-запросы не выполнялись.' : 'Проверка DNS завершена. Ответ DNS ещё не подтверждает доступность API или вход в аккаунт.');
    } else this.message(result.message ?? (this.dirty ? 'Состояние обновлено. Ваши несохранённые адреса оставлены в полях.' : 'Состояние DNS обновлено.'));
    this.buttons();
  }
  private adapter(): DnsAdapter | undefined { return this.state?.adapters.find((a) => a.id === this.selected); }
  private render(): void {
    const adapter = this.adapter();
    const backup = this.state?.backups.find((b) => b.id === this.selected);
    this.el.innerHTML = `<section class="dns-panel">
      <h3>DNS-серверы</h3>
      <p class="note">DNS выбранного сетевого адаптера действует для всех использующих его приложений, включая CLI агентов. VPN и приложения со своим DNS / DoH могут использовать другие серверы.</p>
      ${this.state?.note ? `<p class="note warn">${esc(this.state.note)}</p>` : ''}
      <button type="button" data-read>Обновить адаптеры и DNS</button>
      <label>Сетевой адаптер<select data-adapter aria-label="Сетевой адаптер">${this.state?.adapters.map((a) => `<option value="${esc(a.id)}" ${a.id === this.selected ? 'selected' : ''}>${esc(a.name)} · #${a.index}</option>`).join('') ?? ''}</select></label>
      ${adapter ? `<div class="dns-current"><strong>Текущие настройки</strong><p>IPv4: ${esc(summary(adapter.ipv4))}${adapter.ipv4.mode === 'auto' && adapter.ipv4.servers.length ? ' · ' + esc(adapter.ipv4.servers.join(', ')) : ''}</p><p>IPv6: ${esc(summary(adapter.ipv6))}${adapter.ipv6.mode === 'auto' && adapter.ipv6.servers.length ? ' · ' + esc(adapter.ipv6.servers.join(', ')) : ''}</p></div>
      <fieldset data-fields><legend>Новые настройки</legend>${(['ipv4', 'ipv6'] as const).map((family) => {
        const value = this.draft![family];
        const label = family === 'ipv4' ? 'IPv4' : 'IPv6';
        return `<label>Режим ${label}<select data-mode="${family}"><option value="auto" ${value.mode === 'auto' ? 'selected' : ''}>Автоматически (DHCP)</option><option value="manual" ${value.mode === 'manual' ? 'selected' : ''}>Вручную</option>${value.mode === 'unknown' ? '<option value="unknown" selected>Источник не определён</option>' : ''}</select></label>
        <label>DNS ${label}, по одному адресу на строку<textarea data-servers="${family}" rows="2" spellcheck="false" placeholder="${family === 'ipv4' ? 'Основной DNS\nДополнительный DNS' : 'Основной IPv6 DNS\nДополнительный IPv6 DNS'}" ${value.mode !== 'manual' ? 'disabled' : ''}>${esc(value.mode === 'manual' ? value.servers.join('\n') : '')}</textarea></label>`;
      }).join('')}<p class="note">Порядок адресов сохраняется. Можно указать до 8 серверов каждого семейства. Автоматический режим возвращает получение DNS от сети.</p></fieldset>
      ${adapter.ipv4.mode === 'unknown' || adapter.ipv6.mode === 'unknown' ? '<p class="note warn">Источник текущих DNS не определён. Применение заблокировано: нельзя гарантировать восстановление. Обновите список или используйте настройки Windows.</p>' : ''}
      <button type="button" data-test>Проверить DNS</button>
      <p class="note">Проверяет разрешение имён сервисов агентов выбранными DNS. При автоматическом режиме проверяются текущие адреса адаптера.</p>
      <div data-probes aria-live="polite"></div>
      <button type="button" data-apply>Просмотреть и применить…</button>
      ${backup ? `<div class="dns-backup"><strong>Сохранено до первого изменения</strong><p>${esc(new Date(backup.at).toLocaleString())}</p><p>IPv4: ${esc(summary(backup.settings.ipv4))}</p><p>IPv6: ${esc(summary(backup.settings.ipv6))}</p><button type="button" data-restore>Восстановить прежние настройки…</button></div>` : ''}
      <div class="dns-confirm" data-confirm hidden></div>` : `<p class="note">${this.state ? 'Нет доступных активных адаптеров.' : 'Откройте вкладку при подключённом демоне, чтобы загрузить адаптеры.'}</p>`}
      <p data-message role="status" aria-live="polite"></p>
    </section>`;
    this.el.querySelector('[data-read]')!.addEventListener('click', () => this.request('read'));
    this.el.querySelector<HTMLSelectElement>('[data-adapter]')!.addEventListener('change', (event) => {
      this.selected = (event.target as HTMLSelectElement).value;
      const current = this.adapter()!;
      this.draft = { ipv4: structuredClone(current.ipv4), ipv6: structuredClone(current.ipv6) };
      this.dirty = false;
      this.render();
    });
    this.el.querySelectorAll<HTMLElement>('[data-mode], [data-servers]').forEach((field) => field.addEventListener('input', () => this.edited()));
    this.el.querySelector('[data-test]')?.addEventListener('click', () => this.request('test'));
    this.el.querySelector('[data-apply]')?.addEventListener('click', () => this.confirm('apply'));
    this.el.querySelector('[data-restore]')?.addEventListener('click', () => this.confirm('restore'));
    this.buttons();
  }
  private edited(): void {
    if (!this.draft) return;
    for (const family of ['ipv4', 'ipv6'] as const) {
      const mode = this.el.querySelector<HTMLSelectElement>(`[data-mode="${family}"]`)!.value as DnsFamily['mode'];
      const input = this.el.querySelector<HTMLTextAreaElement>(`[data-servers="${family}"]`)!;
      input.disabled = mode !== 'manual';
      this.draft[family] = { mode, servers: input.value.split(/[\s,;]+/).filter(Boolean) };
    }
    this.dirty = true;
    this.el.querySelector<HTMLElement>('[data-confirm]')!.hidden = true;
    this.el.querySelector<HTMLElement>('[data-probes]')!.innerHTML = '';
    this.message('Настройки в полях ещё не применены.');
  }
  private confirm(op: 'apply' | 'restore'): void {
    if (this.pending || this.needsRead) return;
    const adapter = this.adapter()!;
    const settings = op === 'apply' ? this.draft! : this.state!.backups.find((b) => b.id === this.selected)!.settings;
    const pane = this.el.querySelector<HTMLElement>('[data-confirm]')!;
    pane.hidden = false;
    pane.innerHTML = `<strong>${op === 'restore' ? 'Восстановление' : 'Применение'} DNS: ${esc(adapter.name)}</strong><p>IPv4: ${esc(summary(settings.ipv4))}</p><p>IPv6: ${esc(summary(settings.ipv6))}</p><p>${this.state?.simulated ? 'Тестовый режим: Windows не меняется.' : 'Изменятся DNS этого адаптера для всех приложений. Windows запросит права администратора. Снимок прежних настроек будет сохранён до изменения.'}</p><button type="button" data-confirm-action>${op === 'restore' ? 'Восстановить DNS' : 'Применить DNS'}</button><button type="button" data-confirm-cancel>Отмена</button>`;
    pane.querySelector('[data-confirm-action]')!.addEventListener('click', () => { pane.hidden = true; this.request(op); });
    pane.querySelector('[data-confirm-cancel]')!.addEventListener('click', () => { pane.hidden = true; });
  }
  private request(op: Operation): void {
    if (this.pending) return;
    const requestId = crypto.randomUUID();
    const adapter = this.adapter();
    let msg: ClientMessage;
    if (op === 'read') msg = { type: 'dns.read', requestId };
    else if (op === 'test') {
      if (!adapter || !this.draft) return;
      const servers = [...new Set((['ipv4', 'ipv6'] as const).flatMap((family) => this.draft![family].mode === 'manual' ? this.draft![family].servers : adapter[family].servers))];
      msg = { type: 'dns.test', requestId, servers };
    } else {
      if (!adapter || !this.draft || this.needsRead) return;
      msg = op === 'apply' ? { type: 'dns.apply', requestId, adapterId: adapter.id, revision: adapter.revision, settings: this.draft } : { type: 'dns.restore', requestId, adapterId: adapter.id, revision: adapter.revision };
    }
    if (!this.send(msg)) return this.message('Нет связи с демоном', true);
    this.pending = { id: requestId, op };
    this.buttons();
    this.message(op === 'apply' || op === 'restore' ? 'Ожидаем результат. Если Windows показывает UAC, подтвердите действие или отмените его.' : op === 'test' ? 'Проверяем DNS…' : 'Читаем настройки адаптеров…');
  }
  private buttons(): void {
    const adapter = this.adapter();
    const busy = !!this.pending || !this.online;
    this.el.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      const mutation = button.hasAttribute('data-apply') || button.hasAttribute('data-restore') || button.hasAttribute('data-confirm-action');
      button.disabled = busy || (mutation && (this.needsRead || !this.state?.supported || !adapter || adapter.ipv4.mode === 'unknown' || adapter.ipv6.mode === 'unknown'));
    });
    const select = this.el.querySelector<HTMLSelectElement>('[data-adapter]');
    if (select) select.disabled = busy || !this.state?.adapters.length;
    const fields = this.el.querySelector<HTMLFieldSetElement>('[data-fields]');
    if (fields) fields.disabled = busy;
  }
  private message(text: string, error = false): void {
    const element = this.el.querySelector<HTMLElement>('[data-message]')!;
    element.textContent = text;
    element.className = error ? 'error' : 'note';
  }
}
