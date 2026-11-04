import type { Access, BoardConfig, ClientMessage, Executor, Task } from '@land/protocol';

const STATUS: Record<Task['status'], string> = {
  starting: 'запускается',
  running: 'в работе',
  cancelling: 'отменяется',
  done: 'готово',
  failed: 'ошибка',
  cancelled: 'отменена',
};
const EXECUTOR: Record<Executor, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
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
  antigravity: {
    read: 'Режим plan: настройки и разрешения Antigravity продолжают действовать; отдельная песочница файлов не гарантируется.',
    write: 'Режим accept-edits: правки могут выполняться без подтверждения; остальные действия зависят от настроек Antigravity.',
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
  private pending?: { id: string; prompt: string };
  private folderRequest?: string;
  private folderPath?: string;
  private folderParent?: string;
  /**
   * The reply form under a finished task. The list re-renders on every update, so what
   * the user typed lives here and is put back each time.
   */
  private reply?: { taskId: string; draft: string; access: Access; error?: string; pending?: string };

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

  submissionResult(id: string, error?: string): void {
    if (this.reply?.pending === id) {
      // Accepted: the reply is a new task at the top of the list. Refused: keep the text and say why.
      this.reply = error ? { ...this.reply, pending: undefined, error } : undefined;
      return this.renderList();
    }
    if (this.pending?.id !== id) return;
    const prompt = this.field<HTMLTextAreaElement>('prompt');
    if (!error && prompt.value.trim() === this.pending.prompt) prompt.value = '';
    this.pending = undefined;
    this.form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = false;
    if (error) this.showError(error);
  }

  disconnected(): void {
    const lost = 'Связь прервалась до подтверждения. Проверьте список задач перед повторной отправкой.';
    if (this.reply?.pending) this.submissionResult(this.reply.pending, lost);
    if (this.pending) this.submissionResult(this.pending.id, lost);
    if (this.folderRequest) { this.folderRequest = undefined; this.folderMessage('Нет связи с демоном'); }
  }

  foldersResult(result: { requestId: string; path?: string; parent?: string; folders?: string[]; error?: string }): void {
    if (result.requestId !== this.folderRequest) return;
    this.folderRequest = undefined;
    if (result.error || !result.path) return this.folderMessage(result.error ?? 'Не удалось открыть папку');
    this.folderPath = result.path;
    this.folderParent = result.parent;
    this.form.querySelector<HTMLElement>('[data-folder-path]')!.textContent = result.path;
    this.form.querySelector<HTMLButtonElement>('[data-folder-up]')!.disabled = !result.parent;
    this.form.querySelector<HTMLButtonElement>('[data-folder-select]')!.disabled = false;
    const list = this.form.querySelector<HTMLElement>('[data-folder-list]')!;
    list.innerHTML = result.folders?.length ? result.folders.map((path) => `<button type="button" data-folder="${esc(path)}">📁 ${esc(base(path))}</button>`).join('') : '<p class="note">Нет вложенных папок</p>';
  }

  private folderMessage(message: string): void {
    this.form.querySelector<HTMLElement>('[data-folder-list]')!.textContent = message;
  }

  private browse(path?: string): void {
    this.folderPath = undefined;
    this.folderParent = undefined;
    this.form.querySelector<HTMLButtonElement>('[data-folder-select]')!.disabled = true;
    this.form.querySelector<HTMLButtonElement>('[data-folder-up]')!.disabled = true;
    const requestId = crypto.randomUUID();
    if (!this.send({ type: 'folders.list', requestId, path })) return this.folderMessage('Нет связи с демоном');
    this.folderRequest = requestId;
    this.folderMessage('Загрузка…');
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
        <button type="button" data-folder-open>Обзор папок…</button>
        <div class="folder-browser" hidden>
          <div class="folder-browser-head"><button type="button" data-folder-up>↑ На уровень выше</button><button type="button" data-folder-close>Закрыть</button></div>
          <p class="note" data-folder-path></p>
          <div class="folder-list" data-folder-list></div>
          <button type="button" data-folder-select disabled>Выбрать эту папку</button>
        </div>
        <div class="field"><span data-executor-label>Кому</span>
          <div class="seg" data-name="executor">
            <button type="button" data-value="claude">Claude</button>
            <button type="button" data-value="codex">Codex</button>
            <button type="button" data-value="antigravity">Antigravity</button>
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
        <label class="team-choice"><input type="checkbox" name="team" /> Совместная работа</label>
        <div data-team-options hidden>
          <p class="note">Основной исполнитель и его модель выбираются выше: он выполняет большую часть работы по плану и пишет код, если разрешены правки. Здесь назначьте планирование и проверку.</p>
          <div class="row">
          <label>План и назначение <select name="plannerExecutor"><option value="claude">Claude</option><option value="codex">Codex</option><option value="antigravity" selected>Antigravity</option></select></label>
          <label>Модель <select name="plannerModel"></select></label>
          <label>Рассуждения <select name="plannerEffort"></select></label>
          </div>
          <div class="row">
          <label>Проверка <select name="colleagueExecutor"><option value="claude">Claude</option><option value="codex" selected>Codex</option><option value="antigravity">Antigravity</option></select></label>
          <label><span data-colleague-label>Модель коллеги</span> <select name="colleagueModel"></select></label>
          <label>Рассуждения <select name="colleagueEffort"></select></label>
          </div>
          <p class="note">Четыре последовательных хода: планирование и назначение выбранного исполнителя, выполнение, проверка, итог исполнителя. Планирование и проверка работают с доступом только на чтение; возможности режима зависят от агента и его настроек.</p>
        </div>
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
        if (seg.dataset.name === 'executor') { this.fillModels(); this.fillColleagueModels(); this.fillPlannerModels(); }
        this.updateNotes();
      }),
    );
    this.field<HTMLSelectElement>('project').addEventListener('change', () => {
      this.field<HTMLInputElement>('customPath').hidden = this.field<HTMLSelectElement>('project').value !== OTHER;
      this.updateNotes();
    });
    this.form.querySelector('[data-folder-open]')!.addEventListener('click', () => {
      this.form.querySelector<HTMLElement>('.folder-browser')!.hidden = false;
      const selected = this.field<HTMLSelectElement>('project').value;
      this.browse(selected === OTHER ? this.field<HTMLInputElement>('customPath').value.trim() || undefined : selected || undefined);
    });
    this.form.querySelector('[data-folder-close]')!.addEventListener('click', () => { this.form.querySelector<HTMLElement>('.folder-browser')!.hidden = true; this.folderRequest = undefined; });
    this.form.querySelector('[data-folder-up]')!.addEventListener('click', () => { if (this.folderParent) this.browse(this.folderParent); });
    this.form.querySelector('[data-folder-list]')!.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-folder]');
      if (button?.dataset.folder) this.browse(button.dataset.folder);
    });
    this.form.querySelector('[data-folder-select]')!.addEventListener('click', () => {
      if (!this.folderPath) return;
      this.field<HTMLSelectElement>('project').value = OTHER;
      const input = this.field<HTMLInputElement>('customPath');
      input.value = this.folderPath;
      input.hidden = false;
      this.form.querySelector<HTMLElement>('.folder-browser')!.hidden = true;
      this.updateNotes();
    });
    this.field<HTMLSelectElement>('model').addEventListener('change', () => this.fillEfforts());
    this.field<HTMLInputElement>('team').addEventListener('change', () => {
      const team = this.field<HTMLInputElement>('team').checked;
      this.form.querySelector<HTMLElement>('[data-team-options]')!.hidden = !team;
      this.form.querySelector<HTMLElement>('[data-executor-label]')!.textContent = team ? 'Основной исполнитель' : 'Кому';
    });
    this.field<HTMLSelectElement>('colleagueModel').addEventListener('change', () => this.fillColleagueEfforts());
    this.field<HTMLSelectElement>('colleagueExecutor').addEventListener('change', () => this.fillColleagueModels());
    this.field<HTMLSelectElement>('plannerExecutor').addEventListener('change', () => this.fillPlannerModels());
    this.field<HTMLSelectElement>('plannerModel').addEventListener('change', () => this.fillPlannerEfforts());
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.list.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'cancel') this.send({ type: 'task.cancel', id: b.dataset.id! });
      if (b.dataset.act === 'show') this.onShowAgent(b.dataset.id!);
      if (b.dataset.act === 'reply') {
        const task = this.tasks.find((t) => t.id === b.dataset.id);
        this.reply = this.reply?.taskId === b.dataset.id ? undefined : { taskId: b.dataset.id!, draft: '', access: task?.access ?? 'read' };
        this.renderList();
        this.list.querySelector<HTMLTextAreaElement>('.reply textarea')?.focus();
      }
      if (b.dataset.act === 'reply-access' && this.reply) {
        this.reply.access = b.dataset.value as Access;
        this.renderList();
      }
      if (b.dataset.act === 'reply-send') this.sendReply();
    });
    this.list.addEventListener('input', (e) => {
      const area = e.target as HTMLTextAreaElement;
      if (this.reply && area.matches('.reply textarea')) this.reply.draft = area.value;
    });
    this.list.addEventListener('keydown', (e) => {
      // Ctrl+Enter sends the reply, like in a chat.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.target as HTMLElement).matches('.reply textarea')) this.sendReply();
    });
  }

  private sendReply(): void {
    const r = this.reply;
    if (!r || r.pending) return;
    const prompt = r.draft.trim();
    if (!prompt) {
      r.error = 'Напишите, что ответить агенту';
      return this.renderList();
    }
    const requestId = crypto.randomUUID();
    if (!this.send({ type: 'task.reply', taskId: r.taskId, prompt, access: r.access, requestId })) {
      r.error = 'Нет связи с демоном';
      return this.renderList();
    }
    r.pending = requestId;
    r.error = undefined;
    this.renderList();
  }

  /** The reply form: continues the agent's session, so it remembers the task. */
  private replyForm(t: Task): string {
    const r = this.reply!;
    const seg = (value: Access, label: string) =>
      `<button type="button" data-act="reply-access" data-value="${value}" class="${r.access === value ? 'on' : ''}">${label}</button>`;
    return `<div class="reply">
      <textarea rows="3" placeholder="Ответ агенту: он продолжит разговор и помнит задачу. Ctrl+Enter — отправить" ${r.pending ? 'disabled' : ''}>${esc(r.draft)}</textarea>
      <div class="seg">${seg('read', 'Только чтение')}${seg('write', 'Может править')}</div>
      ${r.error ? `<p class="error">${esc(r.error)}</p>` : ''}
      <div class="task-actions"><button type="button" data-act="reply-send" ${r.pending ? 'disabled' : ''}>${r.pending ? 'Отправляется…' : `Отправить ${EXECUTOR[t.executor]}`}</button></div>
    </div>`;
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
    for (const ex of ['claude', 'codex', 'antigravity'] as Executor[]) {
      const b = this.form.querySelector<HTMLButtonElement>(`.seg[data-name="executor"] button[data-value="${ex}"]`)!;
      b.disabled = !c.executors[ex].available;
      b.title = c.executors[ex].note ?? '';
    }
    const chosen = this.seg('executor') as Executor;
    if (!c.executors[chosen]?.available) {
      const other = (['claude', 'codex', 'antigravity'] as Executor[]).find((e) => c.executors[e].available);
      if (other) this.setSeg('executor', other);
    }
    this.fillModels();
    this.fillColleagueModels();
    this.fillPlannerModels();
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

  private fillColleagueModels(): void {
    const executor = this.field<HTMLSelectElement>('colleagueExecutor');
    for (const option of executor.options) option.disabled = !this.config?.executors[option.value as Executor]?.available;
    if (executor.selectedOptions[0]?.disabled) executor.value = [...executor.options].find((o) => !o.disabled)?.value ?? executor.value;
    const ex = this.field<HTMLSelectElement>('colleagueExecutor').value as Executor;
    for (const option of this.field<HTMLSelectElement>('colleagueExecutor').options) {
      option.disabled = !this.config?.executors[option.value as Executor]?.available;
    }
    this.form.querySelector<HTMLElement>('[data-colleague-label]')!.textContent = `Модель ${EXECUTOR[ex]}`;
    const models = this.config?.executors[ex]?.models ?? [];
    const select = this.field<HTMLSelectElement>('colleagueModel');
    const current = select.value;
    select.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    if (models.some((m) => m.id === current)) select.value = current;
    else if (ex === 'claude') select.value = models.find((m) => m.id.includes('sonnet'))?.id ?? models[0]?.id ?? '';
    this.fillColleagueEfforts();
  }

  private fillPlannerModels(): void {
    const executor = this.field<HTMLSelectElement>('plannerExecutor');
    for (const option of executor.options) option.disabled = !this.config?.executors[option.value as Executor]?.available;
    if (executor.selectedOptions[0]?.disabled) executor.value = [...executor.options].find((o) => !o.disabled)?.value ?? executor.value;
    const models = this.config?.executors[executor.value as Executor]?.models ?? [];
    const select = this.field<HTMLSelectElement>('plannerModel');
    const current = select.value;
    select.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    if (models.some((m) => m.id === current)) select.value = current;
    this.fillPlannerEfforts();
  }

  private fillPlannerEfforts(): void {
    const ex = this.field<HTMLSelectElement>('plannerExecutor').value as Executor;
    const model = this.config?.executors[ex]?.models.find((m) => m.id === this.field<HTMLSelectElement>('plannerModel').value);
    const select = this.field<HTMLSelectElement>('plannerEffort');
    const current = select.value;
    select.innerHTML = `<option value="">по умолчанию${model?.defaultEffort ? ` (${esc(model.defaultEffort)})` : ''}</option>` + (model?.efforts ?? []).map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
    if (current && model?.efforts?.includes(current)) select.value = current;
    select.disabled = !model?.efforts?.length;
  }

  private fillColleagueEfforts(): void {
    const ex = this.field<HTMLSelectElement>('colleagueExecutor').value as Executor;
    const model = this.config?.executors[ex]?.models.find((m) => m.id === this.field<HTMLSelectElement>('colleagueModel').value);
    const select = this.field<HTMLSelectElement>('colleagueEffort');
    const current = select.value;
    const def = model?.defaultEffort ? ` (${model.defaultEffort})` : '';
    select.innerHTML = `<option value="">по умолчанию${esc(def)}</option>` + (model?.efforts ?? []).map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
    if (current && model?.efforts?.includes(current)) select.value = current;
    select.disabled = !model?.efforts?.length;
  }

  private updateNotes(): void {
    const ex = this.seg('executor') as Executor;
    const note = this.form.querySelector<HTMLElement>('[data-note="executor"]')!;
    // Say why Claude is greyed out even while Codex is selected.
    const claude = this.config?.executors.claude;
    const agy = this.config?.executors.antigravity;
    const text = this.config?.executors[ex]?.note ?? (agy && !agy.available && agy.note ? `Antigravity: ${agy.note}` : claude && !claude.available && claude.note ? `Claude: ${claude.note}` : undefined);
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
    if (this.pending) return;
    const requestId = crypto.randomUUID();
    const team = this.field<HTMLInputElement>('team').checked;
    const ok = this.send({
      type: team ? 'team.create' : 'task.create',
      ...(team ? { colleague: [{ executor: this.field<HTMLSelectElement>('colleagueExecutor').value as Executor, model: this.field<HTMLSelectElement>('colleagueModel').value, effort: this.field<HTMLSelectElement>('colleagueEffort').value || undefined }] } : {}),
      ...(team ? { planner: { executor: this.field<HTMLSelectElement>('plannerExecutor').value as Executor, model: this.field<HTMLSelectElement>('plannerModel').value, effort: this.field<HTMLSelectElement>('plannerEffort').value || undefined } } : {}),
      requestId,
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
    this.pending = { id: requestId, prompt };
    this.form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = true;
  }

  private renderList(): void {
    // Re-rendering replaces the reply box: keep its focus and caret.
    const area = this.list.querySelector<HTMLTextAreaElement>('.reply textarea');
    const focus = area && document.activeElement === area ? { start: area.selectionStart, end: area.selectionEnd } : undefined;
    this.renderTasks();
    const next = this.list.querySelector<HTMLTextAreaElement>('.reply textarea');
    if (focus && next) {
      next.focus();
      next.setSelectionRange(focus.start, focus.end);
    }
  }

  private renderTasks(): void {
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
          <div class="meta dim">${t.continues ? '↪ ответ в той же сессии · ' : ''}📁 ${esc(base(t.cwd))} · ${t.access === 'write' ? 'может править' : 'только чтение'}${t.outsideGit ? ' · вне Git' : ''} · ${new Date(t.createdAt).toLocaleTimeString()}</div>
          ${t.result ? `<details><summary>${t.status === 'failed' ? 'Ошибка' : 'Ответ'}</summary><div class="task-result">${esc(t.result)}</div></details>` : ''}
          <div class="task-actions">
            ${show ? `<button type="button" data-act="show" data-id="${esc(t.agentId!)}">Показать в офисе</button>` : ''}
            ${live ? `<button type="button" data-act="cancel" data-id="${esc(t.id)}">${t.status === 'cancelling' ? 'Отменить ещё раз' : 'Отменить'}</button>` : ''}
            ${!live && t.agentId ? `<button type="button" data-act="reply" data-id="${esc(t.id)}" aria-expanded="${this.reply?.taskId === t.id}">${this.reply?.taskId === t.id ? 'Скрыть ответ' : 'Ответить'}</button>` : ''}
          </div>
          ${this.reply?.taskId === t.id && !live ? this.replyForm(t) : ''}
        </div>`;
      })
      .join('');
  }
}
