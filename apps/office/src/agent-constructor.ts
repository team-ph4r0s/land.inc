import {
  ALLOWED_CLI_FLAGS,
  DEFAULT_ADVANCED,
  ROLE_LABEL,
  TEMPERATURE,
  TIMEOUT_CHOICES,
  type Access,
  type AdvancedSettings,
  type AgentProfile,
  type AgentProfileDraft,
  type AgentRoleId,
  type Appearance,
  type ClientMessage,
  type Executor,
  type McpId,
  type OverflowStrategy,
  type TemperaturePreset,
} from '@land/protocol';
import { modelSelect, showModal, showToast, esc } from './ui-kit';
import { store } from './store';

export const ROLE_TEMPLATES: Record<
  AgentRoleId,
  { name: string; goal: string; backstory: string; expectedOutputFormat: string; roleTitle?: string }
> = {
  writer: {
    name: 'Писатель',
    goal: 'Создавать увлекательные, логичные и глубокие тексты и повествования.',
    backstory: 'Опытный литератор и публицист с богатым словарным запасом и безупречным стилем.',
    expectedOutputFormat: 'Готовая глава или статья в Markdown с подзаголовками и цитатами.',
  },
  critic: {
    name: 'Критик',
    goal: 'Проверять логику, факты, непротиворечивость и соответствие инвариантам.',
    backstory: 'Внимательный рецензент, который не пропустит сюжетных дыр или скрытых дефектов.',
    expectedOutputFormat: 'Аналитический отчет с перечнем замечаний и вердиктом APPROVED / NEEDS_REVISION.',
  },
  editor: {
    name: 'Редактор',
    goal: 'Доводить черновики до совершенства, исправлять шероховатости и форматирование.',
    backstory: 'Главный редактор издательства с 12-летним опытом полировки рукописей.',
    expectedOutputFormat: 'Отполированный финальный текст в чистом Markdown.',
  },
  architect: {
    name: 'Архитектор',
    goal: 'Проектировать архитектуру решений, контракты API и структуры данных.',
    backstory: 'Системный архитектор high-load систем, сторонник модульности и строгих контрактов.',
    expectedOutputFormat: 'Архитектурная спецификация со схемами Mermaid и TypeScript-интерфейсами.',
  },
  coder: {
    name: 'Кодер',
    goal: 'Писать чистый, типизированный, протестированный код без костылей и заглушек.',
    backstory: 'Senior full-stack разработчик, соблюдающий строгую типизацию и юнит-тесты.',
    expectedOutputFormat: 'Готовые файлы с кодом и тестами без пропусков.',
  },
  security: {
    name: 'Безопасник',
    goal: 'Искать уязвимости, проверять границы песочницы, инварианты доступа и безопасность.',
    backstory: 'Эксперт по информационной безопасности и реверс-инжинирингу.',
    expectedOutputFormat: 'Отчет об аудите безопасности с рекомендациями по устранению рисков.',
  },
  custom: {
    name: 'Специалист',
    goal: 'Выполнение специализированных проектных задач.',
    backstory: 'Эксперт в предметной области с уникальным прикладным опытом.',
    expectedOutputFormat: 'Структурированный отчет о результатах работы.',
  },
};

const PALETTE = [
  { hex: '#d97757', label: 'Терракот', cls: 'swatch-terracotta' },
  { hex: '#10a37f', label: 'Изумруд', cls: 'swatch-emerald' },
  { hex: '#4285f4', label: 'Индиго', cls: 'swatch-indigo' },
  { hex: '#e5a14d', label: 'Янтарь', cls: 'swatch-amber' },
  { hex: '#dc2626', label: 'Багровый', cls: 'swatch-crimson' },
  { hex: '#2563eb', label: 'Синий', cls: 'swatch-navy' },
  { hex: '#7c3aed', label: 'Фиолетовый', cls: 'swatch-violet' },
  { hex: '#475569', label: 'Графит', cls: 'swatch-slate' },
  { hex: '#65a30d', label: 'Олива', cls: 'swatch-olive' },
];

const ACCESSORIES: { id: Appearance['accessory']; label: string }[] = [
  { id: 'none', label: 'Нет' },
  { id: 'glasses', label: 'Очки' },
  { id: 'headphones', label: 'Наушники' },
  { id: 'scarf', label: 'Шарф' },
  { id: 'cap', label: 'Кепка' },
  { id: 'badge', label: 'Бейдж' },
];

const MCP_LIST: { id: McpId; label: string; note: string }[] = [
  { id: 'markitdown', label: 'MarkItDown', note: 'Конвертер документов в чистый MD' },
  { id: 'context-budget', label: 'Context Budget', note: 'Контроль лимитов контекста' },
  { id: 'strategic-compact', label: 'Strategic Compact', note: 'Умное сжатие логов' },
  { id: 'agentic-shield', label: 'Agentic Shield', note: 'Защита от небезопасных команд' },
];

/** Open the Agent Constructor modal */
export function openAgentConstructor(options: {
  profile?: AgentProfile;
  send: (msg: ClientMessage) => boolean;
  onSave?: (agent: AgentProfileDraft) => void;
}): void {
  const { profile, send, onSave } = options;
  const isEditing = !!profile;

  // Working state
  let currentExecutor: Executor = profile?.executor ?? 'codex';
  let currentModel: string = profile?.model ?? 'gpt-6.1-sol';
  let currentEffort: string = profile?.effort ?? 'high';
  let currentRole: AgentRoleId = profile?.role ?? 'coder';
  let currentAccess: Access = profile?.access ?? 'write';
  let outfitColor = profile?.appearance?.outfit ?? '#10a37f';
  let currentAccessory: Appearance['accessory'] = profile?.appearance?.accessory ?? 'glasses';
  const selectedMcp = new Set<McpId>(profile?.mcp ?? ['markitdown', 'context-budget', 'strategic-compact', 'agentic-shield']);
  let currentAdvanced: AdvancedSettings = profile?.advanced ? structuredClone(profile.advanced) : structuredClone(DEFAULT_ADVANCED);

  const container = document.createElement('div');
  container.className = 'agent-constructor-form';

  container.innerHTML = `
    <div class="chips-row">
      <span class="note">Шаблоны роли в 1 клик:</span>
      ${(Object.keys(ROLE_TEMPLATES) as AgentRoleId[])
        .map(
          (roleId) =>
            `<button type="button" class="role-chip ${roleId === currentRole ? 'on' : ''}" data-template="${esc(roleId)}">${esc(ROLE_LABEL[roleId])}</button>`,
        )
        .join('')}
    </div>

    <div class="constructor-grid">
      <div class="constructor-col">
        <label class="constructor-field">
          <span>Имя сотрудника</span>
          <input type="text" name="name" value="${esc(profile?.name ?? 'Архитектор кода')}" placeholder="Например: Архитектор кода" required />
        </label>

        <label class="constructor-field">
          <span>Роль</span>
          <select name="role">
            ${(Object.keys(ROLE_LABEL) as AgentRoleId[])
              .map((roleId) => `<option value="${esc(roleId)}" ${roleId === currentRole ? 'selected' : ''}>${esc(ROLE_LABEL[roleId])}</option>`)
              .join('')}
          </select>
        </label>

        <label class="constructor-field" id="role-title-row" ${currentRole === 'custom' ? '' : 'hidden'}>
          <span>Название своей роли</span>
          <input type="text" name="roleTitle" value="${esc(profile?.roleTitle ?? '')}" placeholder="Например: Эксперт по квантовым вычислениям" />
        </label>

        <label class="constructor-field">
          <span>Цель (Goal)</span>
          <textarea name="goal" rows="2" placeholder="Главная задача сотрудника">${esc(profile?.goal ?? ROLE_TEMPLATES.coder.goal)}</textarea>
        </label>

        <label class="constructor-field">
          <span>Характер и опыт (Backstory)</span>
          <textarea name="backstory" rows="3" placeholder="Предыстория, стиль рассуждений и специфика">${esc(profile?.backstory ?? ROLE_TEMPLATES.coder.backstory)}</textarea>
        </label>

        <label class="constructor-field">
          <span>Формат результата (Expected Output)</span>
          <textarea name="expectedOutputFormat" rows="2" placeholder="В каком виде сдавать результат">${esc(profile?.expectedOutputFormat ?? ROLE_TEMPLATES.coder.expectedOutputFormat)}</textarea>
        </label>
      </div>

      <div class="constructor-col">
        <div class="constructor-field">
          <span>Провайдер и Модель</span>
          <div id="constructor-model-select"></div>
        </div>

        <div class="constructor-field">
          <span>Режим доступа</span>
          <div class="seg" data-name="access">
            <button type="button" data-value="read" class="${currentAccess === 'read' ? 'on' : ''}">Только чтение</button>
            <button type="button" data-value="write" class="${currentAccess === 'write' ? 'on' : ''}">Может править</button>
          </div>
        </div>

        <div class="constructor-field">
          <span>Внешность и Аксессуар</span>
          <div class="appearance-box">
            <div class="preview-character-box" id="avatar-preview-box"></div>
            <div class="constructor-col">
              <span class="note">Цвет одежды:</span>
              <div class="palette-row">
                ${PALETTE.map(
                  (p) =>
                    `<div class="palette-swatch ${p.cls} ${p.hex === outfitColor ? 'on' : ''}" data-hex="${esc(p.hex)}" title="${esc(p.label)}"></div>`,
                ).join('')}
              </div>
              <span class="accessory-label">Аксессуар:</span>
              <div class="accessory-grid">
                ${ACCESSORIES.map(
                  (a) =>
                    `<button type="button" class="accessory-btn ${a.id === currentAccessory ? 'on' : ''}" data-acc="${esc(a.id)}">${esc(a.label)}</button>`,
                ).join('')}
              </div>
            </div>
          </div>
        </div>

        <div class="constructor-field">
          <span>Подключенные MCP-инструменты</span>
          <div class="mcp-checks-grid">
            ${MCP_LIST.map(
              (m) =>
                `<label class="mcp-check-item" title="${esc(m.note)}">
                  <input type="checkbox" data-mcp="${esc(m.id)}" ${selectedMcp.has(m.id) ? 'checked' : ''} />
                  <span>${esc(m.label)}</span>
                </label>`,
            ).join('')}
          </div>
        </div>
      </div>
    </div>

    <details class="advanced-details">
      <summary>⚙ Тонкие настройки работы (Advanced)</summary>
      <div class="advanced-body">
        <div class="constructor-grid">
          <div class="constructor-col">
            <div class="constructor-field">
              <span>Температура рассуждений</span>
              <div class="seg" data-name="temperature">
                <button type="button" data-value="strict" class="${currentAdvanced.temperature === 'strict' ? 'on' : ''}">Строгий 0.1</button>
                <button type="button" data-value="balanced" class="${currentAdvanced.temperature === 'balanced' ? 'on' : ''}">Сбалансированный 0.5</button>
                <button type="button" data-value="creative" class="${currentAdvanced.temperature === 'creative' ? 'on' : ''}">Художественный 0.85</button>
              </div>
            </div>

            <div class="constructor-field">
              <span>Автоповторы при сбоях (Retries)</span>
              <div class="seg" data-name="retries">
                <button type="button" data-value="0" class="${currentAdvanced.retries === 0 ? 'on' : ''}">0</button>
                <button type="button" data-value="1" class="${currentAdvanced.retries === 1 ? 'on' : ''}">1</button>
                <button type="button" data-value="2" class="${currentAdvanced.retries === 2 ? 'on' : ''}">2</button>
                <button type="button" data-value="3" class="${currentAdvanced.retries === 3 ? 'on' : ''}">3</button>
              </div>
            </div>

            <div class="constructor-field">
              <span>Тайм-аут шага</span>
              <select name="timeout">
                <option value="120000" ${currentAdvanced.timeoutMs === 120000 ? 'selected' : ''}>2 минуты</option>
                <option value="300000" ${currentAdvanced.timeoutMs === 300000 ? 'selected' : ''}>5 минут</option>
                <option value="900000" ${currentAdvanced.timeoutMs === 900000 ? 'selected' : ''}>15 минут</option>
                <option value="1800000" ${currentAdvanced.timeoutMs === 1800000 ? 'selected' : ''}>30 минут</option>
                <option value="null" ${currentAdvanced.timeoutMs === null ? 'selected' : ''}>Без лимита</option>
              </select>
            </div>
          </div>

          <div class="constructor-col">
            <div class="constructor-field">
              <span>Бюджет контекста (символов)</span>
              <div class="budget-row">
                <input type="number" name="maxInputChars" value="${currentAdvanced.contextBudget.maxInputChars}" placeholder="Вход (макс)" />
                <input type="number" name="maxOutputChars" value="${currentAdvanced.contextBudget.maxOutputChars}" placeholder="Выход (макс)" />
              </div>
            </div>

            <label class="constructor-field">
              <span>Стратегия переполнения контекста</span>
              <select name="overflow">
                <option value="compact" ${currentAdvanced.contextBudget.overflow === 'compact' ? 'selected' : ''}>Умное сжатие (Compact)</option>
                <option value="trim" ${currentAdvanced.contextBudget.overflow === 'trim' ? 'selected' : ''}>Обрезка старых логов (Trim)</option>
                <option value="file" ${currentAdvanced.contextBudget.overflow === 'file' ? 'selected' : ''}>Файловая ссылка (File)</option>
              </select>
            </label>

            <label class="constructor-field">
              <span>Разрешенные пути (через запятую)</span>
              <input type="text" name="allowedPaths" value="${esc(currentAdvanced.allowedPaths.join(', '))}" placeholder="src/, docs/" />
            </label>

            <label class="constructor-field">
              <span>Игнорируемые пути (через запятую)</span>
              <input type="text" name="ignoredPaths" value="${esc(currentAdvanced.ignoredPaths.join(', '))}" placeholder=".git/, node_modules/" />
            </label>

            <div class="constructor-field" id="cli-flags-group">
              <span>Флаги CLI (${esc(currentExecutor)})</span>
              <div id="cli-flags-list" class="chips-row"></div>
            </div>
          </div>
        </div>
      </div>
    </details>
  `;

  // Mount modelSelect
  const modelSelectMount = container.querySelector<HTMLElement>('#constructor-model-select')!;
  const modelCtrl = modelSelect({
    container: modelSelectMount,
    send,
    initialExecutor: currentExecutor,
    initialModel: currentModel,
    initialEffort: currentEffort,
    showUnified: true,
    showEffort: true,
    onChange: (val) => {
      currentExecutor = val.executor;
      currentModel = val.model;
      currentEffort = val.effort ?? '';
      updateCliFlags();
      renderAvatarPreview();
    },
    onExecutorChange: (ex) => {
      currentExecutor = ex;
      updateCliFlags();
      renderAvatarPreview();
    },
  });

  // Render avatar SVG preview
  const avatarBox = container.querySelector<HTMLElement>('#avatar-preview-box')!;
  function renderAvatarPreview(): void {
    const isFloating = currentExecutor === 'antigravity';
    const acc = currentAccessory;
    let accSvg = '';
    if (acc === 'glasses') {
      accSvg = '<circle cx="31" cy="27" r="4" fill="none" stroke="#222" stroke-width="1.5"/><circle cx="41" cy="27" r="4" fill="none" stroke="#222" stroke-width="1.5"/><line x1="35" y1="27" x2="37" y2="27" stroke="#222" stroke-width="1.5"/>';
    } else if (acc === 'headphones') {
      accSvg = '<path d="M 23 27 A 13 13 0 0 1 49 27" fill="none" stroke="#222" stroke-width="2.5"/><rect x="21" y="24" width="4" height="8" rx="2" fill="#3b82f6"/><rect x="47" y="24" width="4" height="8" rx="2" fill="#3b82f6"/>';
    } else if (acc === 'scarf') {
      accSvg = '<path d="M 26 38 Q 36 43 46 38" fill="none" stroke="#f59e0b" stroke-width="5" stroke-linecap="round"/>';
    } else if (acc === 'cap') {
      accSvg = '<path d="M 25 18 Q 36 12 47 18" fill="#374151"/><rect x="30" y="16" width="18" height="3" rx="1.5" fill="#374151"/>';
    } else if (acc === 'badge') {
      accSvg = '<rect x="39" y="44" width="6" height="8" rx="1" fill="#fff" stroke="#999" stroke-width="0.8"/><rect x="40" y="46" width="4" height="2" fill="#3b82f6"/>';
    }

    const shadowY = isFloating ? 70 : 66;
    const bodyY = isFloating ? 38 : 42;
    const headY = isFloating ? 24 : 28;

    avatarBox.innerHTML = `
      <svg class="preview-character-canvas" viewBox="0 0 72 80">
        <ellipse cx="36" cy="${shadowY}" rx="${isFloating ? 10 : 14}" ry="4" fill="#000000" opacity="0.18" />
        ${isFloating ? '<ellipse cx="36" cy="56" rx="6" ry="2.5" fill="#4285f4" opacity="0.4" />' : ''}
        <!-- legs -->
        <rect x="31" y="${bodyY + 12}" width="4" height="10" rx="2" fill="#2f3542" />
        <rect x="37" y="${bodyY + 12}" width="4" height="10" rx="2" fill="#2f3542" />
        <!-- body -->
        <rect x="27" y="${bodyY}" width="18" height="14" rx="4" fill="${outfitColor}" />
        <!-- head -->
        <circle cx="36" cy="${headY}" r="11" fill="#f1c27d" />
        <!-- eyes -->
        <circle cx="32" cy="${headY}" r="1.5" fill="#1f2430" />
        <circle cx="40" cy="${headY}" r="1.5" fill="#1f2430" />
        <!-- accessory -->
        ${accSvg}
      </svg>
    `;
  }
  renderAvatarPreview();

  // Color palette swatch clicks
  container.querySelectorAll<HTMLElement>('.palette-swatch').forEach((swatch) => {
    swatch.addEventListener('click', () => {
      container.querySelectorAll('.palette-swatch').forEach((s) => s.classList.remove('on'));
      swatch.classList.add('on');
      outfitColor = swatch.dataset.hex ?? '#10a37f';
      renderAvatarPreview();
    });
  });

  // Accessory button clicks
  container.querySelectorAll<HTMLElement>('.accessory-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.accessory-btn').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      currentAccessory = (btn.dataset.acc as Appearance['accessory']) ?? 'none';
      renderAvatarPreview();
    });
  });

  // Access segment
  container.querySelectorAll<HTMLButtonElement>('.seg[data-name="access"] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.seg[data-name="access"] button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      currentAccessory;
      currentAccess = (btn.dataset.value as Access) ?? 'write';
    });
  });

  // Role select change
  const roleSelect = container.querySelector<HTMLSelectElement>('select[name="role"]')!;
  const roleTitleRow = container.querySelector<HTMLElement>('#role-title-row')!;
  roleSelect.addEventListener('change', () => {
    currentRole = roleSelect.value as AgentRoleId;
    roleTitleRow.hidden = currentRole !== 'custom';
    container.querySelectorAll('.role-chip').forEach((c) => {
      c.classList.toggle('on', (c as HTMLElement).dataset.template === currentRole);
    });
  });

  // 1-Click Role Template chips
  container.querySelectorAll<HTMLButtonElement>('.role-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const tId = chip.dataset.template as AgentRoleId;
      const t = ROLE_TEMPLATES[tId];
      if (!t) return;

      container.querySelectorAll('.role-chip').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');

      currentRole = tId;
      roleSelect.value = tId;
      roleTitleRow.hidden = tId !== 'custom';

      container.querySelector<HTMLInputElement>('input[name="name"]')!.value = t.name;
      container.querySelector<HTMLTextAreaElement>('textarea[name="goal"]')!.value = t.goal;
      container.querySelector<HTMLTextAreaElement>('textarea[name="backstory"]')!.value = t.backstory;
      container.querySelector<HTMLTextAreaElement>('textarea[name="expectedOutputFormat"]')!.value = t.expectedOutputFormat;
    });
  });

  // Advanced temperature seg
  container.querySelectorAll<HTMLButtonElement>('.seg[data-name="temperature"] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.seg[data-name="temperature"] button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      currentAdvanced.temperature = (btn.dataset.value as TemperaturePreset) ?? 'balanced';
    });
  });

  // Advanced retries seg
  container.querySelectorAll<HTMLButtonElement>('.seg[data-name="retries"] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.seg[data-name="retries"] button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      currentAdvanced.retries = Number(btn.dataset.value) as 0 | 1 | 2 | 3;
    });
  });

  // CLI flags list
  const cliFlagsList = container.querySelector<HTMLElement>('#cli-flags-list')!;
  function updateCliFlags(): void {
    const allowed = ALLOWED_CLI_FLAGS[currentExecutor] ?? [];
    cliFlagsList.innerHTML = allowed
      .map((flag) => {
        const isChecked = currentAdvanced.cliFlags.includes(flag);
        return `<label class="chip-flag">
          <input type="checkbox" data-flag="${esc(flag)}" ${isChecked ? 'checked' : ''} />
          <code>${esc(flag)}</code>
        </label>`;
      })
      .join('');

    cliFlagsList.querySelectorAll<HTMLInputElement>('input[data-flag]').forEach((chk) => {
      chk.addEventListener('change', () => {
        const flag = chk.dataset.flag!;
        if (chk.checked) {
          if (!currentAdvanced.cliFlags.includes(flag)) currentAdvanced.cliFlags.push(flag);
        } else {
          currentAdvanced.cliFlags = currentAdvanced.cliFlags.filter((f) => f !== flag);
        }
      });
    });
  }
  updateCliFlags();

  // Build dialog actions
  const modalActions: {
    label: string;
    kind?: 'primary' | 'danger' | 'default';
    onClick: (m: { close: () => void }) => void;
  }[] = [];

  if (isEditing) {
    modalActions.push({
      label: 'Удалить',
      kind: 'danger',
      onClick: (m) => {
        if (confirm(`Удалить сотрудника "${profile.name}"?`)) {
          send({ type: 'agents.delete', id: profile.id });
          showToast(`Сотрудник "${profile.name}" удален`, 'info');
          m.close();
        }
      },
    });

    modalActions.push({
      label: 'Дублировать',
      kind: 'default',
      onClick: (m) => {
        send({ type: 'agents.duplicate', id: profile.id });
        showToast(`Создан дубликат "${profile.name}"`, 'ok');
        m.close();
      },
    });
  }

  modalActions.push({
    label: isEditing ? 'Сохранить изменения' : 'Создать сотрудника',
    kind: 'primary',
    onClick: (m) => {
      const nameInput = container.querySelector<HTMLInputElement>('input[name="name"]')!;
      const name = nameInput.value.trim();
      if (!name) {
        showToast('Укажите имя сотрудника', 'warn');
        nameInput.focus();
        return;
      }

      const goal = container.querySelector<HTMLTextAreaElement>('textarea[name="goal"]')!.value.trim();
      const backstory = container.querySelector<HTMLTextAreaElement>('textarea[name="backstory"]')!.value.trim();
      const expectedOutputFormat = container.querySelector<HTMLTextAreaElement>('textarea[name="expectedOutputFormat"]')!.value.trim();
      const roleTitle = currentRole === 'custom' ? container.querySelector<HTMLInputElement>('input[name="roleTitle"]')!.value.trim() : undefined;

      // Collect MCP
      const mcp: McpId[] = [];
      container.querySelectorAll<HTMLInputElement>('input[data-mcp]:checked').forEach((chk) => {
        mcp.push(chk.dataset.mcp as McpId);
      });

      // Advanced values
      const timeoutVal = container.querySelector<HTMLSelectElement>('select[name="timeout"]')!.value;
      const timeoutMs = timeoutVal === 'null' ? null : Number(timeoutVal);

      const maxInputChars = Number(container.querySelector<HTMLInputElement>('input[name="maxInputChars"]')!.value) || 400000;
      const maxOutputChars = Number(container.querySelector<HTMLInputElement>('input[name="maxOutputChars"]')!.value) || 400000;
      const overflow = container.querySelector<HTMLSelectElement>('select[name="overflow"]')!.value as OverflowStrategy;

      const allowedPathsStr = container.querySelector<HTMLInputElement>('input[name="allowedPaths"]')!.value;
      const allowedPaths = allowedPathsStr.split(',').map((p) => p.trim()).filter(Boolean);

      const ignoredPathsStr = container.querySelector<HTMLInputElement>('input[name="ignoredPaths"]')!.value;
      const ignoredPaths = ignoredPathsStr.split(',').map((p) => p.trim()).filter(Boolean);

      currentAdvanced.timeoutMs = timeoutMs;
      currentAdvanced.contextBudget = { maxInputChars, maxOutputChars, overflow };
      currentAdvanced.allowedPaths = allowedPaths;
      currentAdvanced.ignoredPaths = ignoredPaths;

      const draft: AgentProfileDraft = {
        id: profile?.id,
        name,
        role: currentRole,
        roleTitle,
        goal,
        backstory,
        expectedOutputFormat,
        executor: currentExecutor,
        model: currentModel,
        effort: currentEffort || undefined,
        access: currentAccess,
        appearance: {
          outfit: outfitColor,
          accessory: currentAccessory,
        },
        mcp,
        advanced: currentAdvanced,
      };

      // Close only once the daemon accepted it: a refused profile keeps the form and says why.
      const requestId = crypto.randomUUID();
      const answer = store.expectAck(requestId);
      if (!send({ type: 'agents.save', agent: draft, requestId })) {
        showToast('Нет связи с демоном — сотрудник не сохранён', 'bad');
        return;
      }
      void answer.then((result) => {
        if (!result.ok) {
          showToast(result.message ?? 'Не удалось сохранить сотрудника', 'bad');
          return;
        }
        showToast(isEditing ? `Сотрудник «${name}» обновлён` : `Сотрудник «${name}» создан`, 'ok');
        onSave?.(draft);
        m.close();
      });
    },
  });

  showModal({
    title: isEditing ? `Редактирование: ${profile.name}` : 'Конструктор сотрудника',
    content: container,
    actions: modalActions,
    onClose: () => {
      modelCtrl.destroy();
    },
    className: 'agent-constructor-modal',
  });
}
