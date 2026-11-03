import type { ClientMessage, Collaboration, CollabTurn, ModelOption } from '@land/protocol';

const STATUS: Record<Collaboration['status'], string> = {
  running: 'идёт работа',
  stopping: 'останавливается',
  done: 'готово',
  failed: 'ошибка',
  stopped: 'остановлена',
};
const CHIP: Record<Collaboration['status'], string> = { running: 'running', stopping: 'cancelling', done: 'done', failed: 'failed', stopped: 'cancelled' };
const TURN: Record<CollabTurn['status'], string> = {
  waiting: 'ожидает',
  running: 'работает',
  done: 'завершил',
  failed: 'ошибка',
  cancelled: 'отменён',
  skipped: 'пропущен',
};
const ROLE: Record<CollabTurn['role'], string> = { author: 'Автор', reviewer: 'Рецензент', finisher: 'Итог' };
const EXECUTOR = { claude: 'Claude', codex: 'Codex' } as const;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * «Переговорка»: one card per collaboration. It shows the turns in order with who
 * works, their state and what each passed on, then the result or why it stopped.
 * Waiting for the next participant never looks like that participant working.
 */
export class MeetingPanel {
  private el: HTMLElement;
  private send: (m: ClientMessage) => boolean;
  private onShowAgent: (id: string) => void;
  private collabs: Collaboration[] = [];
  private agents = new Set<string>();
  private models = new Map<string, string>();
  /** Cards and turn messages the user opened stay open across updates. */
  private open = new Set<string>();

  constructor(el: HTMLElement, send: (m: ClientMessage) => boolean, onShowAgent: (id: string) => void) {
    this.el = el;
    this.send = send;
    this.onShowAgent = onShowAgent;
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'stop') this.send({ type: 'team.cancel', id: b.dataset.id! });
      if (b.dataset.act === 'show') this.onShowAgent(b.dataset.id!);
    });
    el.addEventListener('toggle', (e) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.dataset.key) return;
      if (d.open) this.open.add(d.dataset.key);
      else this.open.delete(d.dataset.key);
    }, true);
    this.render();
  }

  get running(): number {
    return this.collabs.filter((c) => c.status === 'running' || c.status === 'stopping').length;
  }

  /** Agents now in the office, for the "show in the office" links. */
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

  private render(): void {
    if (!this.collabs.length) {
      this.el.innerHTML = `<h3>Переговорка</h3><p class="empty">Здесь появится совместная работа. Отметьте «Совместная работа» в форме задачи — автор сделает задачу, коллега проверит её только на чтение, автор подведёт итог.</p>`;
      return;
    }
    this.el.innerHTML = `<h3>Переговорка</h3><div class="tasks">${this.collabs.map((c) => this.card(c)).join('')}</div>`;
  }

  private card(c: Collaboration): string {
    const live = c.status === 'running' || c.status === 'stopping';
    const current = c.turns.findIndex((t) => t.status === 'running');
    const waitingNext = live && current < 0; // between turns: nobody works yet
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

  /** While stopping the button waits, unless the stop failed: then it offers to try again. */
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
        <span class="turn-state">${TURN[t.status]}${t.role === 'reviewer' ? ' · только чтение' : ''}</span>
      </div>
      ${t.handoff ? `<details data-key="${key}" ${this.open.has(key) ? 'open' : ''}><summary>Передал дальше</summary><div class="task-result">${esc(t.handoff)}</div></details>` : ''}
      ${show ? `<button type="button" class="link" data-act="show" data-id="${esc(t.agentId!)}">Показать в офисе</button>` : ''}
    </li>`;
  }
}
