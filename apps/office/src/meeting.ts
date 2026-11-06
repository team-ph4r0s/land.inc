import type {
  ArtifactKind,
  ClientMessage,
  Collaboration,
  CollabTurn,
  ModelOption,
  NewTeamRun,
  StepKind,
  TeamRun,
  TeamStep,
  TeamStepSpec,
  Topology,
  WorkflowPreset,
} from '@land/protocol';
import { store } from './store';
import { esc, base, showToast, showModal, modelOptionLabel, modelSelect } from './ui-kit';

const STATUS: Record<Collaboration['status'], string> = {
  running: 'идёт работа',
  stopping: 'останавливается',
  done: 'готово',
  failed: 'ошибка',
  stopped: 'остановлена',
};

const CHIP: Record<Collaboration['status'], string> = {
  running: 'running',
  stopping: 'cancelling',
  done: 'done',
  failed: 'failed',
  stopped: 'cancelled',
};

const TURN: Record<CollabTurn['status'], string> = {
  waiting: 'ожидает',
  running: 'работает',
  done: 'завершил',
  failed: 'ошибка',
  cancelled: 'отменён',
  skipped: 'пропущен',
};

const ROLE: Record<CollabTurn['role'], string> = {
  planner: 'Планирование',
  author: 'Основной исполнитель',
  reviewer: 'Проверка',
  finisher: 'Итог',
};

const EXECUTOR = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' } as const;

const TOPOLOGY_INFO: Record<Topology, { name: string; desc: string }> = {
  sequential: {
    name: 'Последовательный конвейер',
    desc: 'Этапы передают типизированные артефакты строго по цепочке от одного агента к следующему.',
  },
  'critic-loop': {
    name: 'Цикл с рецензированием (1–5)',
    desc: 'Исполнитель создаёт черновик, Критик проверяет до вердикта APPROVED или лимита итераций.',
  },
  council: {
    name: 'Параллельный консилиум + Синтез',
    desc: 'Несколько специалистов независимо анализируют проблему, затем Синтезатор формирует решение.',
  },
  manager: {
    name: 'Автономный Тимлид',
    desc: 'Ведущий тимлид декомпозирует задачу, распределяет шаги и принимает готовую работу.',
  },
};

const ARTIFACT_KINDS: ArtifactKind[] = [
  'ArchitectureSpec',
  'ImplementationDiff',
  'VerificationReport',
  'SecurityAudit',
  'ChapterOutline',
  'ChapterDraft',
  'ContinuityAndLogicCritique',
  'StylisticPolishedManuscript',
  'Synthesis',
  'Plan',
  'Generic',
];

const STEP_KINDS: { id: StepKind; label: string }[] = [
  { id: 'worker', label: 'Исполнитель (Worker)' },
  { id: 'critic', label: 'Критик (Critic)' },
  { id: 'fixer', label: 'Правщик (Fixer)' },
  { id: 'synthesizer', label: 'Синтезатор (Synthesizer)' },
  { id: 'manager', label: 'Тимлид (Manager)' },
];

/**
 * Task 4: MeetingPanel (Переговорка 1.5)
 * Topologies, typed step specs with employees/manual models, World Anchor, presets,
 * agent compatibility matrix, TeamRun with artifacts & resume, and legacy collab history.
 */
export class MeetingPanel {
  private el: HTMLElement;
  private send: (m: ClientMessage) => boolean;
  private onShowAgent: (id: string) => void;

  private teamRuns: TeamRun[] = [];
  private collabs: Collaboration[] = [];
  private agents = new Set<string>();
  private models = new Map<string, string>();
  private open = new Set<string>();

  // Pipeline draft state
  private selectedTopology: Topology = 'sequential';
  private maxIterations = 3;
  private anchorText = '';
  private promptText = '';
  private currentPresetId?: string;
  private steps: TeamStepSpec[] = [
    { title: 'Проектирование архитектуры', executor: 'claude', model: '', access: 'read', kind: 'worker', produces: 'ArchitectureSpec' },
    { title: 'Реализация и код', executor: 'codex', model: '', access: 'write', kind: 'worker', produces: 'ImplementationDiff' },
  ];
  /** Steps whose model is typed by hand («Указать кастомный ID модели…»). */
  private customModel = new Set<number>();
  private projects: string[] = [];
  private cwd = '';
  private painted = new WeakMap<HTMLElement, string>();

  constructor(el: HTMLElement, send: (m: ClientMessage) => boolean, onShowAgent: (id: string) => void) {
    this.el = el;
    this.send = send;
    this.onShowAgent = onShowAgent;

    this.bindEvents();
    this.render();

    store.on('teams', () => {
      this.teamRuns = store.teamRuns;
      this.render();
    });
    // The step model lists come from the daemon's catalog.
    store.on('catalog', () => this.render());
    store.on('agents', () => this.render());
  }

  get running(): number {
    const liveRuns = this.teamRuns.filter((r) => r.status === 'running' || r.status === 'stopping').length;
    const liveCollabs = this.collabs.filter((c) => c.status === 'running' || c.status === 'stopping').length;
    return liveRuns + liveCollabs;
  }

  setAgents(ids: Set<string>): void {
    this.agents = ids;
    this.render();
  }

  setModels(models: ModelOption[]): void {
    this.models = new Map(models.map((m) => [m.id, m.label]));
    this.render();
  }

  setAll(collabs: Collaboration[]): void {
    this.collabs = collabs;
    this.render();
  }

  upsert(collab: Collaboration): void {
    const i = this.collabs.findIndex((c) => c.id === collab.id);
    if (i >= 0) this.collabs[i] = collab;
    else this.collabs.unshift(collab);
    this.render();
  }

  /** Project folders the board knows; the team works in one of them. */
  setProjects(projects: string[]): void {
    this.projects = projects;
    if (!this.cwd || !projects.includes(this.cwd)) this.cwd = projects[0] ?? '';
    this.render();
  }

  setTeams(runs: TeamRun[], presets: WorkflowPreset[]): void {
    this.teamRuns = runs;
    store.setTeams(runs, presets);
    this.render();
  }

  updateTeamRun(run: TeamRun): void {
    const i = this.teamRuns.findIndex((r) => r.id === run.id);
    if (i >= 0) this.teamRuns[i] = run;
    else this.teamRuns.unshift(run);
    this.render();
  }

  addStepFromEmployee(agentId: string): void {
    const emp = store.agents.find((a) => a.id === agentId);
    if (!emp) return;

    let defaultProduces: ArtifactKind = 'Generic';
    let defaultKind: StepKind = 'worker';

    if (emp.role === 'writer') {
      defaultProduces = 'ChapterDraft';
      defaultKind = 'worker';
    } else if (emp.role === 'critic') {
      defaultProduces = 'ContinuityAndLogicCritique';
      defaultKind = 'critic';
    } else if (emp.role === 'editor') {
      defaultProduces = 'StylisticPolishedManuscript';
      defaultKind = 'fixer';
    } else if (emp.role === 'architect') {
      defaultProduces = 'ArchitectureSpec';
      defaultKind = 'worker';
    } else if (emp.role === 'coder') {
      defaultProduces = 'ImplementationDiff';
      defaultKind = 'worker';
    } else if (emp.role === 'security') {
      defaultProduces = 'SecurityAudit';
      defaultKind = 'critic';
    }

    this.steps.push({
      agentId: emp.id,
      title: `${emp.name} (${emp.role})`,
      executor: emp.executor,
      model: emp.model,
      effort: emp.effort,
      access: emp.access,
      kind: defaultKind,
      produces: defaultProduces,
    });

    this.render();
  }

  private render(): void {
    if (!this.el.querySelector(':scope > .meeting-container')) {
      this.el.innerHTML = `
        <div class="meeting-container">
          <div>
            <span class="eyebrow">ПЕРЕГОВОРКА 1.5</span>
            <h2 class="employees-title">Командные конвейеры</h2>
            <p class="note">Многоэтапное решение задач с типизированными артефактами и контролем вердиктов.</p>
          </div>
          <div data-region="runs"></div>
          <div data-region="builder"></div>
          <div data-region="history"></div>
        </div>`;
    }
    this.patch('runs', this.renderTeamRuns());
    this.patch('builder', this.renderPipelineBuilder());
    this.patch('history', this.renderCollabsHistory());
  }

  /**
   * Replace a region only when its markup changed, and give the focused field its focus
   * and caret back: run updates stream in while the user types the next task.
   */
  private patch(name: 'runs' | 'builder' | 'history', html: string): void {
    const el = this.el.querySelector<HTMLElement>(`[data-region="${name}"]`)!;
    if (this.painted.get(el) === html) return;
    const active = document.activeElement;
    let restore: (() => void) | undefined;
    if (active instanceof HTMLElement && el.contains(active)) {
      const attr = [...active.attributes].find((a) => a.name.startsWith('data-'));
      if (attr) {
        const selector = `[${attr.name}="${CSS.escape(attr.value)}"]`;
        const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : undefined;
        const range = field ? ([field.selectionStart, field.selectionEnd] as const) : undefined;
        restore = () => {
          const next = el.querySelector<HTMLElement>(selector);
          next?.focus({ preventScroll: true });
          if (range && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && next.type !== 'number') next.setSelectionRange(range[0], range[1]);
        };
      }
    }
    this.painted.set(el, html);
    el.innerHTML = html;
    restore?.();
  }

  private renderTeamRuns(): string {
    if (!this.teamRuns.length) return '';

    let html = `<h3>Активные и недавние запуски команд (${this.teamRuns.length})</h3><div class="tasks">`;

    for (const run of this.teamRuns) {
      const isLive = run.status === 'running' || run.status === 'stopping';
      const topMeta = TOPOLOGY_INFO[run.topology];

      html += `
        <div class="team-run-card ${run.status}" data-run-id="${esc(run.id)}">
          <div class="task-head">
            <span class="chip ${CHIP[run.status]}">${STATUS[run.status]}</span>
            <span class="badge role">${esc(topMeta?.name ?? run.topology)}</span>
            ${run.topology === 'critic-loop' ? `<span class="badge default">Итерация ${run.iteration} / ${run.maxIterations}</span>` : ''}
          </div>

          <div class="task-prompt">${esc(run.prompt)}</div>
          ${run.reason ? `<div class="note">${esc(run.reason)}</div>` : ''}
          <div class="note">📁 ${esc(base(run.cwd))} · ${new Date(run.createdAt).toLocaleTimeString()}</div>

          <!-- Stepper -->
          <ul class="run-stepper">
            ${run.steps
              .map((st, i) => {
                const isStepRunning = st.status === 'running';
                const statusBadge =
                  st.status === 'done'
                    ? '<span class="badge done">✓ Завершен</span>'
                    : st.status === 'running'
                    ? '<span class="badge running">● Выполняется</span>'
                    : st.status === 'failed'
                    ? '<span class="badge failed">✕ Ошибка</span>'
                    : `<span class="badge default">${esc(TURN[st.status])}</span>`;

                return `
                  <li class="run-step-item ${isStepRunning ? 'running' : ''}">
                    <div>
                      <strong>Шаг ${i + 1}: ${esc(st.title)}</strong>
                      <div class="note">${EXECUTOR[st.executor]} · ${esc(this.modelLabel(st.executor, st.model))}${st.effort ? ' · ' + esc(st.effort) : ''} · Производит: <code>${esc(st.produces)}</code></div>
                      ${st.error ? `<div class="error">${esc(st.error)}</div>` : ''}
                    </div>
                    <div class="step-status-row">
                      ${statusBadge}
                      ${
                        (run.status === 'failed' || run.status === 'stopped') && st.status !== 'done' && (run.topology !== 'sequential' || i === run.steps.findIndex((x) => x.status !== 'done'))
                          ? `<button type="button" class="btn small" data-act="resume-step" data-run-id="${esc(run.id)}" data-step="${i}">Продолжить с Шага ${i + 1}</button>`
                          : ''
                      }
                    </div>
                  </li>
                `;
              })
              .join('')}
          </ul>

          <!-- Artifacts -->
          ${
            run.artifacts.length > 0
              ? `
              <div class="artifacts-list">
                <span class="note bold-note">Сформированные артефакты (${run.artifacts.length}):</span>
                ${run.artifacts
                  .map((art, aIdx) => {
                    const verdictBadge =
                      art.verdict === 'APPROVED'
                        ? '<span class="verdict-approved">APPROVED</span>'
                        : art.verdict === 'NEEDS_REVISION'
                        ? '<span class="verdict-needs-revision">NEEDS_REVISION</span>'
                        : '';
                    const artKey = `art:${run.id}:${aIdx}`;
                    const isOpen = this.open.has(artKey);

                    return `
                      <div class="artifact-card">
                        <div class="artifact-header">
                          <div>
                            <span class="badge role">${esc(art.kind)}</span>
                            <small class="note">${art.size} симв. · Шаг ${art.stepIndex + 1} (ит. ${art.iteration})</small>
                          </div>
                          ${verdictBadge}
                        </div>
                        <details data-key="${artKey}" ${isOpen ? 'open' : ''} class="artifact-details">
                          <summary class="artifact-summary">Содержимое артефакта</summary>
                          <pre class="task-result">${esc(art.content)}</pre>
                        </details>
                      </div>
                    `;
                  })
                  .join('')}
              </div>
            `
              : ''
          }

          ${run.result ? `<div class="task-result"><strong>Итог:</strong><br>${esc(run.result)}</div>` : ''}

          <div class="task-actions top-gap-md">
            ${isLive ? `<button type="button" class="btn danger" data-act="stop-team" data-id="${esc(run.id)}">Остановить команду</button>` : ''}
          </div>
        </div>
      `;
    }

    html += `</div>`;
    return html;
  }

  private renderPipelineBuilder(): string {
    const presets = store.teamPresets;

    return `
      <section class="task">
        <div class="task-head">
          <h3>Конструктор командного конвейера</h3>
        </div>

        <!-- Presets Bar -->
        <div class="constructor-field">
          <span>Шаблоны команд (Presets)</span>
          <div class="preset-row">
            <select data-preset-select class="flex-1">
              <option value="">-- Выберите пресет конвейера --</option>
              ${presets
                .map(
                  (p) =>
                    `<option value="${esc(p.id)}" ${p.id === this.currentPresetId ? 'selected' : ''}>${esc(p.name)} (${esc(p.topology)})</option>`,
                )
                .join('')}
            </select>
            <button type="button" class="btn small" data-act="save-preset" title="Сохранить текущие шаги как пресет">Сохранить как пресет</button>
            ${
              this.currentPresetId && !presets.find((p) => p.id === this.currentPresetId)?.builtin
                ? `<button type="button" class="btn small danger" data-act="delete-preset">Удалить пресет</button>`
                : ''
            }
          </div>
        </div>

        <!-- Topology Selector -->
        <div class="constructor-field">
          <span>Топология взаимодействия</span>
          <div class="topology-selector">
            ${(Object.keys(TOPOLOGY_INFO) as Topology[])
              .map((topId) => {
                const info = TOPOLOGY_INFO[topId];
                const isSel = this.selectedTopology === topId;
                return `
                  <div class="topology-card ${isSel ? 'selected' : ''}" data-topology="${esc(topId)}">
                    <strong>${esc(info.name)}</strong>
                    <small>${esc(info.desc)}</small>
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>

        ${
          this.selectedTopology === 'critic-loop'
            ? `
          <div class="constructor-field">
            <span>Максимум итераций критики (1–5)</span>
            <input type="number" min="1" max="5" value="${this.maxIterations}" data-max-iter />
          </div>
        `
            : ''
        }

        <!-- World Anchor -->
        <label class="constructor-field">
          <span>Якорь: паспорт мира / глоссарий / инварианты (ChatDev Anchor)</span>
          <textarea rows="2" data-anchor placeholder="Неизменяемые правила, API контракты или глоссарий, передаваемые всем шагам">${esc(this.anchorText)}</textarea>
        </label>

        <label class="constructor-field">
          <span>Папка проекта</span>
          ${this.projects.length
            ? `<select data-team-cwd>${this.projects.map((p) => `<option value="${esc(p)}" ${p === this.cwd ? 'selected' : ''} title="${esc(p)}">${esc(base(p))} — ${esc(p)}</option>`).join('')}</select>`
            : '<p class="note">Проекты появятся после первой задачи во вкладке «Разговоры» — там можно выбрать любую папку.</p>'}
        </label>

        <!-- Prompt -->
        <label class="constructor-field">
          <span>Задача для команды</span>
          <textarea rows="3" data-team-prompt placeholder="Опишите общую цель команды (например: Создать спецификацию авторизации и имплементировать клиент)">${esc(this.promptText)}</textarea>
        </label>

        <!-- Steps List -->
        <div class="steps-builder">
          <div class="step-actions-row">
            <strong>Этапы конвейера (${this.steps.length})</strong>
            <button type="button" class="btn small primary" data-act="add-step">＋ Добавить этап</button>
          </div>

          ${this.steps
            .map((step, idx) => {
              return `
                <div class="step-card" data-step-idx="${idx}">
                  <div class="step-card-head">
                    <span class="step-card-num">${idx + 1}</span>
                    <input type="text" class="step-card-title" data-step-title="${idx}" value="${esc(step.title)}" placeholder="Название этапа" />
                    <button type="button" class="btn small danger" data-act="remove-step" data-step-idx="${idx}" title="Удалить шаг">✕</button>
                  </div>

                  <div class="meeting-step-grid">
                    <label class="constructor-field">
                      <span>Сотрудник (быстрый выбор)</span>
                      <select data-step-employee="${idx}">
                        <option value="">Настроить вручную</option>
                        ${store.agents
                          .map(
                            (emp) =>
                              `<option value="${esc(emp.id)}" ${emp.id === step.agentId ? 'selected' : ''}>${esc(emp.name)} (${esc(emp.role)})</option>`,
                          )
                          .join('')}
                      </select>
                    </label>

                    <label class="constructor-field">
                      <span>Роль на этапе (Kind)</span>
                      <select data-step-kind="${idx}">
                        ${STEP_KINDS.map(
                          (sk) => `<option value="${esc(sk.id)}" ${sk.id === step.kind ? 'selected' : ''}>${esc(sk.label)}</option>`,
                        ).join('')}
                      </select>
                    </label>
                  </div>

                  <div class="meeting-step-grid">
                    <label class="constructor-field">
                      <span>Провайдер</span>
                      <select data-step-executor="${idx}">
                        <option value="claude" ${step.executor === 'claude' ? 'selected' : ''}>Claude Code</option>
                        <option value="codex" ${step.executor === 'codex' ? 'selected' : ''}>Codex</option>
                        <option value="antigravity" ${step.executor === 'antigravity' ? 'selected' : ''}>Antigravity</option>
                      </select>
                    </label>

                    <label class="constructor-field">
                      <span>Модель</span>
                      ${this.stepModelField(step, idx)}
                    </label>
                  </div>

                  <div class="meeting-step-grid">
                    <label class="constructor-field">
                      <span>Уровень рассуждений</span>
                      ${this.stepEffortField(step, idx)}
                    </label>
                    <label class="constructor-field">
                      <span>Что производит этап (Artifact)</span>
                      <select data-step-produces="${idx}">
                        ${ARTIFACT_KINDS.map(
                          (ak) => `<option value="${esc(ak)}" ${ak === step.produces ? 'selected' : ''}>${esc(ak)}</option>`,
                        ).join('')}
                      </select>
                    </label>

                  </div>
                  <div class="meeting-step-grid">
                    <label class="constructor-field">
                      <span>Доступ</span>
                      <select data-step-access="${idx}">
                        <option value="read" ${step.access === 'read' ? 'selected' : ''}>Только чтение</option>
                        <option value="write" ${step.access === 'write' ? 'selected' : ''}>Может править</option>
                      </select>
                    </label>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>

        <!-- Visual Compatibility Matrix -->
        ${this.renderCompatibilityMatrix()}

        <button type="button" class="btn primary meeting-start-btn" data-act="start-team">
          🚀 Запустить конвейер команды
        </button>
      </section>
    `;
  }

  private modelLabel(executor: TeamStepSpec['executor'], id: string): string {
    if (!id) return 'модель по умолчанию';
    return store.findModel(id, executor)?.label ?? this.models.get(id) ?? id;
  }

  /** The step's model: the CLI's catalog in one click, a custom id only as the last option. */
  private stepModelField(step: TeamStepSpec, idx: number): string {
    const models = store.getModels(step.executor);
    const custom = this.customModel.has(idx) || (!!step.model && !models.some((m) => m.id === step.model));
    const options = [
      `<option value="" ${!step.model && !custom ? 'selected' : ''}>По умолчанию для ${EXECUTOR[step.executor]}</option>`,
      ...models.map((m) => `<option value="${esc(m.id)}" ${m.id === step.model && !custom ? 'selected' : ''}>${esc(modelOptionLabel(m))}</option>`),
      `<option value="__custom__" ${custom ? 'selected' : ''}>Указать кастомный ID модели…</option>`,
    ].join('');
    return `<div class="model-select-controls">
        <select data-step-model="${idx}">${options}</select>
        <button type="button" class="btn-rescan" data-act="rescan" title="Пересканировать модели CLI">↻</button>
      </div>
      ${custom ? `<input type="text" class="model-custom-input" data-step-custom-model="${idx}" value="${esc(step.model)}" placeholder="ID модели локального прокси" />` : ''}`;
  }

  private stepEffortField(step: TeamStepSpec, idx: number): string {
    const model = store.findModel(step.model, step.executor);
    const efforts = model?.efforts ?? [];
    const def = model?.defaultEffort ? ` (${esc(model.defaultEffort)})` : '';
    return `<select data-step-effort="${idx}" ${efforts.length ? '' : 'disabled'}>
      <option value="">по умолчанию${def}</option>
      ${efforts.map((e) => `<option value="${esc(e)}" ${e === step.effort ? 'selected' : ''}>${esc(e)}</option>`).join('')}
    </select>`;
  }

  private renderCompatibilityMatrix(): string {
    if (this.steps.length < 2) return '';

    return `
      <div class="compatibility-matrix">
        <span class="note bold-note">Матрица совместимости и передачи артефактов</span>
        <table class="matrix-table">
          <thead>
            <tr>
              <th>Откуда</th>
              <th>Куда</th>
              <th>Передаваемый артефакт</th>
              <th>Совместимость</th>
            </tr>
          </thead>
          <tbody>
            ${this.steps
              .slice(0, -1)
              .map((step, idx) => {
                const next = this.steps[idx + 1];
                let synergy = '100% (Идеально)';
                if (step.produces === 'ChapterDraft' && next.kind !== 'critic') synergy = '85% (Ожидается критик)';
                if (step.produces === 'ArchitectureSpec' && next.kind === 'worker') synergy = '100% (Архитектура → Код)';

                return `
                  <tr>
                    <td><strong>Шаг ${idx + 1}:</strong> ${esc(step.title)}</td>
                    <td><strong>Шаг ${idx + 2}:</strong> ${esc(next.title)}</td>
                    <td><code>${esc(step.produces)}</code></td>
                    <td><span class="matrix-badge-ok">${esc(synergy)}</span></td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderCollabsHistory(): string {
    if (!this.collabs.length) return '';

    return `
      <details class="collabs-history">
        <summary class="collabs-summary">История предыдущих совместных задач (${this.collabs.length})</summary>
        <div class="tasks top-gap-md">
          ${this.collabs.map((c) => this.collabCard(c)).join('')}
        </div>
      </details>
    `;
  }

  private collabCard(c: Collaboration): string {
    const live = c.status === 'running' || c.status === 'stopping';
    const current = c.turns.findIndex((t) => t.status === 'running');
    const waitingNext = live && current < 0;

    return `<div class="task collab ${c.status}">
      <div class="task-head">
        <span class="chip ${CHIP[c.status]}">${STATUS[c.status]}</span>
        <span class="who">${c.turns.length} хода · ${c.access === 'write' ? 'автор может править' : 'только чтение'}</span>
      </div>
      <div class="task-prompt">${esc(c.prompt)}</div>
      <div class="meta dim">📁 ${esc(base(c.cwd))} · ${new Date(c.createdAt).toLocaleTimeString()}</div>
      <ol class="turns">${c.turns.map((t, i) => this.turn(c, t, i)).join('')}</ol>
      ${waitingNext ? '<p class="note">Передаёт ход следующему участнику…</p>' : ''}
      ${c.result ? `<details data-key="${c.id}:result" ${this.open.has(`${c.id}:result`) ? 'open' : ''}><summary>Итог</summary><div class="task-result">${esc(c.result)}</div></details>` : ''}
      ${c.reason && c.status !== 'done' ? `<p class="note warn">${esc(c.reason)}</p>` : ''}
      ${live ? `<div class="task-actions">${this.stopButton(c)}</div>` : ''}
    </div>`;
  }

  private stopButton(c: Collaboration): string {
    const failed = c.status === 'stopping' && !!c.reason;
    const label = c.status === 'running' ? 'Остановить команду' : failed ? 'Остановить ещё раз' : 'Останавливается…';
    const disabled = c.status === 'stopping' && !failed ? 'disabled' : '';
    return `<button type="button" data-act="stop" data-id="${esc(c.id)}" ${disabled}>${label}</button>`;
  }

  private turn(c: Collaboration, t: CollabTurn, i: number): string {
    const model = this.models.get(t.model) ?? t.model;
    const show = t.agentId && this.agents.has(t.agentId);
    const key = `${c.id}:${i}`;
    return `<li class="turn ${t.status}">
      <div class="turn-head">
        <span class="turn-dot"></span>
        <b>${ROLE[t.role]}</b> · ${EXECUTOR[t.executor]} · ${esc(model)}${t.effort ? ' · ' + esc(t.effort) : ''}
        <span class="turn-state">${TURN[t.status]}${t.access === 'read' ? ' · только чтение' : ''}</span>
      </div>
      ${t.handoff ? `<details data-key="${key}" ${this.open.has(key) ? 'open' : ''}><summary>Передал дальше</summary><div class="task-result">${esc(t.handoff)}</div></details>` : ''}
      ${show ? `<button type="button" class="link" data-act="show" data-id="${esc(t.agentId!)}">Показать в офисе</button>` : ''}
    </li>`;
  }

  private bindEvents(): void {
    this.el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Topology card
      const topCard = target.closest<HTMLElement>('.topology-card');
      if (topCard) {
        this.selectedTopology = topCard.dataset.topology as Topology;
        this.render();
        return;
      }

      // Add Step
      if (target.closest('[data-act="add-step"]')) {
        this.steps.push({ title: `Этап ${this.steps.length + 1}`, executor: 'codex', model: '', access: 'read', kind: 'worker', produces: 'Generic' });
        this.render();
        return;
      }

      // Remove step
      const removeBtn = target.closest<HTMLButtonElement>('[data-act="remove-step"]');
      if (removeBtn) {
        const idx = Number(removeBtn.dataset.stepIdx);
        this.steps.splice(idx, 1);
        this.customModel = new Set([...this.customModel].filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i)));
        this.render();
        return;
      }

      // Save preset
      if (target.closest('[data-act="save-preset"]')) {
        this.promptSavePreset();
        return;
      }

      // Delete preset
      if (target.closest('[data-act="delete-preset"]')) {
        const id = this.currentPresetId;
        if (!id) return;
        showModal({
          title: 'Удалить пресет?',
          content: `<p class="note">Пресет «${esc(store.teamPresets.find((p) => p.id === id)?.name ?? '')}» будет удалён. Запуски команд останутся в истории.</p>`,
          actions: [
            { label: 'Отмена', onClick: (m) => m.close() },
            { label: 'Удалить', kind: 'danger', onClick: (m) => {
              this.send({ type: 'preset.delete', id });
              this.currentPresetId = undefined;
              m.close();
            } },
          ],
        });
        return;
      }

      if (target.closest('[data-act="rescan"]')) {
        this.send({ type: 'models.rescan' });
        showToast('Пересканирую модели CLI…', 'info', 1500);
        return;
      }

      // Start Team
      if (target.closest('[data-act="start-team"]')) {
        this.startTeamRun();
        return;
      }

      // Stop Team
      const stopTeamBtn = target.closest<HTMLButtonElement>('[data-act="stop-team"]');
      if (stopTeamBtn) {
        const id = stopTeamBtn.dataset.id!;
        this.send({ type: 'team.stop', id });
        showToast('Остановка команды запрошена…', 'warn');
        return;
      }

      // Resume Step
      const resumeBtn = target.closest<HTMLButtonElement>('[data-act="resume-step"]');
      if (resumeBtn) {
        const runId = resumeBtn.dataset.runId!;
        const stepIdx = Number(resumeBtn.dataset.step);
        this.promptResumeStep(runId, stepIdx);
        return;
      }

      // Collab buttons
      const b = target.closest<HTMLButtonElement>('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'stop') this.send({ type: 'team.cancel', id: b.dataset.id! });
      if (b.dataset.act === 'show') this.onShowAgent(b.dataset.id!);
    });

    this.el.addEventListener('input', (e) => {
      const target = e.target as HTMLElement;

      if (target.matches('[data-team-prompt]')) {
        this.promptText = (target as HTMLTextAreaElement).value;
      } else if (target.matches('[data-anchor]')) {
        this.anchorText = (target as HTMLTextAreaElement).value;
      } else if (target.matches('[data-max-iter]')) {
        this.maxIterations = Number((target as HTMLInputElement).value) || 3;
      } else if (target.matches('[data-step-title]')) {
        const idx = Number((target as HTMLInputElement).dataset.stepTitle);
        if (this.steps[idx]) this.steps[idx].title = (target as HTMLInputElement).value;
      } else if (target.matches('[data-step-custom-model]')) {
        const idx = Number((target as HTMLInputElement).dataset.stepCustomModel);
        if (this.steps[idx]) this.steps[idx].model = (target as HTMLInputElement).value.trim();
      }
    });

    this.el.addEventListener('change', (e) => {
      const target = e.target as HTMLElement;

      // Preset select
      if (target.matches('[data-preset-select]')) {
        const id = (target as HTMLSelectElement).value;
        this.currentPresetId = id || undefined;
        const preset = store.teamPresets.find((p) => p.id === id);
        if (preset) {
          this.selectedTopology = preset.topology;
          this.steps = structuredClone(preset.steps);
          this.customModel.clear();
          showToast(`Применен пресет "${preset.name}"`, 'info');
          this.render();
        }
        return;
      }

      // Step Employee pick
      if (target.matches('[data-step-employee]')) {
        const idx = Number((target as HTMLSelectElement).dataset.stepEmployee);
        const empId = (target as HTMLSelectElement).value;
        const emp = store.agents.find((a) => a.id === empId);
        if (emp && this.steps[idx]) {
          this.steps[idx].agentId = emp.id;
          this.steps[idx].title = emp.name;
          this.steps[idx].executor = emp.executor;
          this.steps[idx].model = emp.model;
          this.steps[idx].effort = emp.effort;
          this.steps[idx].access = emp.access;
          this.render();
        }
        return;
      }

      if (target.matches('[data-team-cwd]')) {
        this.cwd = (target as HTMLSelectElement).value;
        return;
      }

      // Step model from the catalog; efforts follow the model.
      if (target.matches('[data-step-model]')) {
        const idx = Number((target as HTMLSelectElement).dataset.stepModel);
        const step = this.steps[idx];
        if (!step) return;
        const value = (target as HTMLSelectElement).value;
        if (value === '__custom__') {
          this.customModel.add(idx);
          step.model = '';
        } else {
          this.customModel.delete(idx);
          step.model = value;
        }
        const efforts = store.findModel(step.model, step.executor)?.efforts ?? [];
        if (step.effort && !efforts.includes(step.effort)) step.effort = undefined;
        step.agentId = undefined;
        this.render();
        return;
      }

      if (target.matches('[data-step-effort]')) {
        const idx = Number((target as HTMLSelectElement).dataset.stepEffort);
        if (this.steps[idx]) this.steps[idx].effort = (target as HTMLSelectElement).value || undefined;
        return;
      }

      // Step Kind
      if (target.matches('[data-step-kind]')) {
        const idx = Number((target as HTMLSelectElement).dataset.stepKind);
        if (this.steps[idx]) this.steps[idx].kind = (target as HTMLSelectElement).value as StepKind;
        return;
      }

      // Step Executor
      if (target.matches('[data-step-executor]')) {
        const idx = Number((target as HTMLSelectElement).dataset.stepExecutor);
        const step = this.steps[idx];
        if (step) {
          // Another CLI has other models: start from its default.
          step.executor = (target as HTMLSelectElement).value as TeamStepSpec['executor'];
          step.model = '';
          step.effort = undefined;
          step.agentId = undefined;
          this.customModel.delete(idx);
          this.render();
        }
        return;
      }

      // Step Produces
      if (target.matches('[data-step-produces]')) {
        const idx = Number((target as HTMLSelectElement).dataset.stepProduces);
        if (this.steps[idx]) this.steps[idx].produces = (target as HTMLSelectElement).value as ArtifactKind;
        return;
      }

      // Step Access
      if (target.matches('[data-step-access]')) {
        const idx = Number((target as HTMLSelectElement).dataset.stepAccess);
        if (this.steps[idx]) this.steps[idx].access = (target as HTMLSelectElement).value as typeof this.steps[0]['access'];
        return;
      }
    });

    this.el.addEventListener(
      'toggle',
      (e) => {
        const d = e.target as HTMLDetailsElement;
        if (!d.dataset.key) return;
        if (d.open) this.open.add(d.dataset.key);
        else this.open.delete(d.dataset.key);
      },
      true,
    );
  }

  private startTeamRun(): void {
    const prompt = this.promptText.trim();
    if (!prompt) {
      showToast('Укажите общую задачу для команды', 'warn');
      return;
    }
    if (!this.steps.length) {
      showToast('Добавьте хотя бы один этап', 'warn');
      return;
    }

    if (!this.cwd) {
      showToast('Выберите папку проекта', 'warn');
      return;
    }
    if (this.steps.some((s, i) => this.customModel.has(i) && !s.model)) {
      showToast('Укажите ID модели для шага с кастомной моделью', 'warn');
      return;
    }
    const runSpec: NewTeamRun = {
      prompt,
      cwd: this.cwd,
      topology: this.selectedTopology,
      anchor: this.anchorText.trim() || undefined,
      maxIterations: this.selectedTopology === 'critic-loop' ? this.maxIterations : undefined,
      steps: structuredClone(this.steps),
      presetId: this.currentPresetId,
    };

    const requestId = crypto.randomUUID();
    const answer = store.expectAck(requestId);
    if (!this.send({ type: 'team.start', run: runSpec, requestId })) {
      showToast('Нет связи с демоном — команда не запущена', 'bad');
      return;
    }
    void answer.then((result) => {
      if (!result.ok) showToast(result.message ?? 'Команда не запущена', 'bad', 6000);
      else showToast('Команда запущена', 'ok');
    });
  }

  private promptSavePreset(): void {
    const content = document.createElement('div');
    content.innerHTML = `<label class="constructor-field"><span>Название пресета</span><input type="text" data-preset-name maxlength="80" value="Мой командный конвейер" /></label>`;
    showModal({
      title: 'Сохранить как пресет',
      content,
      actions: [
        { label: 'Отмена', onClick: (m) => m.close() },
        { label: 'Сохранить', kind: 'primary', onClick: (m) => {
          const name = content.querySelector<HTMLInputElement>('[data-preset-name]')!.value.trim();
          if (!name) return showToast('Назовите пресет', 'warn');
          const preset: WorkflowPreset = {
            id: `preset-${crypto.randomUUID()}`, name, description: `Пользовательский пресет (${TOPOLOGY_INFO[this.selectedTopology].name})`,
            topology: this.selectedTopology, steps: structuredClone(this.steps),
          };
          const requestId = crypto.randomUUID();
          const answer = store.expectAck(requestId);
          this.send({ type: 'preset.save', preset, requestId });
          void answer.then((result) => {
            if (!result.ok) return showToast(result.message ?? 'Пресет не сохранён', 'bad');
            this.currentPresetId = preset.id;
            showToast(`Пресет «${name}» сохранён`, 'ok');
            m.close();
          });
        } },
      ],
    });
  }

  private promptResumeStep(runId: string, fromStep: number): void {
    const run = this.teamRuns.find((r) => r.id === runId);
    const step = run?.steps[fromStep];
    if (!step) return;
    const content = document.createElement('div');
    content.innerHTML = `
      <p class="note">Команда продолжит с <strong>шага ${fromStep + 1} («${esc(step.title)}»)</strong>. Готовые шаги не перезапускаются: их артефакты берутся из контрольной точки.</p>
      <div class="constructor-field"><span>Модель шага — можно сменить на лету</span><div data-resume-model></div></div>`;
    const picker = modelSelect({
      container: content.querySelector<HTMLElement>('[data-resume-model]')!,
      send: this.send,
      initialExecutor: step.executor,
      initialModel: step.model,
      initialEffort: step.effort,
      showUnified: true,
    });
    showModal({
      title: `Продолжить с шага ${fromStep + 1}`,
      content,
      onClose: () => picker.destroy(),
      actions: [
        { label: 'Отмена', onClick: (m) => m.close() },
        { label: 'Продолжить', kind: 'primary', onClick: (m) => {
          const value = picker.getValue();
          const changed = value.executor !== step.executor || value.model !== step.model || (value.effort ?? '') !== (step.effort ?? '');
          const requestId = crypto.randomUUID();
          const answer = store.expectAck(requestId);
          this.send({ type: 'team.resume', id: runId, fromStep, requestId, override: changed ? value : undefined });
          void answer.then((result) => {
            if (!result.ok) return showToast(result.message ?? 'Не удалось продолжить', 'bad', 6000);
            showToast(`Команда продолжает с шага ${fromStep + 1}`, 'ok');
            m.close();
          });
        } },
      ],
    });
  }
}
