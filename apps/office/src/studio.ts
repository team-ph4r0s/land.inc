import type { AgentPersona, ClientMessage, ServerMessage } from '@land/protocol';

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export class AgentStudioPanel {
  private readonly root: HTMLElement;
  private readonly send: (message: ClientMessage) => boolean;
  private agents: AgentPersona[] = [];

  constructor(root: HTMLElement, send: (message: ClientMessage) => boolean) {
    this.root = root;
    this.send = send;
    this.root.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const data = new FormData(form);
      this.send({ type: 'agent.create', requestId: crypto.randomUUID(), agent: {
        name: String(data.get('name') ?? '').trim(), provider: String(data.get('provider') ?? 'codex') as AgentPersona['provider'], model: String(data.get('model') ?? '').trim(),
        reasoningEffort: String(data.get('effort') ?? 'medium') as AgentPersona['reasoningEffort'], roleType: String(data.get('roleType') ?? 'custom') as AgentPersona['roleType'],
        characterAndSystemPrompt: String(data.get('prompt') ?? '').trim(), defaultAccessMode: String(data.get('access') ?? 'read-only') as AgentPersona['defaultAccessMode'],
        avatarConfig: { outfitColor: String(data.get('color') ?? '#4f7b68'), accessory: 'none' },
      } });
      form.reset();
    });
    this.root.addEventListener('click', (event) => {
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-delete]')?.dataset.delete;
      if (id) this.send({ type: 'agent.delete', id, requestId: crypto.randomUUID() });
    });
    this.render();
  }

  receive(message: ServerMessage): void {
    if (message.type === 'agents') this.agents = message.agents.map((agent) => structuredClone(agent));
    if (message.type === 'agent') {
      if (message.event.type === 'agent:deleted') {
        const deleted = message.event as Extract<NonNullable<typeof message.event>, { type: 'agent:deleted' }>;
        this.agents = this.agents.filter((agent) => agent.id !== deleted.id);
      }
      else {
        const agent = message.event.agent;
        this.agents = this.agents.some((item) => item.id === agent.id) ? this.agents.map((item) => item.id === agent.id ? agent : item) : [...this.agents, agent];
      }
    }
    this.render();
  }

  private render(): void {
    const current = this.root.querySelector<HTMLFormElement>('form');
    const draft = current ? Object.fromEntries(new FormData(current).entries()) : undefined;
    this.root.innerHTML = `<section class="studio-panel"><div class="studio-head"><div><span class="sidebar-eyebrow">AGENT STUDIO</span><h2>Кастомные сотрудники</h2><p class="note">Профиль автоматически получает обязательный стек MCP.</p></div><span class="chip done">${this.agents.length} профилей</span></div><div class="studio-agents">${this.agents.map((agent) => `<article class="studio-agent"><strong>${esc(agent.name)}</strong><span>${esc(agent.provider)} · ${esc(agent.model)} · ${esc(agent.roleType)}</span><small>${esc(agent.characterAndSystemPrompt.slice(0, 140))}</small><button type="button" data-delete="${esc(agent.id)}">Удалить</button></article>`).join('')}</div><form class="studio-form"><h3>+ Создать агента</h3><div class="row"><label>Имя<input name="name" required maxlength="120" placeholder="Редактор-Критик"></label><label>Провайдер<select name="provider"><option value="claude">Claude</option><option value="codex" selected>Codex</option><option value="antigravity">Antigravity</option></select></label></div><div class="row"><label>Модель<input name="model" required placeholder="gpt-6.1-sol"></label><label>Роль<select name="roleType"><option value="custom">Своя</option><option value="writer">Писатель</option><option value="coder">Разработчик</option><option value="reviewer">Ревьюер</option><option value="editor">Редактор</option><option value="planner">Планировщик</option><option value="security">Безопасник</option></select></label></div><div class="row"><label>Рассуждения<select name="effort"><option>low</option><option selected>medium</option><option>high</option><option>xhigh</option></select></label><label>Доступ<select name="access"><option value="read-only">Только чтение</option><option value="workspace-write">Рабочая папка</option></select></label></div><label>Характер и системный промпт<textarea name="prompt" required rows="3" placeholder="Правила, тональность и запреты агента"></textarea></label><label>Цвет одежды<input type="color" name="color" value="#4f7b68"></label><button type="submit">Создать агента</button></form></section>`;
    if (draft) for (const [name, value] of Object.entries(draft)) {
      const field = this.root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`);
      if (field && typeof value === 'string') field.value = value;
    }
  }
}
