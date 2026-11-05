import type { Access, BoardConfig, ClientMessage, Executor, McpStatus, ModelOption, Task } from '@land/protocol';
import { conversations, isLive, messageHtml } from './conversations';

const STATUS: Record<Task['status'], string> = {
  starting: 'запускается',
  running: 'в работе',
  cancelling: 'отменяется',
  done: 'готово',
  failed: 'ошибка',
  cancelled: 'отменена',
};
const EXECUTOR: Record<Executor, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
const EXECUTORS = Object.keys(EXECUTOR) as Executor[];
const SETUP: Record<Executor, { url: string; install: string; login: string }> = {
  claude: { url: 'https://code.claude.com/docs/en/setup', install: 'Windows PowerShell: irm https://claude.ai/install.ps1 | iex\nmacOS / Linux: curl -fsSL https://claude.ai/install.sh | bash', login: 'claude auth login' },
  codex: { url: 'https://developers.openai.com/codex/cli', install: 'npm install -g @openai/codex', login: 'codex login' },
  antigravity: { url: 'https://antigravity.google/docs/getting-started?tab=cli', install: 'Windows PowerShell: irm https://antigravity.google/cli/install.ps1 | iex\nmacOS / Linux: curl -fsSL https://antigravity.google/cli/install.sh | bash', login: 'agy' },
};
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
  private initialized = false;
  private selected?: string;
  private composing = false;
  private browsing = true;
  private search = '';
  private drafts = new Map<string, NonNullable<TaskBoardPanel['reply']>>();
  private scrolls = new Map<string, number>();
  private messagesKey = '';
  private composerKey = '';
  private mcpStatuses: McpStatus[] = [];
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
  openForAgent(id: string): void {
    this.selected = conversations(this.tasks).find((c) => c.turns.some((t) => t.agentId === id))?.id;
    this.reply = undefined;
    this.composing = false;
    this.browsing = false;
    this.renderList();
  }

  setAgents(ids: Set<string>): void {
    this.known = ids;
    this.renderList();
  }

  setBoard(config: BoardConfig, tasks: Task[]): void {
    this.config = config;
    this.tasks = tasks;
    this.fillOptions();
    const refresh = this.form.querySelector<HTMLButtonElement>('[data-refresh]')!;
    refresh.disabled = false;
    refresh.textContent = 'Проверить доступность';
    this.renderList();
  }

  setMcpStatuses(statuses: McpStatus[]): void {
    this.mcpStatuses = statuses.map((status) => ({ ...status }));
    this.renderMcpBanner();
  }

  upsert(task: Task): void {
    const i = this.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.tasks[i] = task;
    else this.tasks.unshift(task);
    if (this.pending && task.prompt === this.pending.prompt) {
      this.selected = conversations(this.tasks).find((c) => c.turns.some((t) => t.id === task.id))?.id;
      this.composing = false;
      this.browsing = false;
    }
    this.renderList();
  }

  streamChunk(taskId: string, chunk: string): void {
    const index = this.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return;
    const task = this.tasks[index];
    const result = `${task.result ?? ''}${chunk}`.slice(-200_000);
    this.tasks = this.tasks.map((item, itemIndex) => itemIndex === index ? { ...item, result } : item);
    this.renderList();
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
    const refresh = this.form.querySelector<HTMLButtonElement>('[data-refresh]')!;
    refresh.disabled = false;
    refresh.textContent = 'Проверить доступность';
  }

  submissionResult(id: string, error?: string): void {
    const saved = [...this.drafts].find(([, r]) => r.pending === id);
    if (this.reply?.pending === id || saved) {
      // Accepted: the reply is a new task at the top of the list. Refused: keep the text and say why.
      if (saved) {
        if (error) this.drafts.set(saved[0], { ...saved[1], pending: undefined, error });
        else this.drafts.delete(saved[0]);
      }
      if (this.reply?.pending === id) this.reply = error ? { ...this.reply, pending: undefined, error } : undefined;
      return this.renderList();
    }
    if (this.pending?.id !== id) return;
    const prompt = this.field<HTMLTextAreaElement>('prompt');
    if (!error && prompt.value.trim() === this.pending.prompt) prompt.value = '';
    this.pending = undefined;
    this.updateTeam();
    if (error) this.showError(error);
    else {
      // Team prompts include coordinator context and need not equal the form text.
      if (this.composing) { this.composing = false; this.browsing = true; }
      this.renderList();
    }
  }

  disconnected(): void {
    const lost = 'Связь прервалась до подтверждения. Проверьте список задач перед повторной отправкой.';
    if (this.reply?.pending) this.submissionResult(this.reply.pending, lost);
    for (const r of [...this.drafts.values()]) if (r.pending) this.submissionResult(r.pending, lost);
    if (this.pending) this.submissionResult(this.pending.id, lost);
    if (this.folderRequest) { this.folderRequest = undefined; this.folderMessage('Нет связи с демоном'); }
    const refresh = this.form.querySelector<HTMLButtonElement>('[data-refresh]')!;
    refresh.disabled = false;
    refresh.textContent = 'Проверить доступность';
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
      <div class="mcp-banner" data-mcp-banner hidden></div>
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
        <details class="cli-setup">
          <summary>Агенты: доступность и установка</summary>
          <div data-cli-status></div>
          <p class="note">После установки или входа нажмите «Проверить доступность». Если менялся PATH, перезапустите офис из нового терминала.</p>
          <button type="button" data-refresh>Проверить доступность</button>
        </details>
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
          <p class="note">Основной исполнитель выбран выше. Включите нужные этапы и агентов. Устанавливать все CLI не требуется.</p>
          <label class="team-choice"><input type="checkbox" name="usePlanner" /> Планирование</label>
          <div class="row" data-planner-options hidden>
          <label>Планировщик <select name="plannerExecutor">${EXECUTORS.map((ex) => `<option value="${ex}">${EXECUTOR[ex]}</option>`).join('')}</select></label>
          <label>Модель <select name="plannerModel"></select></label>
          <label>Рассуждения <select name="plannerEffort"></select></label>
          </div>
          <p class="note">Проверяющие (по порядку). Можно выбрать того же провайдера, что и у исполнителя: это будет отдельная сессия.</p>
          ${EXECUTORS.map((ex) => `<div class="team-member" data-reviewer="${ex}">
            <label class="team-choice"><input type="checkbox" name="review-${ex}" /> ${EXECUTOR[ex]} <span data-review-status></span></label>
            <div class="row" data-review-options hidden>
              <label>Модель <select name="reviewModel-${ex}"></select></label>
              <label>Рассуждения <select name="reviewEffort-${ex}"></select></label>
            </div>
          </div>`).join('')}
          <p class="note" data-team-summary></p>
          <p class="note">Планирование и проверка работают только на чтение с ограничениями выбранного CLI. Каждый этап — отдельный запрос к модели с её лимитами.</p>
        </div>
        <p class="note warn" data-team-issue role="status" hidden></p>
        <p class="error" hidden></p>
        <button type="submit" class="primary">Отправить задачу</button>
      </form>
      <div class="tasks"></div>`;
    this.form = this.el.querySelector('form')!;
    this.list = this.el.querySelector('.tasks')!;
    this.error = this.el.querySelector('.error')!;
    this.el.querySelector<HTMLElement>('[data-mcp-banner]')!.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mcp-install]');
      if (!button) return;
      const selected = button.dataset.mcpInstall;
      const missing = selected ? [selected as McpStatus['name']] : this.mcpStatuses.filter((status) => status.status !== 'installed').map((status) => status.name);
      if (missing.length) this.send({ type: 'mcp.install', request: { servers: missing } });
    });
    this.form.insertAdjacentHTML('beforebegin', '<div class="board-toolbar"><button type="button" data-browse>☰ Разговоры</button><button type="button" data-new>＋ Новая задача</button></div><input class="conversation-search" type="search" placeholder="Найти разговор…" aria-label="Поиск разговоров" />');
    this.list.innerHTML = '<div class="conversation-list" aria-label="Разговоры"></div><section class="conversation"><div class="conversation-head"></div><div class="messages" tabindex="0" aria-label="История разговора"></div><div class="composer"></div></section>';
    this.renderMcpBanner();
    this.el.querySelector('[data-new]')!.addEventListener('click', () => {
      this.composing = !this.composing;
      this.renderList();
      if (this.composing) this.field<HTMLTextAreaElement>('prompt').focus();
    });
    this.el.querySelector('[data-browse]')!.addEventListener('click', () => { this.browsing = !this.browsing; this.composing = false; this.renderList(); });
    this.el.querySelector<HTMLInputElement>('.conversation-search')!.addEventListener('input', (e) => { this.search = (e.target as HTMLInputElement).value.toLocaleLowerCase(); this.renderList(); });
    this.setSeg('executor', 'claude');
    this.setSeg('access', 'read');

    this.el.querySelectorAll<HTMLElement>('.seg').forEach((seg) =>
      seg.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]');
        if (!b || b.disabled) return;
        this.setSeg(seg.dataset.name!, b.dataset.value!);
        if (seg.dataset.name === 'executor') {
          this.field<HTMLSelectElement>('model').value = '';
          this.field<HTMLSelectElement>('effort').value = '';
          this.fillModels();
        }
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
      this.updateTeam();
    });
    this.field<HTMLInputElement>('usePlanner').addEventListener('change', () => this.updateTeam());
    this.field<HTMLSelectElement>('plannerExecutor').addEventListener('change', () => {
      this.field<HTMLSelectElement>('plannerModel').value = '';
      this.field<HTMLSelectElement>('plannerEffort').value = '';
      this.fillPlannerModels();
    });
    this.field<HTMLSelectElement>('plannerModel').addEventListener('change', () => this.fillPlannerEfforts());
    for (const ex of EXECUTORS) {
      this.field<HTMLInputElement>(`review-${ex}`).addEventListener('change', () => this.updateTeam());
      this.field<HTMLSelectElement>(`reviewModel-${ex}`).addEventListener('change', () => this.fillReviewEfforts(ex));
    }
    this.form.querySelector<HTMLButtonElement>('[data-refresh]')!.addEventListener('click', () => {
      if (!this.send({ type: 'board.refresh' })) return this.showError('Нет связи с демоном');
      const button = this.form.querySelector<HTMLButtonElement>('[data-refresh]')!;
      button.disabled = true;
      button.textContent = 'Проверяем CLI…';
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.list.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'thread') {
        const messages = this.list.querySelector<HTMLElement>('.messages')!;
        if (this.selected && this.messagesKey) {
          this.scrolls.set(this.selected, messages.scrollTop);
          if (this.reply) this.drafts.set(this.selected, this.reply);
        }
        this.selected = b.dataset.id;
        this.reply = this.drafts.get(this.selected!);
        this.composing = false;
        this.browsing = false;
        this.messagesKey = '';
        this.composerKey = '';
        this.renderList();
        return;
      }
      if (b.dataset.act === 'copy') {
        const task = this.tasks.find((t) => t.id === b.dataset.id);
        if (task?.result) void navigator.clipboard.writeText(task.result).then(() => { b.textContent = 'Скопировано'; }, () => { b.textContent = 'Выделите текст для копирования'; });
      }
      if (b.dataset.act === 'download') {
        const task = this.tasks.find((t) => t.id === b.dataset.id);
        if (task?.result) {
          const url = URL.createObjectURL(new Blob([task.result], { type: 'text/markdown;charset=utf-8' }));
          const link = document.createElement('a'); link.href = url; link.download = `${base(task.cwd)}-${task.id}.md`; link.click(); URL.revokeObjectURL(url);
        }
      }
      if (b.dataset.act === 'save') {
        const path = window.prompt('Относительный путь внутри проекта', 'artifacts/result.md')?.trim();
        if (path) this.send({ type: 'artifact.save', taskId: b.dataset.id!, path, format: 'md', requestId: crypto.randomUUID() });
      }
      if (b.dataset.act === 'cancel') this.send({ type: 'task.cancel', id: b.dataset.id! });
      if (b.dataset.act === 'bottom') {
        const messages = this.list.querySelector<HTMLElement>('.messages')!;
        messages.scrollTop = messages.scrollHeight;
      }
      if (b.dataset.act === 'show') this.onShowAgent(b.dataset.id!);
      if (b.dataset.act === 'reply') {
        if (this.reply?.pending) return;
        const task = this.tasks.find((t) => t.id === b.dataset.id);
        this.reply = { taskId: b.dataset.id!, draft: this.reply?.draft ?? '', access: this.reply?.access ?? task?.access ?? 'read' };
        this.composerKey = '';
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
      if (this.reply && area.matches('.reply textarea')) {
        this.reply.draft = area.value;
        if (this.selected) this.drafts.set(this.selected, this.reply);
      }
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
    if (this.selected) this.drafts.set(this.selected, r);
    this.renderList();
  }

  /** The reply form: continues the agent's session, so it remembers the task. */
  private replyForm(t: Task): string {
    const r = this.reply!;
    const seg = (value: Access, label: string) =>
      `<button type="button" data-act="reply-access" data-value="${value}" ${r.pending ? 'disabled' : ''} class="${r.access === value ? 'on' : ''}">${label}</button>`;
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

    // Pick an installed default only once. Later availability changes must not replace the user's choice.
    for (const ex of EXECUTORS) {
      const b = this.form.querySelector<HTMLButtonElement>(`.seg[data-name="executor"] button[data-value="${ex}"]`)!;
      b.disabled = false;
      b.title = c.executors[ex].note ?? '';
    }
    if (!this.initialized) {
      const other = EXECUTORS.find((e) => c.executors[e].available && c.executors[e].models.length);
      if (other) {
        this.setSeg('executor', other);
        this.field<HTMLSelectElement>('plannerExecutor').value = other;
      }
      this.initialized = true;
    }
    this.fillModels();
    this.fillReviewModels();
    this.fillPlannerModels();
    this.renderSetup();
    this.updateNotes();
  }

  private fillModels(): void {
    const c = this.config;
    if (!c) return;
    const models = c.executors[this.seg('executor') as Executor]?.models ?? [];
    const select = this.field<HTMLSelectElement>('model');
    this.fillModelSelect(select, models);
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
    this.updateTeam();
  }

  private fillReviewModels(): void {
    for (const ex of EXECUTORS) {
      const models = this.config?.executors[ex]?.models ?? [];
      const select = this.field<HTMLSelectElement>(`reviewModel-${ex}`);
      this.fillModelSelect(select, models);
      this.form.querySelector<HTMLElement>(`[data-reviewer="${ex}"] [data-review-status]`)!.textContent = this.config?.executors[ex]?.available && models.length ? 'доступен' : 'недоступен';
      this.fillReviewEfforts(ex);
    }
  }

  private fillPlannerModels(): void {
    const executor = this.field<HTMLSelectElement>('plannerExecutor');
    for (const option of executor.options) {
      const ex = option.value as Executor;
      option.textContent = `${EXECUTOR[ex]}${this.config?.executors[ex]?.available ? '' : ' — недоступен'}`;
    }
    const models = this.config?.executors[executor.value as Executor]?.models ?? [];
    const select = this.field<HTMLSelectElement>('plannerModel');
    this.fillModelSelect(select, models);
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
    this.updateTeam();
  }

  private fillReviewEfforts(ex: Executor): void {
    const model = this.config?.executors[ex]?.models.find((m) => m.id === this.field<HTMLSelectElement>(`reviewModel-${ex}`).value);
    const select = this.field<HTMLSelectElement>(`reviewEffort-${ex}`);
    const current = select.value;
    const def = model?.defaultEffort ? ` (${model.defaultEffort})` : '';
    select.innerHTML = `<option value="">по умолчанию${esc(def)}</option>` + (model?.efforts ?? []).map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
    if (current && model?.efforts?.includes(current)) select.value = current;
    select.disabled = !model?.efforts?.length;
    this.updateTeam();
  }

  private fillModelSelect(select: HTMLSelectElement, models: ModelOption[]): void {
    const current = select.value;
    select.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    if (current && !models.some((m) => m.id === current)) select.insertAdjacentHTML('afterbegin', `<option value="${esc(current)}">${esc(current)} — недоступна</option>`);
    if (current) select.value = current;
    select.disabled = !models.length;
  }

  private renderSetup(): void {
    const container = this.form.querySelector<HTMLElement>('[data-cli-status]')!;
    // Preserve expanded instructions while refreshed statuses arrive.
    const open = new Set([...container.querySelectorAll<HTMLDetailsElement>('details[open]')].map((el) => el.dataset.setup));
    container.innerHTML = EXECUTORS.map((ex) => {
      const status = this.config?.executors[ex];
      const ready = status?.available && status.models.length;
      const setup = SETUP[ex];
      return `<details data-setup="${ex}" ${open.has(ex) ? 'open' : ''}>
        <summary>${EXECUTOR[ex]} — ${ready ? 'доступен' : 'недоступен'} · инструкция</summary>
        ${status?.note ? `<p class="note">${esc(status.note)}</p>` : ''}
        <p>1. Установите CLI в терминале:</p><pre>${esc(setup.install)}</pre>
        <p>2. Откройте новый терминал и выполните вход:</p><pre>${esc(setup.login)}</pre>
        <p>3. Проверьте <code>${ex === 'antigravity' ? 'agy' : ex} --version</code> и обновите доступность.</p>
        <a href="${setup.url}" target="_blank" rel="noopener noreferrer">Официальная инструкция ${EXECUTOR[ex]}</a>
        ${ex === 'antigravity' ? '<p class="note">Нужен отдельный agy CLI. Интеграция экспериментальная; установка редактора сама по себе не гарантирует доступность CLI.</p>' : ''}
      </details>`;
    }).join('');
  }

  private selectedTeam(): { planner?: { executor: Executor; model: string; effort?: string }; colleague: { executor: Executor; model: string; effort?: string }[] } {
    const participant = (executor: Executor, model: string, effort: string) => ({ executor, model, effort: effort || undefined });
    if (!this.field<HTMLInputElement>('team').checked) return { colleague: [] };
    return {
      ...(this.field<HTMLInputElement>('usePlanner').checked ? { planner: participant(this.field<HTMLSelectElement>('plannerExecutor').value as Executor, this.field<HTMLSelectElement>('plannerModel').value, this.field<HTMLSelectElement>('plannerEffort').value) } : {}),
      colleague: EXECUTORS.filter((ex) => this.field<HTMLInputElement>(`review-${ex}`).checked).map((ex) => participant(ex, this.field<HTMLSelectElement>(`reviewModel-${ex}`).value, this.field<HTMLSelectElement>(`reviewEffort-${ex}`).value)),
    };
  }

  private selectionIssue(): string | undefined {
    if (!this.config) return 'Проверяем доступность агентов…';
    const team = this.selectedTeam();
    const selected = [{ executor: this.seg('executor') as Executor, model: this.field<HTMLSelectElement>('model').value }, ...(team.planner ? [team.planner] : []), ...team.colleague];
    const blocked = selected.filter((p) => !this.config?.executors[p.executor]?.available || !this.config.executors[p.executor].models.some((m) => m.id === p.model));
    if (!blocked.length) return undefined;
    return [...new Set(blocked.map((p) => `${EXECUTOR[p.executor]}: ${this.config?.executors[p.executor]?.note ?? 'нет доступной модели'}`))].join('\n') + '\nВыберите доступного исполнителя, отключите недоступный этап или настройте CLI: «Агенты: доступность и установка».';
  }

  private updateTeam(): void {
    const team = this.selectedTeam();
    this.form.querySelector<HTMLElement>('[data-planner-options]')!.hidden = !this.field<HTMLInputElement>('usePlanner').checked;
    for (const ex of EXECUTORS) this.form.querySelector<HTMLElement>(`[data-reviewer="${ex}"] [data-review-options]`)!.hidden = !this.field<HTMLInputElement>(`review-${ex}`).checked;
    const stages = [...(team.planner ? [`План: ${EXECUTOR[team.planner.executor]}`] : []), `Выполнение: ${EXECUTOR[this.seg('executor') as Executor]}`, ...team.colleague.map((p) => `Проверка: ${EXECUTOR[p.executor]}`), ...(team.planner || team.colleague.length ? ['Итог исполнителя'] : [])];
    const collaborative = !!(team.planner || team.colleague.length);
    this.form.querySelector<HTMLElement>('[data-team-summary]')!.textContent = collaborative ? stages.join(' → ') : 'Дополнительные этапы отключены — будет отправлена обычная задача.';
    const issue = this.selectionIssue();
    const note = this.form.querySelector<HTMLElement>('[data-team-issue]')!;
    note.textContent = issue ?? '';
    note.hidden = !issue;
    const submit = this.form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.disabled = !!this.pending || !!issue;
    submit.textContent = this.pending ? 'Отправляется…' : collaborative ? 'Отправить команде' : 'Отправить задачу';
  }

  private updateNotes(): void {
    const ex = this.seg('executor') as Executor;
    const note = this.form.querySelector<HTMLElement>('[data-note="executor"]')!;
    const text = this.config?.executors[ex]?.note;
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
    this.updateTeam();
  }

  private submit(): void {
    this.error.hidden = true;
    const project = this.field<HTMLSelectElement>('project').value;
    const cwd = project === OTHER ? this.field<HTMLInputElement>('customPath').value.trim() : project;
    const prompt = this.field<HTMLTextAreaElement>('prompt').value.trim();
    if (!cwd) return this.showError('Выберите папку проекта');
    if (!prompt) return this.showError('Опишите задачу');
    const issue = this.selectionIssue();
    if (issue) return this.showError(issue);
    if (this.pending) return;
    const requestId = crypto.randomUUID();
    const selection = this.selectedTeam();
    const team = !!(selection.planner || selection.colleague.length);
    const ok = this.send({
      type: team ? 'team.create' : 'task.create',
      ...(team ? selection : {}),
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
    this.updateTeam();
  }

  private renderList(): void {
    const groups = conversations(this.tasks);
    if (!this.selected || !groups.some((c) => c.id === this.selected)) this.selected = groups[0]?.id;
    this.form.hidden = !this.composing && !!groups.length;
    this.list.hidden = this.composing;
    const nav = this.list.querySelector<HTMLElement>('.conversation-list')!;
    nav.hidden = !this.browsing;
    this.el.querySelector<HTMLInputElement>('.conversation-search')!.hidden = !this.browsing || this.composing;
    const navHtml = groups.filter((c) => !this.search || c.turns.some((t) => `${t.prompt} ${t.cwd} ${t.executor}`.toLocaleLowerCase().includes(this.search))).map((c) => {
      const first = c.turns[0], last = c.turns.at(-1)!;
      const status = c.turns.find(isLive) ?? last;
      return `<button type="button" data-act="thread" data-id="${esc(c.id)}" class="thread-row ${this.selected === c.id ? 'selected' : ''}" aria-pressed="${this.selected === c.id}"><span class="thread-title">${esc(first.prompt)}</span><span class="thread-meta">${EXECUTOR[last.executor]} · ${esc(base(first.cwd))} · ${c.turns.length} ход.</span><span class="chip ${status.status}">${STATUS[status.status]}</span></button>`;
    }).join('') || '<p class="empty">Разговоры не найдены</p>';
    if (nav.innerHTML !== navHtml) nav.innerHTML = navHtml;
    const conversation = this.list.querySelector<HTMLElement>('.conversation')!;
    const group = groups.find((c) => c.id === this.selected);
    conversation.hidden = !group || this.browsing;
    if (!group || this.browsing) return;
    const last = group.turns.at(-1)!;
    const active = group.turns.find(isLive);
    const head = this.list.querySelector<HTMLElement>('.conversation-head')!;
    const headHtml = `<span>${EXECUTOR[last.executor]} · ${esc(base(last.cwd))} · ${STATUS[(active ?? last).status]}</span><button type="button" data-act="bottom">↓ К последним</button>`;
    if (head.innerHTML !== headHtml) head.innerHTML = headHtml;
    const messages = this.list.querySelector<HTMLElement>('.messages')!;
    const html = group.turns.map((t) => `<article class="conversation-turn" data-turn="${esc(t.id)}">
      <div class="message user"><div class="message-label">Вы · ${new Date(t.createdAt).toLocaleString()}${t.continues ? ' · продолжение' : ''}</div><div class="message-body">${messageHtml(t.prompt)}</div></div>
      <div class="message assistant"><div class="message-label">${EXECUTOR[t.executor]} · ${esc(t.model)} · ${STATUS[t.status]}</div><div class="message-body">${t.result ? messageHtml(t.result) : isLive(t) ? 'Агент работает…' : 'Ответ отсутствует'}</div>
      <div class="task-actions">${t.result ? `<button type="button" data-act="copy" data-id="${esc(t.id)}">Копировать</button><button type="button" data-act="download" data-id="${esc(t.id)}">Скачать .md</button><button type="button" data-act="save" data-id="${esc(t.id)}">Сохранить в проект…</button>` : ''}${t.agentId && this.known.has(t.agentId) ? `<button type="button" data-act="show" data-id="${esc(t.agentId)}">В офисе</button>` : ''}${isLive(t) ? `<button type="button" data-act="cancel" data-id="${esc(t.id)}">Отменить</button>` : t.agentId && !active && !t.orphans ? `<button type="button" data-act="reply" data-id="${esc(t.id)}">Ответить на этот ход</button>` : ''}</div></div></article>`).join('');
    const key = group.id + html;
    if (key !== this.messagesKey) {
      const same = this.messagesKey.startsWith(group.id + '<');
      const bottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
      const top = messages.scrollTop;
      const missing = group.turns.some((t) => t.continues && !this.tasks.some((p) => p.id === t.continues));
      messages.innerHTML = (missing ? '<p class="note">Ранние сообщения этого разговора больше не хранятся в истории.</p>' : '') + html;
      messages.scrollTop = same ? (bottom ? messages.scrollHeight : top) : (this.scrolls.get(group.id) ?? messages.scrollHeight);
      this.messagesKey = key;
    }
    const composer = this.list.querySelector<HTMLElement>('.composer')!;
    if (!this.reply || !group.turns.some((t) => t.id === this.reply!.taskId)) {
      this.reply = this.drafts.get(group.id) ?? { taskId: last.id, draft: '', access: last.access };
    }
    const target = group.turns.find((t) => t.id === this.reply?.taskId) ?? last;
    const canReply = !active && !!target.agentId && !target.orphans;
    const composerKey = JSON.stringify([group.id, target.id, canReply, this.reply.access, this.reply.pending, this.reply.error]);
    if (composerKey !== this.composerKey) {
      const area = composer.querySelector<HTMLTextAreaElement>('textarea');
      const focus = area && document.activeElement === area ? [area.selectionStart, area.selectionEnd] : undefined;
      composer.innerHTML = canReply ? `<div class="reply-context">Ответ ${EXECUTOR[target.executor]}${target.id !== last.id ? ' на выбранный ход' : ''} · Ctrl+Enter</div>${this.replyForm(target)}` : `<p class="note">${active ? 'Ответить можно после завершения текущего хода.' : target.orphans ? 'Отмена не подтверждена: продолжение пока недоступно.' : 'У этой задачи нет сессии для продолжения.'}</p>`;
      const next = composer.querySelector<HTMLTextAreaElement>('textarea');
      if (focus && next) { next.focus({ preventScroll: true }); next.setSelectionRange(focus[0], focus[1]); }
      this.composerKey = composerKey;
    }
  }

  private renderMcpBanner(): void {
    const banner = this.el.querySelector<HTMLElement>('[data-mcp-banner]');
    if (!banner) return;
    const missing = this.mcpStatuses.filter((status) => status.status !== 'installed');
    banner.hidden = missing.length === 0;
    if (!missing.length) return;
    banner.innerHTML = `<strong>⚠️ Не установлены обязательные MCP (${missing.length} из 4)</strong><span>${missing.map((status) => `${esc(status.name)}: ${esc(status.status)} <button type="button" data-mcp-install="${esc(status.name)}">Установить</button>`).join(' · ')}</span><button type="button" data-mcp-install>Установить все недостающие MCP</button>`;
  }
}
