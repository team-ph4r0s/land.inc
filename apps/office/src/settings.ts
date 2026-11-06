import {
  type ClientMessage,
  type DeepPartial,
  type DoctorCheck,
  type Executor,
  type LandSettings,
  type McpId,
  type ProviderInfo,
} from '@land/protocol';
import { store } from './store';
import { esc, showToast, notifyDesktop } from './ui-kit';

export type SettingsSection = 'general' | 'providers' | 'mcp' | 'teams' | 'security';

export class SettingsPanel {
  private el: HTMLElement;
  private send: (m: ClientMessage) => boolean;
  private activeSection: SettingsSection = 'general';
  private backupExportReqId?: string;

  onThemeChange?: (theme: 'system' | 'dark' | 'light') => void;
  onScaleChange?: (scale: number) => void;
  onFpsChange?: (fps: 30 | 60, powerSave: boolean) => void;
  onResidentsChange?: (mode: 'on' | 'calm' | 'off') => void;

  constructor(el: HTMLElement, send: (m: ClientMessage) => boolean) {
    this.el = el;
    this.send = send;

    this.render();

    store.on('settings', () => this.render());
    store.on('doctor', () => this.render());
    store.on('mcp', () => this.render());
  }

  showSection(sec: SettingsSection): void {
    this.activeSection = sec;
    this.render();
  }

  handleBackupResult(requestId: string, backup?: unknown, error?: string): void {
    if (requestId !== this.backupExportReqId) return;
    this.backupExportReqId = undefined;

    if (error || !backup) {
      showToast(error ?? 'Не удалось экспортировать резервную копию', 'bad');
      return;
    }

    try {
      const jsonStr = JSON.stringify(backup, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'land-backup-v1.5.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('Резервная копия land-backup-v1.5.json скачана', 'ok');
    } catch (e) {
      showToast('Ошибка при скачивании файла', 'bad');
    }
  }

  private update(patch: DeepPartial<LandSettings>): void {
    // Optimistic local update
    const cur = store.settings;
    if (patch.general) Object.assign(cur.general, patch.general);
    if (patch.providers) {
      for (const [k, v] of Object.entries(patch.providers)) {
        if (v) Object.assign(cur.providers[k as Executor], v);
      }
    }
    if (patch.mcp) {
      if (patch.mcp.enabled) Object.assign(cur.mcp.enabled, patch.mcp.enabled);
      if (patch.mcp.compactThresholdChars !== undefined) cur.mcp.compactThresholdChars = patch.mcp.compactThresholdChars;
    }
    if (patch.teams) Object.assign(cur.teams, patch.teams);
    if (patch.security) Object.assign(cur.security, patch.security);

    store.emit('settings');
    this.send({ type: 'settings.update', patch });

    // Apply real side-effects
    if (patch.general?.theme) this.onThemeChange?.(patch.general.theme);
    if (patch.general?.uiScale !== undefined) {
      document.documentElement.style.setProperty('--ui-scale', String(patch.general.uiScale));
      this.onScaleChange?.(patch.general.uiScale);
    }
    if (patch.general?.fps !== undefined || patch.general?.backgroundPowerSave !== undefined) {
      this.onFpsChange?.(cur.general.fps, cur.general.backgroundPowerSave);
    }
    if (patch.general?.residents !== undefined) {
      this.onResidentsChange?.(cur.general.residents);
    }
  }

  private render(): void {
    const s = store.settings;
    const providers = store.providers;
    const mcp = store.mcp;
    const checks = store.doctorChecks;

    this.el.innerHTML = `
      <section class="settings-panel">
        <div class="settings-nav">
          <button type="button" data-sec="general" class="${this.activeSection === 'general' ? 'on' : ''}">Общие и UI</button>
          <button type="button" data-sec="providers" class="${this.activeSection === 'providers' ? 'on' : ''}">Провайдеры</button>
          <button type="button" data-sec="mcp" class="${this.activeSection === 'mcp' ? 'on' : ''}">Стек MCP</button>
          <button type="button" data-sec="teams" class="${this.activeSection === 'teams' ? 'on' : ''}">Команды</button>
          <button type="button" data-sec="security" class="${this.activeSection === 'security' ? 'on' : ''}">Безопасность и Doctor</button>
        </div>

        <div class="settings-body">
          ${this.renderSectionContent(s, providers, mcp, checks)}
        </div>
      </section>
    `;

    this.bindEvents();
  }

  private renderSectionContent(
    s: LandSettings,
    providers: ProviderInfo[],
    mcpList: typeof store.mcp,
    checks: DoctorCheck[],
  ): string {
    switch (this.activeSection) {
      case 'general':
        return `
          <div class="settings-section">
            <div class="settings-row">
              <label>Тема оформления<small>Системная или принудительно светлая/тёмная</small></label>
              <select data-setting="general.theme">
                <option value="system" ${s.general.theme === 'system' ? 'selected' : ''}>Системная (по умолчанию)</option>
                <option value="light" ${s.general.theme === 'light' ? 'selected' : ''}>Светлая</option>
                <option value="dark" ${s.general.theme === 'dark' ? 'selected' : ''}>Тёмная</option>
              </select>
            </div>

            <div class="settings-row">
              <label>Масштаб интерфейса (UI Scale)<small>От 0.8 до 1.4 для комфортного чтения</small></label>
              <div class="budget-row">
                <input type="range" min="0.8" max="1.4" step="0.05" value="${s.general.uiScale}" data-setting="general.uiScale" />
                <span class="badge default" data-scale-val>${s.general.uiScale}x</span>
              </div>
            </div>

            <div class="settings-row">
              <label>Частота кадров 2.5D сцены (FPS)<small>30 FPS экономит батарею, 60 FPS — максимальная плавность</small></label>
              <select data-setting="general.fps">
                <option value="60" ${s.general.fps === 60 ? 'selected' : ''}>60 FPS (Плавный рендер)</option>
                <option value="30" ${s.general.fps === 30 ? 'selected' : ''}>30 FPS (Энергосбережение)</option>
              </select>
            </div>

            <div class="settings-row">
              <label>Энергосбережение в фоне<small>Снижать нагрузку на GPU при неактивной вкладке</small></label>
              <input type="checkbox" data-setting="general.backgroundPowerSave" ${s.general.backgroundPowerSave ? 'checked' : ''} />
            </div>

            <div class="settings-row">
              <label>Жизнь кампуса (Жители)<small>Макс, Расул и Ваня живут своей жизнью между задачами</small></label>
              <select data-setting="general.residents">
                <option value="on" ${s.general.residents === 'on' ? 'selected' : ''}>Активные (все активности и трюки)</option>
                <option value="calm" ${s.general.residents === 'calm' ? 'selected' : ''}>Спокойные (без резких движений)</option>
                <option value="off" ${s.general.residents === 'off' ? 'selected' : ''}>Отключены</option>
              </select>
            </div>

            <div class="settings-row">
              <label>Звуковой сигнал завершения<small>Воспроизводить мягкий перезвон при готовности задачи</small></label>
              <input type="checkbox" data-setting="general.soundOnFinish" ${s.general.soundOnFinish ? 'checked' : ''} />
            </div>

            <div class="settings-row">
              <label>Браузерные уведомления<small>Всплывающее системное уведомление при завершении</small></label>
              <input type="checkbox" data-setting="general.browserNotifications" ${s.general.browserNotifications ? 'checked' : ''} />
            </div>
          </div>
        `;

      case 'providers':
        return `
          <div class="settings-section">
            <div class="note">Состояние CLI-провайдеров и переопределение путей к исполняемым файлам</div>
            ${(['claude', 'codex', 'antigravity'] as Executor[])
              .map((ex) => {
                const info = providers.find((p) => p.executor === ex);
                const override = s.providers[ex]?.pathOverride ?? '';
                const name = ex === 'claude' ? 'Claude Code' : ex === 'codex' ? 'Codex' : 'Antigravity';
                const statusCls = info?.available ? 'badge done' : 'badge failed';
                const statusText = info?.available ? 'Доступен' : 'Не найден';

                return `
                  <div class="doctor-item">
                    <div class="doctor-head">
                      <div>
                        <strong>${esc(name)}</strong>
                        <span class="${statusCls} doctor-status-badge">${statusText}</span>
                      </div>
                      ${info?.version ? `<span class="badge default">v${esc(info.version)}</span>` : ''}
                    </div>
                    <div class="note">${esc(info?.note ?? '')} ${info?.path ? `· Путь: <code>${esc(info.path)}</code>` : ''}</div>
                    <label class="constructor-field doctor-field">
                      <span>Кастомный путь к бинарнику (pathOverride):</span>
                      <input type="text" data-provider-override="${esc(ex)}" value="${esc(override)}" placeholder="Оставьте пустым для автопоиска в PATH" />
                    </label>
                  </div>
                `;
              })
              .join('')}

            <div class="settings-btn-row">
              <button type="button" class="btn" data-act="rescan-models">↻ Проверить и обновить каталог моделей</button>
            </div>
          </div>
        `;

      case 'mcp':
        return `
          <div class="settings-section">
            <div class="note">Инструменты Model Context Protocol (MCP) расширяют возможности моделей</div>
            <div class="settings-row">
              <label>Порог интеллектуального сжатия (символов)<small>При превышении размера контекста сжимать ранние реплики</small></label>
              <input type="number" data-setting="mcp.compactThresholdChars" value="${s.mcp.compactThresholdChars}" step="10000" min="50000" />
            </div>

            <div class="mcp-checks-grid">
              ${mcpList
                .map((m) => {
                  const isEnabled = s.mcp.enabled[m.id];
                  const stateBadge =
                    m.state === 'active'
                      ? '<span class="badge done">Активен</span>'
                      : m.state === 'installing'
                      ? '<span class="badge running">Установка…</span>'
                      : '<span class="badge warn">Отсутствует</span>';

                  return `
                    <div class="doctor-item">
                      <div class="doctor-head">
                        <strong>${esc(m.id)}</strong>
                        ${stateBadge}
                      </div>
                      <div class="note">${esc(m.message ?? '')} ${m.version ? `· v${esc(m.version)}` : ''}</div>
                      <label class="mcp-toggle-label">
                        <input type="checkbox" data-mcp-toggle="${esc(m.id)}" ${isEnabled ? 'checked' : ''} />
                        <span>Включен в сессиях</span>
                      </label>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `;

      case 'teams':
        return `
          <div class="settings-section">
            <div class="settings-row">
              <label>Параллельный лимит задач (1–8)<small>Сколько агентов могут работать одновременно</small></label>
              <input type="number" min="1" max="8" value="${s.teams.maxConcurrentTasks}" data-setting="teams.maxConcurrentTasks" />
            </div>

            <div class="settings-row">
              <label>Папка сохранения артефактов<small>Путь к директории готовых документов и кодовой базы</small></label>
              <input type="text" value="${esc(s.teams.artifactsDir)}" placeholder="По умолчанию: корень проекта" data-setting="teams.artifactsDir" />
            </div>

            <div class="settings-row">
              <label>Автосохранение черновиков задач<small>Запоминать незаконченный ввод в полях задач и шагов</small></label>
              <input type="checkbox" data-setting="teams.autosaveDrafts" ${s.teams.autosaveDrafts ? 'checked' : ''} />
            </div>

            <div class="settings-row">
              <label>Лимит захвата вывода CLI (символов)<small>200 000 – 2 000 000 символов в памяти</small></label>
              <input type="number" min="200000" max="2000000" step="50000" value="${s.teams.captureLimitChars}" data-setting="teams.captureLimitChars" />
            </div>
          </div>
        `;

      case 'security':
        return `
          <div class="settings-section">
            <div class="settings-row">
              <label>Защитный экран Agentic Shield<small>Блокирует деструктивные команды CLI и выход за пределы проекта</small></label>
              <input type="checkbox" data-setting="security.shieldEnabled" ${s.security.shieldEnabled ? 'checked' : ''} />
            </div>

            <div class="doctor-item">
              <div class="doctor-head">
                <strong>Безопасность токенов и сессий</strong>
              </div>
              <div class="note">Аутентификация клиента защищена локальным токеном WebSocket.</div>
              <div class="chips-row settings-btn-row">
                <button type="button" class="btn" data-act="rotate-token">Сменить токен авторизации</button>
                <button type="button" class="btn" data-act="clear-cache">Очистить локальный кеш</button>
              </div>
            </div>

            <div class="doctor-item">
              <div class="doctor-head">
                <strong>Резервное копирование (land-backup-v1.5.json)</strong>
              </div>
              <div class="note">Полный экспорт настроек, сотрудников, пресетов команд и метаданных чатов.</div>
              <div class="chips-row settings-btn-row">
                <button type="button" class="btn primary" data-act="export-backup">Экспорт резервной копии</button>
                <button type="button" class="btn" data-act="trigger-import">Импорт из файла…</button>
                <input type="file" id="backup-file-input" accept=".json" hidden />
              </div>
            </div>

            <div class="doctor-item">
              <div class="doctor-head">
                <strong>Диагностика системы (Doctor)</strong>
                <button type="button" class="btn small" data-act="doctor-run">Проверить систему</button>
              </div>
              <div class="doctor-list settings-btn-row">
                ${
                  checks.length === 0
                    ? '<p class="note">Нажмите «Проверить систему» для запуска диагностики CLI, прав доступа и портов.</p>'
                    : checks
                        .map((c) => {
                          const statusCls = c.status === 'ok' ? 'doctor-status-ok' : c.status === 'warn' ? 'doctor-status-warn' : 'doctor-status-fail';
                          const statusIcon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✕';
                          return `
                            <div class="doctor-item">
                              <div class="doctor-head">
                                <div><span class="${statusCls}">${statusIcon}</span> <strong>${esc(c.title)}</strong></div>
                                ${c.fix ? `<button type="button" class="btn small primary" data-doctor-fix="${esc(c.id)}">Исправить автоматически</button>` : ''}
                              </div>
                              <div class="note">${esc(c.detail)}</div>
                            </div>
                          `;
                        })
                        .join('')
                }
              </div>
            </div>
          </div>
        `;
    }
  }

  private bindEvents(): void {
    // Navigation
    this.el.querySelectorAll<HTMLButtonElement>('.settings-nav button').forEach((b) => {
      b.addEventListener('click', () => {
        this.showSection(b.dataset.sec as SettingsSection);
      });
    });

    // Form inputs change
    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach((input) => {
      input.addEventListener('change', () => {
        const path = input.dataset.setting!;
        let val: unknown;

        if (input instanceof HTMLInputElement && input.type === 'checkbox') {
          val = input.checked;
        } else if (input instanceof HTMLInputElement && (input.type === 'number' || input.type === 'range')) {
          val = Number(input.value);
        } else {
          val = input.value;
        }

        if (input.dataset.setting === 'general.uiScale') {
          const valBadge = this.el.querySelector<HTMLElement>('[data-scale-val]');
          if (valBadge) valBadge.textContent = `${val}x`;
        }

        if (path === 'general.browserNotifications' && val === true) {
          notifyDesktop('land.inc', 'Уведомления успешно включены!');
        }

        // Build deep patch
        const parts = path.split('.');
        if (parts.length === 2) {
          const section = parts[0] as keyof LandSettings;
          const field = parts[1];
          this.update({ [section]: { [field]: val } } as DeepPartial<LandSettings>);
        }
      });
    });

    // Provider override inputs
    this.el.querySelectorAll<HTMLInputElement>('[data-provider-override]').forEach((input) => {
      input.addEventListener('change', () => {
        const ex = input.dataset.providerOverride as Executor;
        const val = input.value.trim() || undefined;
        this.update({ providers: { [ex]: { pathOverride: val } } });
        showToast(`Путь для ${ex} обновлен`, 'ok');
      });
    });

    // MCP toggles
    this.el.querySelectorAll<HTMLInputElement>('[data-mcp-toggle]').forEach((chk) => {
      chk.addEventListener('change', () => {
        const id = chk.dataset.mcpToggle as McpId;
        this.update({ mcp: { enabled: { [id]: chk.checked } as Record<McpId, boolean> } });
      });
    });

    // Rescan models
    this.el.querySelector('[data-act="rescan-models"]')?.addEventListener('click', () => {
      this.send({ type: 'models.rescan' });
      showToast('Запрошено сканирование каталога моделей…', 'info');
    });

    // Rotate token
    this.el.querySelector('[data-act="rotate-token"]')?.addEventListener('click', () => {
      if (confirm('Сменить токен WebSocket? Клиент автоматически переподключится с новым токеном.')) {
        this.send({ type: 'token.rotate' });
        showToast('Токен обновлен', 'ok');
      }
    });

    // Clear cache
    this.el.querySelector('[data-act="clear-cache"]')?.addEventListener('click', () => {
      this.send({ type: 'cache.clear' });
      showToast('Локальный кеш очищен', 'ok');
    });

    // Export backup
    this.el.querySelector('[data-act="export-backup"]')?.addEventListener('click', () => {
      const requestId = crypto.randomUUID();
      this.backupExportReqId = requestId;
      this.send({ type: 'backup.export', requestId });
      showToast('Подготовка резервной копии…', 'info');
    });

    // Trigger import
    const fileInput = this.el.querySelector<HTMLInputElement>('#backup-file-input');
    this.el.querySelector('[data-act="trigger-import"]')?.addEventListener('click', () => {
      fileInput?.click();
    });

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const json = JSON.parse(e.target?.result as string);
          if (json.format !== 'land-backup' || json.version !== '1.5') {
            showToast('Неверный формат файла резервной копии (ожидается land-backup 1.5)', 'bad');
            return;
          }
          const requestId = crypto.randomUUID();
          this.send({ type: 'backup.import', requestId, backup: json });
          showToast('Резервная копия импортирована!', 'ok');
        } catch {
          showToast('Ошибка при чтении JSON-файла', 'bad');
        }
      };
      reader.readAsText(file);
    });

    // Doctor run
    this.el.querySelector('[data-act="doctor-run"]')?.addEventListener('click', () => {
      this.send({ type: 'doctor.run' });
      showToast('Запущена диагностика Doctor…', 'info');
    });

    // Doctor fix buttons
    this.el.querySelectorAll<HTMLButtonElement>('[data-doctor-fix]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.doctorFix!;
        this.send({ type: 'doctor.fix', id });
        showToast(`Запущено исправление: ${id}…`, 'info');
      });
    });
  }
}
