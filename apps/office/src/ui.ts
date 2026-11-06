import {
  describeModel,
  ROLE_LABEL,
  type Activity,
  type AgentProfile,
  type AgentState,
  type ClientMessage,
  type LogEntry,
} from '@land/protocol';
import { ICON } from './agent';
import { store } from './store';
import { openAgentConstructor } from './agent-constructor';
import { esc, showToast } from './ui-kit';

const LABEL: Record<Activity, string> = {
  think: 'думает',
  write: 'пишет код',
  read: 'в архиве',
  bash: 'в серверной',
  web: 'в интернете',
  plan: 'у доски',
  talk: 'на встрече',
  wait: 'ждёт вас',
  idle: 'на кухне',
};

const SOURCE_NAME: Record<AgentState['source'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  demo: 'Демо',
};

const ago = (t: number): string => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} с` : s < 3600 ? `${Math.round(s / 60)} мин` : `${Math.round(s / 3600)} ч`;
};

export type Tab = 'office' | 'tasks' | 'team' | 'dns' | 'settings' | 'updates';

/**
 * Task 2: Redesigned Sidebar and «Сотрудники» pane.
 * Shows rich Agent Profile cards with avatars, role pills, model badges, MCP indicators,
 * collapsible backstories, quick action buttons, and active session journals.
 */
export class Sidebar {
  private pending = false;
  private online = false;
  private count = 0;
  private running = 0;
  private meeting = 0;
  private tab: Tab = 'tasks';
  private head: HTMLElement;
  private el: HTMLElement;

  readonly tasksPane: HTMLElement;
  readonly teamPane: HTMLElement;
  readonly dnsPane: HTMLElement;
  readonly settingsPane: HTMLElement;
  readonly updatesPane: HTMLElement;

  onConversation?: (id: string) => void;
  onFocusAgent?: (agentId: string) => void;
  onAssignTask?: (agent: AgentProfile) => void;
  onJoinTeam?: (agent: AgentProfile) => void;

  private onPick: (id: string) => void;
  private send?: (m: ClientMessage) => boolean;
  private last?: [Map<string, AgentState>, Map<string, LogEntry[]>, string | undefined];
  private expandedBackstories = new Set<string>();

  constructor(root: HTMLElement, onPick: (id: string) => void, send?: (m: ClientMessage) => boolean) {
    root.innerHTML = `
      <div class="panel-resizer" role="separator" tabindex="0" aria-label="Ширина рабочей панели" aria-orientation="vertical" aria-valuemin="380" aria-valuemax="1100" aria-valuenow="560"></div>
      <div class="head"></div>
      <div class="pane office" hidden></div>
      <div class="pane tasks"></div>
      <div class="pane team" hidden></div>
      <div class="pane dns" hidden></div>
      <div class="pane settings" hidden></div>
      <div class="pane updates" hidden></div>
    `;

    const resize = root.querySelector<HTMLElement>('.panel-resizer')!;
    const setWidth = (width: number) => {
      const value = Math.round(Math.max(380, Math.min(width, window.innerWidth - 180, 1100)));
      root.style.setProperty('--panel-width', `${value}px`);
      resize.setAttribute('aria-valuenow', String(value));
      try {
        localStorage.setItem('land-panel-width', String(value));
      } catch {
        /* optional */
      }
    };

    try {
      const width = Number(localStorage.getItem('land-panel-width'));
      if (width) setWidth(width);
    } catch {
      /* optional */
    }

    resize.addEventListener('pointerdown', (e) => {
      resize.setPointerCapture(e.pointerId);
    });
    resize.addEventListener('pointermove', (e) => {
      if (resize.hasPointerCapture(e.pointerId)) setWidth(root.getBoundingClientRect().right - e.clientX);
    });
    resize.addEventListener('pointerup', (e) => {
      if (resize.hasPointerCapture(e.pointerId)) resize.releasePointerCapture(e.pointerId);
    });
    resize.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setWidth(root.clientWidth + (e.key === 'ArrowLeft' ? 40 : -40));
      }
    });

    this.head = root.querySelector('.head')!;
    this.el = root.querySelector('.pane.office')!;
    this.tasksPane = root.querySelector('.pane.tasks')!;
    this.teamPane = root.querySelector('.pane.team')!;
    this.dnsPane = root.querySelector('.pane.dns')!;
    this.settingsPane = root.querySelector('.pane.settings')!;
    this.updatesPane = root.querySelector('.pane.updates')!;

    this.onPick = onPick;
    this.send = send;

    this.bindEvents();
    this.renderHead();

    store.on('agents', () => {
      if (this.last) this.render(...this.last);
    });

    setInterval(() => this.last && this.render(...this.last), 5000);
  }

  setSend(send: (m: ClientMessage) => boolean): void {
    this.send = send;
  }

  show(tab: Tab): void {
    this.tab = tab;
    this.el.hidden = tab !== 'office';
    this.tasksPane.hidden = tab !== 'tasks';
    this.teamPane.hidden = tab !== 'team';
    this.dnsPane.hidden = tab !== 'dns';
    this.settingsPane.hidden = tab !== 'settings';
    this.updatesPane.hidden = tab !== 'updates';

    if (tab === 'dns') this.dnsPane.dispatchEvent(new Event('dns-open'));
    this.renderHead();
  }

  setMeeting(n: number): void {
    if (n === this.meeting) return;
    this.meeting = n;
    this.renderHead();
  }

  setRunning(n: number): void {
    this.running = n;
    this.renderHead();
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.renderHead();
    if (this.last) this.render(...this.last);
  }

  scheduleRender(states: Map<string, AgentState>, logs: Map<string, LogEntry[]>, selected?: string): void {
    this.last = [states, logs, selected];
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render(states, logs, selected);
    });
  }

  render(states: Map<string, AgentState>, logs: Map<string, LogEntry[]>, selected?: string): void {
    this.last = [states, logs, selected];
    this.count = states.size;
    this.renderHead();

    let html = '';
    let sessions = '';

    // 1. Employees header with "+ Создать сотрудника" button
    html += `
      <div class="employees-panel">
        <div class="employees-head">
          <div>
            <span class="eyebrow">КОМАНДА / СОТРУДНИКИ</span>
            <h2 class="employees-title">Штат специалистов</h2>
          </div>
          <button type="button" class="btn primary small" data-act="create-agent">＋ Создать сотрудника</button>
        </div>
    `;

    // 2. Custom Agent Profiles Cards
    const profiles = store.agents;
    if (profiles.length > 0) {
      html += `<div class="tasks">`;
      for (const agent of profiles) {
        const isBackstoryExpanded = this.expandedBackstories.has(agent.id);
        const mInfo = describeModel(agent.executor, agent.model);
        const levelBadgeText = `${mInfo.label}${agent.effort ? ' · ' + agent.effort : ''}`;
        const avatarLetter = (agent.name.trim()[0] || 'A').toUpperCase();

        html += `
          <div class="agent-card" data-agent-id="${esc(agent.id)}">
            <div class="agent-card-head">
              <div class="agent-avatar avatar-${esc(agent.executor)}" title="${esc(agent.executor)}">${esc(avatarLetter)}</div>
              <div class="agent-card-title-group">
                <div class="agent-card-name">${esc(agent.name)}</div>
                <div class="agent-card-pills">
                  <span class="role-pill">${esc(agent.roleTitle || ROLE_LABEL[agent.role] || agent.role)}</span>
                  <span class="badge model">${esc(levelBadgeText)}</span>
                  <span class="badge mcp">${agent.mcp.length}/4 MCP</span>
                </div>
              </div>
            </div>

            <div class="agent-card-backstory">
              <div class="backstory-preview ${isBackstoryExpanded ? 'expanded' : ''}" data-backstory="${esc(agent.id)}">
                ${esc(agent.backstory || agent.goal)}
              </div>
              ${
                agent.backstory.length > 80
                  ? `<button type="button" class="backstory-toggle" data-toggle-backstory="${esc(agent.id)}">${isBackstoryExpanded ? 'Свернуть' : 'Подробнее…'}</button>`
                  : ''
              }
            </div>

            <div class="agent-card-actions">
              <button type="button" class="card-btn primary" data-act="assign" data-agent-id="${esc(agent.id)}">Поручить задачу</button>
              <button type="button" class="card-btn" data-act="join-team" data-agent-id="${esc(agent.id)}">В команду</button>
              <button type="button" class="card-btn" data-act="edit" data-agent-id="${esc(agent.id)}">Изменить</button>
              <button type="button" class="card-btn" data-act="duplicate" data-agent-id="${esc(agent.id)}">Дублировать</button>
              <button type="button" class="card-btn" data-act="export" data-agent-id="${esc(agent.id)}">Экспорт</button>
            </div>
          </div>
        `;
      }
      html += `</div>`;
    } else {
      html += `
        <div class="empty note employees-empty">
          Сотрудников пока нет. Нажмите <strong>«＋ Создать сотрудника»</strong>, чтобы сконфигурировать агента с ролью, характером и внешностью.
        </div>
      `;
    }

    html += `</div>`; // end .employees-panel

    // 3. Active sessions in office
    sessions += `<h3>Активные сессии в офисе (${states.size})</h3>`;

    if (!states.size) {
      sessions += `<p class="empty">${
        this.online
          ? 'В офисе пусто. Запустите задачу или сессию в Claude Code, Codex или Antigravity — агент придёт через дверь.'
          : 'Нет связи с демоном. Запустите <code>npm run dev</code> в корне репозитория.'
      }</p>`;
    }

    const byProject = new Map<string, AgentState[]>();
    for (const a of states.values()) {
      const k = a.project || 'без проекта';
      byProject.set(k, [...(byProject.get(k) ?? []), a]);
    }

    for (const [project, list] of [...byProject].sort()) {
      sessions += `<h3>${esc(project)}</h3>`;
      for (const a of list.sort((p, q) => Number(!!p.parentId) - Number(!!q.parentId) || q.updatedAt - p.updatedAt)) {
        sessions += `
          <div class="agent ${a.id === selected ? 'sel' : ''} ${a.parentId ? 'sub' : ''} ${a.activity}" data-id="${esc(a.id)}" role="button" tabindex="0" aria-pressed="${a.id === selected}">
            <span class="dot ${esc(a.source)}"></span>
            <div class="info">
              <div class="title">${esc(a.title)}</div>
              <div class="meta">${ICON[a.activity]} ${LABEL[a.activity]} · ${esc(a.detail)}</div>
              <div class="meta dim">${a.taskId ? '📌 ' : ''}${SOURCE_NAME[a.source]} · ${esc(describeModel(a.source, a.model).label)}${a.effort ? ' · ' + esc(a.effort) : ''} · ${ago(a.updatedAt)} назад</div>
            </div>
          </div>
        `;
      }
    }

    // Selected agent journal
    let journal = '';
    if (selected && states.has(selected)) {
      const a = states.get(selected)!;
      const entries = logs.get(selected) ?? [];
      const journalHtml = `
        <div class="agent-journal">
          <div class="journal-head">
            <h3 class="journal-title">Журнал: ${esc(a.title)}</h3>
            <span class="badge model">${esc(describeModel(a.source, a.model).label)}</span>
          </div>
          ${
            a.taskId
              ? '<button type="button" data-conversation>Открыть разговор и ответить →</button>'
              : '<p class="note journal-note">Наблюдаемая сессия · ответы доступны в приложении агента</p>'
          }
          <div class="log">
            ${
              entries
                .map(
                  (e) => `
                    <div class="entry ${e.kind}">
                      <span>${new Date(e.at).toLocaleTimeString()} · ${e.kind === 'user' ? 'Вы' : e.kind === 'assistant' ? 'Агент' : 'Событие'}</span>
                      ${esc(e.text)}
                    </div>
                  `,
                )
                .join('') || '<p class="empty">Пока логов нет</p>'
            }
          </div>
        </div>
      `;
      journal = journalHtml;
    }

    // Preserve focus & scroll
    const focused = this.el.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).closest<HTMLElement>('[data-id], [data-agent-id]')?.dataset.id
      : undefined;

    // Each region is replaced only when its own markup changed: the session list ticks
    // («5 с назад») every few seconds, which must not recreate the roster's buttons under the cursor.
    const top = this.el.scrollTop;
    this.region('journal').hidden = !journal;
    this.patch(this.region('journal'), journal);
    this.patch(this.region('roster'), html);
    this.patch(this.region('sessions'), sessions);
    this.el.scrollTop = top;

    if (focused) {
      [...this.el.querySelectorAll<HTMLElement>('[data-id]')].find((r) => r.dataset.id === focused)?.focus({ preventScroll: true });
    }
  }

  private region(name: 'journal' | 'roster' | 'sessions'): HTMLElement {
    let el = this.el.querySelector<HTMLElement>(`:scope > [data-region="${name}"]`);
    if (!el) {
      if (!this.el.querySelector(':scope > [data-region]')) this.el.innerHTML = '';
      el = document.createElement('div');
      el.dataset.region = name;
      // Keep the order journal → roster → sessions whatever was created first.
      const order = ['journal', 'roster', 'sessions'];
      const after = [...this.el.querySelectorAll<HTMLElement>(':scope > [data-region]')].find((r) => order.indexOf(r.dataset.region!) > order.indexOf(name));
      this.el.insertBefore(el, after ?? null);
    }
    return el;
  }

  private painted = new WeakMap<HTMLElement, string>();
  private patch(el: HTMLElement, html: string): void {
    if (this.painted.get(el) === html) return;
    this.painted.set(el, html);
    el.innerHTML = html;
  }

  private bindEvents(): void {
    this.el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Create new agent button
      if (target.closest('[data-act="create-agent"]')) {
        if (this.send) {
          openAgentConstructor({ send: this.send });
        }
        return;
      }

      // Backstory toggle
      const toggleBtn = target.closest<HTMLButtonElement>('[data-toggle-backstory]');
      if (toggleBtn) {
        const id = toggleBtn.dataset.toggleBackstory!;
        if (this.expandedBackstories.has(id)) this.expandedBackstories.delete(id);
        else this.expandedBackstories.add(id);
        if (this.last) this.render(...this.last);
        return;
      }

      // Card action buttons
      const cardBtn = target.closest<HTMLButtonElement>('[data-act][data-agent-id]');
      if (cardBtn) {
        e.stopPropagation();
        const act = cardBtn.dataset.act!;
        const agentId = cardBtn.dataset.agentId!;
        const agent = store.agents.find((a) => a.id === agentId);
        if (!agent) return;

        if (act === 'assign') {
          this.onAssignTask?.(agent);
          return;
        }

        if (act === 'join-team') {
          this.onJoinTeam?.(agent);
          return;
        }

        if (act === 'edit') {
          if (this.send) openAgentConstructor({ profile: agent, send: this.send });
          return;
        }

        if (act === 'duplicate') {
          this.send?.({ type: 'agents.duplicate', id: agent.id });
          showToast(`Дублирован сотрудник "${agent.name}"`, 'ok');
          return;
        }

        if (act === 'export') {
          try {
            const blob = new Blob([JSON.stringify(agent, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `agent-${agent.name.toLowerCase().replace(/[^a-z0-9а-яё_-]/gi, '_')}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            showToast(`JSON агента "${agent.name}" скачан`, 'ok');
          } catch {
            showToast('Ошибка при экспорте', 'bad');
          }
          return;
        }
      }

      // Clicking an agent card centers 2.5D camera
      const card = target.closest<HTMLElement>('.agent-card[data-agent-id]');
      if (card) {
        const agentId = card.dataset.agentId!;
        this.onFocusAgent?.(agentId);
        return;
      }

      // Active office session click
      if (target.closest('[data-conversation]') && this.last?.[2]) {
        this.onConversation?.(this.last[2]);
        return;
      }

      const row = target.closest<HTMLElement>('[data-id]');
      if (row) {
        this.onPick(row.dataset.id!);
      }
    });

    this.head.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (b) this.show(b.dataset.tab as Tab);
    });
  }

  private renderHead(): void {
    const badge = this.running ? ` <b>${this.running}</b>` : '';
    const html = `
      <header>
        <div>
          <span class="sidebar-eyebrow">ВАША КОМАНДА</span>
          <h1>Офис и задачи</h1>
          <p>События рабочего пространства</p>
        </div>
        <div class="status ${this.online ? 'on' : 'off'}">${this.online ? `● ${this.count} в офисе` : 'нет связи'}</div>
      </header>
      <nav class="tabs" aria-label="Рабочая панель">
        <button type="button" data-tab="office" class="${this.tab === 'office' ? 'on' : ''}">Сотрудники</button>
        <button type="button" data-tab="tasks" class="${this.tab === 'tasks' ? 'on' : ''}">Разговоры${badge}</button>
        <button type="button" data-tab="team" class="${this.tab === 'team' ? 'on' : ''}">Переговорка${this.meeting ? ` <b>${this.meeting}</b>` : ''}</button>
        <button type="button" data-tab="dns" class="${this.tab === 'dns' ? 'on' : ''}">DNS</button>
        <button type="button" data-tab="settings" class="${this.tab === 'settings' ? 'on' : ''}">Настройки</button>
        <button type="button" data-tab="updates" class="${this.tab === 'updates' ? 'on' : ''}">Обновления</button>
      </nav>
    `;

    if (this.head.innerHTML !== html) this.head.innerHTML = html;
  }
}
