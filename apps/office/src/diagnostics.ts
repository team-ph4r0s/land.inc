import type { ClientMessage, DaemonDiagnostics, ServerMessage } from '@land/protocol';

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export class DiagnosticsPanel {
  private readonly root: HTMLElement;
  private readonly send: (message: ClientMessage) => boolean;
  private diagnostics?: DaemonDiagnostics;
  private online = false;

  constructor(root: HTMLElement, send: (message: ClientMessage) => boolean) {
    this.root = root;
    this.send = send;
    root.addEventListener('click', (event) => { if ((event.target as HTMLElement).closest('[data-refresh-diagnostics]')) this.send({ type: 'diagnostics.read' }); });
    this.render();
  }

  setOnline(online: boolean): void { this.online = online; this.render(); }
  receive(message: ServerMessage): void { if (message.type === 'diagnostics') { this.diagnostics = message.diagnostics; this.render(); } }

  private render(): void {
    const d = this.diagnostics;
    this.root.innerHTML = `<section class="diagnostics-panel"><h2>Здоровье системы</h2><p class="note">${this.online ? 'Демон подключён' : 'Нет связи с демоном'}</p><div class="diagnostics-metrics"><div><b>${d ? `${d.uptimeSeconds} с` : '—'}</b><span>работает</span></div><div><b>${d ? `${Math.round(d.rssBytes / 1024 / 1024)} MB` : '—'}</b><span>RAM</span></div><div><b>${d?.activeProcesses ?? '—'}</b><span>CLI-процессы</span></div></div><h3>CLI</h3><ul>${d ? Object.entries(d.executors).map(([name, info]) => `<li><b>${esc(name)}</b> · ${info.available ? 'доступен' : 'недоступен'} · ${esc(info.note ?? '')}</li>`).join('') : '<li>Нажмите «Обновить»</li>'}</ul><h3>MCP</h3><ul>${d ? d.mcp.map((item) => `<li><b>${esc(item.name)}</b> · ${esc(item.status)}${item.version ? ` · ${esc(item.version)}` : ''}</li>`).join('') : '<li>Нажмите «Обновить»</li>'}</ul><button type="button" data-refresh-diagnostics>Обновить диагностику</button></section>`;
  }
}
