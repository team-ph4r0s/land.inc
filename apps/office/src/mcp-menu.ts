import {
  type ClientMessage,
  type McpId,
  type McpStatus,
} from '@land/protocol';
import { store } from './store';
import { esc, showToast } from './ui-kit';

const MCP_NAMES: Record<McpId, { name: string; desc: string }> = {
  markitdown: { name: 'MarkItDown', desc: 'Конвертация файлов в Markdown' },
  'context-budget': { name: 'Context Budget', desc: 'Визуализация и лимиты контекста' },
  'strategic-compact': { name: 'Strategic Compact', desc: 'Сжатие цепочек рассуждений' },
  'agentic-shield': { name: 'Agentic Shield', desc: 'Защита от опасных команд' },
};

export class McpMenuComponent {
  private wrap: HTMLElement;
  private menu: HTMLElement;
  private btn: HTMLButtonElement;
  private isOpen = false;
  private send: (m: ClientMessage) => boolean;

  constructor(targetHeader: HTMLElement, send: (m: ClientMessage) => boolean) {
    this.send = send;

    this.wrap = document.createElement('div');
    this.wrap.className = 'mcp-dropdown-wrap';

    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'mcp-menu-btn';
    this.btn.setAttribute('aria-label', 'Меню MCP инструментов');
    this.btn.innerHTML = `<span class="mcp-dot active"></span><span>MCP</span>`;

    this.menu = document.createElement('div');
    this.menu.className = 'mcp-dropdown-menu';
    this.menu.hidden = true;

    this.wrap.appendChild(this.btn);
    this.wrap.appendChild(this.menu);
    targetHeader.appendChild(this.wrap);

    this.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    document.addEventListener('click', (e) => {
      if (!this.wrap.contains(e.target as Node) && this.isOpen) {
        this.close();
      }
    });

    this.render();
    store.on('mcp', () => this.render());
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.isOpen = true;
    this.menu.hidden = false;
    this.render();
  }

  close(): void {
    this.isOpen = false;
    this.menu.hidden = true;
  }

  private render(): void {
    const list: McpStatus[] = store.mcp;
    const hasInstalling = list.some((m) => m.state === 'installing');
    const hasFailed = list.some((m) => m.state === 'failed');
    const hasMissing = list.some((m) => m.state === 'missing');

    const topDotCls = hasInstalling
      ? 'installing'
      : hasFailed
      ? 'failed'
      : hasMissing
      ? 'missing'
      : 'active';

    this.btn.innerHTML = `<span class="mcp-dot ${topDotCls}"></span><span>MCP (${list.filter((m) => m.state === 'active').length}/${list.length})</span>`;

    let html = `<div class="note mcp-dropdown-title">Стек MCP инструментов</div>`;

    for (const item of list) {
      const meta = MCP_NAMES[item.id] ?? { name: item.id, desc: '' };
      const canInstall = item.state === 'missing' || item.state === 'failed';
      const isInstalling = item.state === 'installing';

      html += `
        <div class="mcp-item" data-id="${esc(item.id)}">
          <div class="mcp-item-info">
            <span class="mcp-dot ${item.state}"></span>
            <div>
              <strong>${esc(meta.name)}</strong>${item.version ? `<small class="badge default mcp-version-badge">v${esc(item.version)}</small>` : ''}
              <div class="note">${esc(meta.desc)}</div>
            </div>
          </div>
          <div>
            ${
              canInstall
                ? `<button type="button" class="btn small" data-install="${esc(item.id)}">Установить</button>`
                : isInstalling
                ? `<span class="badge running">Установка…</span>`
                : `<span class="badge mcp">Активен</span>`
            }
          </div>
        </div>
      `;
    }

    this.menu.innerHTML = html;

    this.menu.querySelectorAll<HTMLButtonElement>('[data-install]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = b.dataset.install as McpId;
        if (!id) return;

        // optimistic update
        const item = store.mcp.find((m) => m.id === id);
        if (item) item.state = 'installing';
        store.emit('mcp');

        this.send({ type: 'mcp.install', id });
        showToast(`Установка ${MCP_NAMES[id]?.name ?? id}…`, 'info');
      });
    });
  }
}

/** Formatter for character numbers */
export function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/**
 * Renders an HTML string for context budget gauge meter.
 */
export function renderContextBudgetGauge(usedChars: number, maxChars = 400_000): string {
  const safeMax = Math.max(1, maxChars);
  const rawPct = Math.min(100, Math.round((usedChars / safeMax) * 100));
  const roundedPct = Math.min(100, Math.max(0, Math.round(rawPct / 5) * 5));
  const isOverflow = usedChars > safeMax;

  return `
    <div class="context-meter" role="progressbar" aria-valuenow="${rawPct}" aria-valuemin="0" aria-valuemax="100">
      <div class="context-meter-head">
        <span>Контекст</span>
        <strong>${formatChars(usedChars)} / ${formatChars(safeMax)} симв. (${rawPct}%)</strong>
      </div>
      <div class="context-bar">
        <div class="context-bar-fill ${isOverflow ? 'overflow' : ''}" data-pct="${roundedPct}"></div>
      </div>
    </div>
  `;
}
