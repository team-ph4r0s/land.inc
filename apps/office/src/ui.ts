import { describeModel, type Activity, type AgentState, type LogEntry } from '@land/protocol';
import { ICON, SOURCE_COLOR } from './agent';

const LABEL: Record<Activity, string> = {
  think: 'думает', write: 'пишет код', read: 'в архиве', bash: 'в серверной', web: 'в интернете',
  plan: 'у доски', talk: 'на встрече', wait: 'ждёт вас', idle: 'на кухне',
};
const SOURCE_NAME: Record<AgentState['source'], string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', demo: 'Демо' };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} с` : s < 3600 ? `${Math.round(s / 60)} мин` : `${Math.round(s / 3600)} ч`;
};

export type Tab = 'office' | 'tasks' | 'team' | 'dns' | 'updates';

/** Sidebar with three tabs: the agent roster (with the selected agent's log), the task board and «Переговорка». */
export class Sidebar {
  private pending = false;
  private online = false;
  private count = 0;
  private running = 0;
  private meeting = 0;
  private tab: Tab = 'office';
  private head: HTMLElement;
  private el: HTMLElement;
  /** Host element for the task board panel. */
  readonly tasksPane: HTMLElement;
  /** Host element for «Переговорка». */
  readonly teamPane: HTMLElement;
  readonly dnsPane: HTMLElement;
  readonly updatesPane: HTMLElement;
  private onPick: (id: string) => void;
  private last?: [Map<string, AgentState>, Map<string, LogEntry[]>, string | undefined];

  constructor(root: HTMLElement, onPick: (id: string) => void) {
    root.innerHTML = '<div class="head"></div><div class="pane office"></div><div class="pane tasks" hidden></div><div class="pane team" hidden></div><div class="pane dns" hidden></div><div class="pane updates" hidden></div>';
    this.head = root.querySelector('.head')!;
    this.el = root.querySelector('.pane.office')!;
    this.tasksPane = root.querySelector('.pane.tasks')!;
    this.teamPane = root.querySelector('.pane.team')!;
    this.dnsPane = root.querySelector('.pane.dns')!;
    this.updatesPane = root.querySelector('.pane.updates')!;
    this.onPick = onPick;
    this.el.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
      if (row) this.onPick(row.dataset.id!);
    });
    // Rows are buttons for the keyboard too.
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
      if (!row) return;
      e.preventDefault();
      this.onPick(row.dataset.id!);
    });
    this.head.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (b) this.show(b.dataset.tab as Tab);
    });
    this.renderHead();
    setInterval(() => this.last && this.render(...this.last), 5000);
  }

  show(tab: Tab): void {
    this.tab = tab;
    this.el.hidden = tab !== 'office';
    this.tasksPane.hidden = tab !== 'tasks';
    this.teamPane.hidden = tab !== 'team';
    this.dnsPane.hidden = tab !== 'dns';
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
    const byProject = new Map<string, AgentState[]>();
    for (const a of states.values()) {
      const k = a.project || 'без проекта';
      byProject.set(k, [...(byProject.get(k) ?? []), a]);
    }
    this.count = states.size;
    this.renderHead();
    let html = '';
    if (!states.size) {
      html += `<p class="empty">${this.online
        ? 'В офисе пусто. Запустите сессию в Claude Code, Codex или Antigravity — агент придёт через дверь.'
        : 'Нет связи с демоном. Запустите <code>npm run dev</code> в корне репозитория.'}</p>`;
    }
    for (const [project, list] of [...byProject].sort()) {
      html += `<h3>${esc(project)}</h3>`;
      for (const a of list.sort((p, q) => Number(!!p.parentId) - Number(!!q.parentId) || q.updatedAt - p.updatedAt)) {
        html += `<div class="agent ${a.id === selected ? 'sel' : ''} ${a.parentId ? 'sub' : ''} ${a.activity}" data-id="${esc(a.id)}" role="button" tabindex="0" aria-pressed="${a.id === selected}">
          <span class="dot" style="background:${hex(SOURCE_COLOR[a.source])}"></span>
          <div class="info">
            <div class="title">${esc(a.title)}</div>
            <div class="meta">${ICON[a.activity]} ${LABEL[a.activity]} · ${esc(a.detail)}</div>
            <div class="meta dim">${a.taskId ? '📌 ' : ''}${SOURCE_NAME[a.source]} · ${esc(describeModel(a.source, a.model).label)}${a.effort ? ' · ' + esc(a.effort) : ''} · ${ago(a.updatedAt)} назад</div>
          </div>
        </div>`;
      }
    }
    if (selected && states.has(selected)) {
      const entries = (logs.get(selected) ?? []).slice(-15).reverse();
      html += `<h3>Журнал</h3><div class="log">${entries
        .map((e) => `<div class="entry ${e.kind}"><span>${new Date(e.at).toLocaleTimeString()}</span>${esc(e.text)}</div>`)
        .join('') || '<p class="empty">Пока пусто</p>'}</div>`;
    }
    // The roster re-renders every few seconds; keep keyboard focus on the same agent.
    const focused = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id : undefined;
    this.el.innerHTML = html;
    if (focused) [...this.el.querySelectorAll<HTMLElement>('[data-id]')].find((r) => r.dataset.id === focused)?.focus();
  }

  private renderHead(): void {
    const badge = this.running ? ` <b>${this.running}</b>` : '';
    this.head.innerHTML = `<header><div><span class="sidebar-eyebrow">ВАША КОМАНДА</span><h1>Офис и задачи</h1><p>События рабочего пространства</p></div>
      <div class="status ${this.online ? 'on' : 'off'}">${this.online ? `● ${this.count} в офисе` : 'нет связи'}</div></header>
      <nav class="tabs">
        <button type="button" data-tab="office" class="${this.tab === 'office' ? 'on' : ''}">Сотрудники</button>
        <button type="button" data-tab="tasks" class="${this.tab === 'tasks' ? 'on' : ''}">Задачи${badge}</button>
        <button type="button" data-tab="team" class="${this.tab === 'team' ? 'on' : ''}">Переговорка${this.meeting ? ` <b>${this.meeting}</b>` : ''}</button>
        <button type="button" data-tab="dns" class="${this.tab === 'dns' ? 'on' : ''}">DNS</button>
      </nav>`;
  }
}
