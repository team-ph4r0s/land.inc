import type { ClientMessage, UpdateState } from '@land/protocol';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

export class UpdatePanel {
  private el: HTMLElement;
  private send: (message: ClientMessage) => boolean;
  private state?: UpdateState;
  private online = false;
  private confirm = false;
  constructor(el: HTMLElement, send: (message: ClientMessage) => boolean) { this.el = el; this.send = send; this.render(); }
  set(state: UpdateState): void { this.state = state; if (state.phase !== 'available' && state.phase !== 'failed') this.confirm = false; this.render(); }
  setOnline(online: boolean): void { this.online = online; this.render(); }
  private render(): void {
    const s = this.state;
    const busy = !!s && ['checking', 'preparing', 'switching'].includes(s.phase);
    const release = s?.available;
    const steps = ['Подготовка копии', 'Проверки и сборка', 'Перезапуск'];
    this.el.innerHTML = `<section class="update-panel"><div class="update-parcel ${release ? 'arrived' : ''}" aria-hidden="true">${busy ? '⚙' : release ? '📦' : '✳'}</div>
      <h3>${release ? 'Доставка для офиса' : 'Обновления офиса'}</h3>
      <p class="update-version">Установлена версия ${esc(s?.current ?? '…')}${release ? ` → ${esc(release.version)}` : ''}</p>
      ${s?.simulated ? '<p class="note warn">Демонстрация: установка имитируется, файлы не меняются.</p>' : ''}
      <p class="note" role="status">${!this.online ? 'Связь с офисом восстанавливается. При обновлении это нормально — окно перезагрузится после запуска новой версии.' : esc(s?.message ?? 'Подключаемся…')}</p>
      ${busy ? `<ol class="update-steps">${steps.map((step) => `<li>${step}</li>`).join('')}</ol>` : ''}
      ${release ? `<details><summary>Что нового в ${esc(release.version)}</summary><div class="release-notes">${esc(release.notes || 'Описание релиза пока пусто.')}</div><a href="${esc(release.url)}" target="_blank" rel="noopener noreferrer">Открыть GitHub Release</a></details>` : ''}
      ${!s?.managed && !s?.simulated ? '<p class="note">Для установки из интерфейса запустите офис через npm run dev.</p>' : ''}
      <p class="note">Новая версия готовится отдельно. Исходный Git-каталог и его зависимости не заменяются. Во время обновления новые задачи и изменение DNS недоступны. При неудачном запуске вернётся прежняя версия.</p>
      <button type="button" data-check ${busy || !this.online ? 'disabled' : ''}>Проверить обновления</button>
      ${release ? `<button type="button" class="primary" data-install ${busy || !this.online || (!s?.managed && !s?.simulated) ? 'disabled' : ''}>Распаковать версию ${esc(release.version)}…</button>` : ''}
      ${this.confirm && release ? `<div class="update-confirm"><p>Установить ${esc(release.version)} и перезапустить офис? Дождитесь завершения всех задач; несохранённый текст в формах после перезагрузки исчезнет.</p><button type="button" class="primary" data-confirm>Обновить офис</button><button type="button" data-cancel>Отмена</button></div>` : ''}
      <p class="note">Локальные изменения блокируют установку. Резервная копия данных и журнал находятся в .land-updates исходной установки. Автопроверка — при запуске и каждые 4 часа.</p>
      ${s?.checkedAt ? `<p class="note">Проверено: ${esc(new Date(s.checkedAt).toLocaleString())}</p>` : ''}
    </section>`;
    this.el.querySelector('[data-check]')?.addEventListener('click', () => { this.send({ type: 'updates.check' }); });
    this.el.querySelector('[data-install]')?.addEventListener('click', () => { this.confirm = true; this.render(); });
    this.el.querySelector('[data-cancel]')?.addEventListener('click', () => { this.confirm = false; this.render(); });
    this.el.querySelector('[data-confirm]')?.addEventListener('click', () => {
      if (release && this.online) { this.confirm = false; this.send({ type: 'updates.install', version: release.version, sha: release.sha }); this.render(); }
    });
  }
}
