import type { Activity, AgentState, LogEntry } from '@land/protocol';
import { ICON, SOURCE_COLOR } from './agent';

const LABEL: Record<Activity, string> = {
  think: 'думает', write: 'пишет код', read: 'в архиве', bash: 'в серверной', web: 'в интернете',
  plan: 'у доски', talk: 'на встрече', wait: 'ждёт вас', idle: 'на кухне',
};
const SOURCE_NAME: Record<AgentState['source'], string> = { claude: 'Claude', codex: 'Codex', demo: 'Демо' };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} с` : s < 3600 ? `${Math.round(s / 60)} мин` : `${Math.round(s / 3600)} ч`;
};

/** Agent roster grouped by project, plus the activity log of the selected agent. */
export class Sidebar {
  private pending = false;
  private online = false;
  private el: HTMLElement;
  private onPick: (id: string) => void;
  private last?: [Map<string, AgentState>, Map<string, LogEntry[]>, string | undefined];

  constructor(el: HTMLElement, onPick: (id: string) => void) {
    this.el = el;
    this.onPick = onPick;
    el.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
      if (row) this.onPick(row.dataset.id!);
    });
    setInterval(() => this.last && this.render(...this.last), 5000);
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (this.last) this.render(...this.last);
    else this.el.innerHTML = this.header(0);
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
    let html = this.header(states.size);
    if (!states.size) {
      html += `<p class="empty">${this.online
        ? 'В офисе пусто. Запустите сессию в Claude Code или Codex — агент придёт через дверь.'
        : 'Нет связи с демоном. Запустите <code>npm run dev</code> в корне репозитория.'}</p>`;
    }
    for (const [project, list] of [...byProject].sort()) {
      html += `<h3>${esc(project)}</h3>`;
      for (const a of list.sort((p, q) => Number(!!p.parentId) - Number(!!q.parentId) || q.updatedAt - p.updatedAt)) {
        html += `<div class="agent ${a.id === selected ? 'sel' : ''} ${a.parentId ? 'sub' : ''} ${a.activity}" data-id="${esc(a.id)}">
          <span class="dot" style="background:${hex(SOURCE_COLOR[a.source])}"></span>
          <div class="info">
            <div class="title">${esc(a.title)}</div>
            <div class="meta">${ICON[a.activity]} ${LABEL[a.activity]} · ${esc(a.detail)}</div>
            <div class="meta dim">${SOURCE_NAME[a.source]}${a.model ? ' · ' + esc(a.model) : ''} · ${ago(a.updatedAt)} назад</div>
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
    this.el.innerHTML = html;
  }

  private header(count: number): string {
    return `<header><h1>land<span>.inc</span></h1>
      <div class="status ${this.online ? 'on' : 'off'}">${this.online ? `в офисе: ${count}` : 'нет связи'}</div></header>`;
  }
}
