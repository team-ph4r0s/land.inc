import type { Access, BoardConfig, ClientMessage, Executor, Task } from '@land/protocol';

const STATUS: Record<Task['status'], string> = {
  starting: 'запускается',
  running: 'в работе',
  cancelling: 'отменяется',
  done: 'готово',
  failed: 'ошибка',
  cancelled: 'отменена',
};
const EXECUTOR: Record<Executor, string> = { claude: 'Claude', codex: 'Codex' };
// Claude has no file system sandbox here: only its permission mode, plus your own allow rules from Claude's settings.
const ACCESS_HINT: Record<Executor, Record<Access, string>> = {
  claude: {
    read: 'Режим plan: правки и команды этим режимом не разрешаются. Ваши правила allow из настроек Claude продолжают действовать. Песочницы файловой системы нет.',
    write: 'Режим acceptEdits: правки файлов принимаются без вопроса. Команды и всё, что требует подтверждения, отклоняются, если их не разрешают ваши правила allow. Песочницы файловой системы нет.',
  },
  codex: {
    read: 'Песочница read-only: читает и отвечает, ничего не меняет.',
    write: 'Песочница workspace-write: правит файлы только в папке проекта. Разрешения не запрашиваются, всё за пределами песочницы отклоняется.',
  },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const OTHER = '__other__';

/**
 * The task board panel: a form that sends a task to Claude or Codex in a chosen
 * project folder, and the list of tasks with their status. The form is built
 * once so typing is never interrupted by live updates; only the list re-renders.
 */
export class TaskBoardPanel {
  private el: HTMLElement;
  private send: (m: ClientMessage) => boolean;
  private onShowAgent: (id: string) => void;
  private config?: BoardConfig;
  private tasks: Task[] = [];
  private form!: HTMLFormElement;
  private list!: HTMLElement;
  private error!: HTMLElement;
  private known = new Set<string>();

  constructor(el: HTMLElement, send: (m: ClientMessage) => boolean, onShowAgent: (id: string) => void) {
    this.el = el;
    this.send = send;
    this.onShowAgent = onShowAgent;
    this.build();
  }

  /** Agents currently in the office, so a task can offer "show in the office". */
  setAgents(ids: Set<string>): void {
    this.known = ids;
    this.renderList();
  }

  setBoard(config: BoardConfig, tasks: Task[]): void {
    this.config = config;
    this.tasks = tasks;
    this.fillOptions();
    this.renderList();
  }

  upsert(task: Task): void {
    const i = this.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.tasks[i] = task;
    else this.tasks.unshift(task);
    this.renderList();
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }

  get running(): number {
    return this.tasks.filter((t) => t.status === 'starting' || t.status === 'running' || t.status === 'cancelling').length;
  }

  private build(): void {
    this.el.innerHTML = `
      <form class="task-form">
        <label>Проект
          <select name="project"></select>
        </label>
        <input name="customPath" placeholder="C:\\путь\\к\\проекту" hidden />
        <div class="field">Кому
          <div class="seg" data-name="executor">
            <button type="button" data-value="claude">Claude</button>
            <button type="button" data-value="codex">Codex</button>
          </div>
        </div>
        <p class="note" data-note="executor" hidden></p>
        <div class="row">
          <label>Модель <select name="model"></select></label>
          <label>Рассуждения <select name="effort"></select></label>
        </div>
        <div class="field">Доступ
          <div class="seg" data-name="access">
            <button type="button" data-value="read">Только чтение</button>
            <button type="button" data-value="write">Может править</button>
          </div>
        </div>
        <p class="note" data-note="access"></p>
        <p class="note warn" data-note="git" hidden></p>
        <label>Задача
          <textarea name="prompt" rows="5" placeholder="Что сделать? Например: найди, почему падает сборка, и предложи исправление"></textarea>
        </label>
        <p class="error" hidden></p>
        <button type="submit" class="primary">Отправить команде</button>
      </form>
      <h3>Задачи</h3>
      <div class="tasks"></div>`;
    this.form = this.el.querySelector('form')!;
    this.list = this.el.querySelector('.tasks')!;
    this.error = this.el.querySelector('.error')!;
    this.setSeg('executor', 'claude');
    this.setSeg('access', 'read');

    this.el.querySelectorAll<HTMLElement>('.seg').forEach((seg) =>
      seg.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]');
        if (!b || b.disabled) return;
        this.setSeg(seg.dataset.name!, b.dataset.value!);
        if (seg.dataset.name === 'executor') this.fillModels();
        this.updateNotes();
      }),
    );
    this.field<HTMLSelectElement>('project').addEventListener('change', () => {
      this.field<HTMLInputElement>('customPath').hidden = this.field<HTMLSelectElement>('project').value !== OTHER;
      this.updateNotes();
    });
    this.field<HTMLSelectElement>('model').addEventListener('change', () => this.fillEfforts());
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.list.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'cancel') this.send({ type: 'task.cancel', id: b.dataset.id! });
      if (b.dataset.act === 'show') this.onShowAgent(b.dataset.id!);
    });
  }

  private field<T extends HTMLElement>(name: string): T {
    return this.form.querySelector<T>(`[name="${name}"]`)!;
  }

  private seg(name: string): string {
    return this.form.querySelector<HTMLElement>(`.seg[data-name="${name}"] button.on`)?.dataset.value ?? '';
  }

  private setSeg(name: string, value: string): void {
    this.form.querySelectorAll<HTMLButtonElement>(`.seg[data-name="${name}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.value === value));
  }

  private fillOptions(): void {
    const c = this.config;
    if (!c) return;
    const project = this.field<HTMLSelectElement>('project');
    const current = project.value;
    project.innerHTML =
      c.projects.map((p) => `<option value="${esc(p)}" title="${esc(p)}">${esc(base(p))} — ${esc(p)}</option>`).join('') +
      `<option value="${OTHER}">Другая папка…</option>`;
    if (current && [...project.options].some((o) => o.value === current)) project.value = current;
    this.field<HTMLInputElement>('customPath').hidden = project.value !== OTHER;

    // Prefer an executor that can actually run.
    for (const ex of ['claude', 'codex'] as Executor[]) {
      const b = this.form.querySelector<HTMLButtonElement>(`.seg[data-name="executor"] button[data-value="${ex}"]`)!;
      b.disabled = !c.executors[ex].available;
      b.title = c.executors[ex].note ?? '';
    }
    const chosen = this.seg('executor') as Executor;
    if (!c.executors[chosen]?.available) {
      const other = (['claude', 'codex'] as Executor[]).find((e) => c.executors[e].available);
      if (other) this.setSeg('executor', other);
    }
    this.fillModels();
    this.updateNotes();
  }

  private fillModels(): void {
    const c = this.config;
    if (!c) return;
    const models = c.executors[this.seg('executor') as Executor]?.models ?? [];
    const select = this.field<HTMLSelectElement>('model');
    const current = select.value;
    select.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    if (models.some((m) => m.id === current)) select.value = current;
    else if (this.seg('executor') === 'claude') select.value = models.find((m) => m.id.includes('sonnet'))?.id ?? models[0]?.id ?? '';
    this.fillEfforts();
  }

  private fillEfforts(): void {
    const ex = this.seg('executor') as Executor;
    const model = this.config?.executors[ex]?.models.find((m) => m.id === this.field<HTMLSelectElement>('model').value);
    const select = this.field<HTMLSelectElement>('effort');
    const current = select.value;
    const def = model?.defaultEffort ? ` (${model.defaultEffort})` : '';
    select.innerHTML = `<option value="">по умолчанию${esc(def)}</option>` + (model?.efforts ?? []).map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
    // Board updates refill the lists; keep what the user picked if the model still offers it.
    if (current && model?.efforts?.includes(current)) select.value = current;
    select.disabled = !model?.efforts?.length;
  }

  private updateNotes(): void {
    const ex = this.seg('executor') as Executor;
    const note = this.form.querySelector<HTMLElement>('[data-note="executor"]')!;
    // Say why Claude is greyed out even while Codex is selected.
    const claude = this.config?.executors.claude;
    const text = this.config?.executors[ex]?.note ?? (claude && !claude.available && claude.note ? `Claude: ${claude.note}` : undefined);
    note.textContent = text ?? '';
    note.hidden = !text;
    this.form.querySelector<HTMLElement>('[data-note="access"]')!.textContent = ACCESS_HINT[ex]?.[this.seg('access') as Access] ?? '';
    const project = this.field<HTMLSelectElement>('project').value;
    // The board knows Git status only for listed folders; for a typed path it says so instead of guessing.
    const git = this.form.querySelector<HTMLElement>('[data-note="git"]')!;
    const writing = this.seg('access') === 'write';
    if (writing && project === OTHER) {
      git.textContent = 'Для этой папки не проверено, есть ли Git. Без Git изменения будет сложнее просмотреть и откатить; в карточке задачи появится отметка «вне Git».';
      git.hidden = false;
    } else if (writing && this.config?.outsideGit.includes(project)) {
      git.textContent = 'Папка не в Git-репозитории: изменения будет сложнее просмотреть и откатить.';
      git.hidden = false;
    } else git.hidden = true;
  }

  private submit(): void {
    this.error.hidden = true;
    const project = this.field<HTMLSelectElement>('project').value;
    const cwd = project === OTHER ? this.field<HTMLInputElement>('customPath').value.trim() : project;
    const prompt = this.field<HTMLTextAreaElement>('prompt').value.trim();
    if (!cwd) return this.showError('Выберите папку проекта');
    if (!prompt) return this.showError('Опишите задачу');
    const ok = this.send({
      type: 'task.create',
      task: {
        prompt,
        cwd,
        executor: this.seg('executor') as Executor,
        model: this.field<HTMLSelectElement>('model').value,
        effort: this.field<HTMLSelectElement>('effort').value || undefined,
        access: this.seg('access') as Access,
      },
    });
    if (!ok) return this.showError('Нет связи с демоном');
    this.field<HTMLTextAreaElement>('prompt').value = '';
  }

  private renderList(): void {
    const models = new Map<string, string>();
    for (const ex of Object.values(this.config?.executors ?? {})) for (const m of ex.models) models.set(m.id, m.label);
    if (!this.tasks.length) {
      this.list.innerHTML = '<p class="empty">Задач пока нет. Напишите первую — работник придёт в офис через дверь.</p>';
      return;
    }
    this.list.innerHTML = this.tasks
      .map((t) => {
        const live = t.status === 'starting' || t.status === 'running' || t.status === 'cancelling';
        const show = t.agentId && this.known.has(t.agentId);
        return `<div class="task ${t.status}">
          <div class="task-head">
            <span class="chip ${t.status}">${STATUS[t.status]}</span>
            <span class="who">${EXECUTOR[t.executor]} · ${esc(models.get(t.model) ?? t.model)}${t.effort ? ' · ' + esc(t.effort) : ''}</span>
          </div>
          <div class="task-prompt">${esc(t.prompt)}</div>
          <div class="meta dim">📁 ${esc(base(t.cwd))} · ${t.access === 'write' ? 'может править' : 'только чтение'}${t.outsideGit ? ' · вне Git' : ''} · ${new Date(t.createdAt).toLocaleTimeString()}</div>
          ${t.result ? `<details><summary>${t.status === 'failed' ? 'Ошибка' : 'Ответ'}</summary><div class="task-result">${esc(t.result)}</div></details>` : ''}
          <div class="task-actions">
            ${show ? `<button type="button" data-act="show" data-id="${esc(t.agentId!)}">Показать в офисе</button>` : ''}
            ${live ? `<button type="button" data-act="cancel" data-id="${esc(t.id)}">${t.status === 'cancelling' ? 'Отменить ещё раз' : 'Отменить'}</button>` : ''}
          </div>
        </div>`;
      })
      .join('');
  }
}
