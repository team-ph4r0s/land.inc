import {
  describeModel,
  type ClientMessage,
  type Executor,
  type ModelCatalog,
} from '@land/protocol';
import { store } from './store';

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

export const base = (p: string): string =>
  p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Capability badges in model lists: <option> holds text only, so they read as words. */
const BADGE_LABEL: Record<string, string> = { reasoning: 'рассуждения', fast: 'быстрая', alias: 'алиас', vision: 'зрение', custom: 'своя', cache: 'из кеша CLI', config: 'из конфига' };

/** One line for a model in a <select>: its name, then its capabilities in words. */
export function modelOptionLabel(m: { label: string; badges?: string[] }): string {
  return m.badges?.length ? `${m.label} — ${m.badges.map((b) => BADGE_LABEL[b] ?? b).join(' · ')}` : m.label;
}

/** Standard badge HTML component */
export function badge(text: string, kind = 'default', title?: string): string {
  const titleAttr = title ? ` title="${esc(title)}"` : '';
  return `<span class="badge ${esc(kind)}"${titleAttr}>${esc(text)}</span>`;
}

/** Show a modal dialog */
export function showModal(options: {
  title: string;
  content: HTMLElement | string;
  actions?: {
    label: string;
    kind?: 'primary' | 'danger' | 'default';
    onClick: (modal: { close: () => void }) => void;
  }[];
  onClose?: () => void;
  className?: string;
}): { close: () => void; modal: HTMLElement } {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = `modal-card ${options.className ?? ''}`.trim();

  const head = document.createElement('div');
  head.className = 'modal-head';
  head.innerHTML = `<h3>${esc(options.title)}</h3><button type="button" class="modal-close" aria-label="Закрыть">✕</button>`;

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (typeof options.content === 'string') {
    body.innerHTML = options.content;
  } else {
    body.appendChild(options.content);
  }

  const footer = document.createElement('div');
  footer.className = 'modal-footer';

  const controller = {
    close: () => {
      document.removeEventListener('keydown', onKey);
      backdrop.classList.add('closing');
      setTimeout(() => {
        backdrop.remove();
        options.onClose?.();
      }, 180);
    },
    modal,
  };

  head.querySelector('.modal-close')!.addEventListener('click', controller.close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) controller.close();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') controller.close();
  };
  document.addEventListener('keydown', onKey);

  if (options.actions && options.actions.length > 0) {
    for (const action of options.actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${action.kind ?? 'default'}`;
      btn.textContent = action.label;
      btn.addEventListener('click', () => action.onClick(controller));
      footer.appendChild(btn);
    }
  } else {
    footer.classList.add('hidden');
  }

  modal.appendChild(head);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Focus trap / focus first button
  requestAnimationFrame(() => {
    modal.querySelector<HTMLElement>('input, button, select, textarea')?.focus();
  });

  return controller;
}

/** Show a toast notification */
let toastContainer: HTMLElement | null = null;
export function showToast(message: string, kind: 'info' | 'ok' | 'warn' | 'bad' = 'info', durationMs = 3500): void {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  const item = document.createElement('div');
  item.className = `toast-item ${kind}`;
  item.textContent = message;
  toastContainer.appendChild(item);

  setTimeout(() => {
    item.classList.add('fading');
    setTimeout(() => item.remove(), 250);
  }, durationMs);
}

/** Subtle Web Audio completion chime */
export function playCompletionChime(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    gain1.gain.setValueAtTime(0.08, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.12); // A5
    gain2.gain.setValueAtTime(0.08, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.55);
  } catch {
    // audio failure silent
  }
}

/** Send desktop browser notification if allowed */
export function notifyDesktop(title: string, body: string): void {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/favicon.ico' });
    } else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((perm) => {
        if (perm === 'granted') new Notification(title, { body, icon: '/favicon.ico' });
      });
    }
  } catch {
    // notification failure silent
  }
}

export interface ModelSelectOptions {
  container: HTMLElement;
  send: (msg: ClientMessage) => boolean;
  filterExecutor?: Executor;
  initialExecutor?: Executor;
  initialModel?: string;
  initialEffort?: string;
  showUnified?: boolean; // All providers with optgroups
  showEffort?: boolean;
  onChange?: (val: { executor: Executor; model: string; effort?: string }) => void;
  onExecutorChange?: (executor: Executor) => void;
}

export interface ModelSelectController {
  getValue(): { executor: Executor; model: string; effort?: string };
  setValue(executor: Executor, model: string, effort?: string): void;
  setFilterExecutor(executor: Executor | undefined): void;
  updateCatalog(): void;
  destroy(): void;
}

const EXECUTOR_LABELS: Record<Executor, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

const CUSTOM_MODEL_VAL = '__custom__';

/**
 * Task 1: Catalog helper modelSelect().
 * Creates a <select> with <optgroup>s, badges, custom ID option, rescan button ↻,
 * and adaptive reasoning effort selector.
 */
export function modelSelect(opts: ModelSelectOptions): ModelSelectController {
  const { container, send, onChange, onExecutorChange } = opts;
  let currentExecutor: Executor = opts.initialExecutor ?? opts.filterExecutor ?? 'codex';
  let currentModel: string = opts.initialModel ?? '';
  let currentEffort: string = opts.initialEffort ?? '';
  let filterExecutor: Executor | undefined = opts.filterExecutor;
  const showUnified = opts.showUnified ?? true;
  const showEffort = opts.showEffort ?? true;

  container.innerHTML = `
    <div class="model-select-wrapper">
      <div class="model-select-controls">
        <select class="model-select" aria-label="Модель"></select>
        <button type="button" class="btn-rescan" title="Обновить каталог моделей (models.rescan)">↻</button>
      </div>
      <input type="text" class="model-custom-input" placeholder="Кастомный ID модели (например: claude-3-7-sonnet-20250219)..." hidden />
      <div class="effort-select-row" ${showEffort ? '' : 'hidden'}>
        <label class="effort-label">Уровень рассуждений
          <select class="effort-select" aria-label="Уровень рассуждений"></select>
        </label>
      </div>
    </div>
  `;

  const modelSelectEl = container.querySelector<HTMLSelectElement>('.model-select')!;
  const rescanBtn = container.querySelector<HTMLButtonElement>('.btn-rescan')!;
  const customInputEl = container.querySelector<HTMLInputElement>('.model-custom-input')!;
  const effortSelectEl = container.querySelector<HTMLSelectElement>('.effort-select')!;
  const effortRowEl = container.querySelector<HTMLElement>('.effort-select-row')!;

  function populateModels(): void {
    const catalog: ModelCatalog = store.catalog;
    const prevVal = modelSelectEl.value;

    let html = '';
    const executorsToRender: Executor[] = filterExecutor ? [filterExecutor] : ['claude', 'codex', 'antigravity'];

    let foundCurrent = false;

    for (const ex of executorsToRender) {
      const models = catalog.models.filter((m) => m.executor === ex);
      if (models.length === 0) continue;

      html += `<optgroup label="${esc(EXECUTOR_LABELS[ex])}">`;
      for (const m of models) {
        const isSel = (m.id === currentModel && (filterExecutor ? true : m.executor === currentExecutor));
        if (isSel) foundCurrent = true;
        html += `<option value="${esc(m.id)}" data-executor="${esc(m.executor)}" ${isSel ? 'selected' : ''}>${esc(modelOptionLabel(m))}</option>`;
      }
      html += `</optgroup>`;
    }

    const isCustom = !foundCurrent && currentModel.length > 0 && currentModel !== CUSTOM_MODEL_VAL;
    html += `<option value="${CUSTOM_MODEL_VAL}" ${isCustom ? 'selected' : ''}>Указать кастомный ID модели…</option>`;

    modelSelectEl.innerHTML = html;

    if (isCustom) {
      customInputEl.hidden = false;
      customInputEl.value = currentModel;
    } else {
      customInputEl.hidden = modelSelectEl.value !== CUSTOM_MODEL_VAL;
    }

    // Keep value if possible
    if (prevVal && [...modelSelectEl.options].some((o) => o.value === prevVal)) {
      modelSelectEl.value = prevVal;
    }

    updateEfforts();
  }

  function updateEfforts(): void {
    if (!showEffort) {
      effortRowEl.hidden = true;
      return;
    }
    effortRowEl.hidden = false;

    const selectedOpt = modelSelectEl.selectedOptions[0];
    const ex = (selectedOpt?.dataset.executor as Executor | undefined) ?? currentExecutor;
    const modelId = modelSelectEl.value === CUSTOM_MODEL_VAL ? customInputEl.value.trim() : modelSelectEl.value;

    const modelObj = store.catalog.models.find((m) => m.id === modelId && m.executor === ex);
    const efforts = modelObj?.efforts ?? [];
    const defaultEffort = modelObj?.defaultEffort;

    let effortHtml = `<option value="">по умолчанию${defaultEffort ? ` (${esc(defaultEffort)})` : ''}</option>`;
    for (const ef of efforts) {
      effortHtml += `<option value="${esc(ef)}" ${ef === currentEffort ? 'selected' : ''}>${esc(ef)}</option>`;
    }

    effortSelectEl.innerHTML = effortHtml;
    effortSelectEl.disabled = efforts.length === 0;

    if (currentEffort && efforts.includes(currentEffort)) {
      effortSelectEl.value = currentEffort;
    } else if (!efforts.includes(currentEffort)) {
      currentEffort = '';
    }
  }

  function emitChange(): void {
    const selectedOpt = modelSelectEl.selectedOptions[0];
    const isCustom = modelSelectEl.value === CUSTOM_MODEL_VAL;

    if (selectedOpt?.dataset.executor && !filterExecutor && showUnified) {
      const nextEx = selectedOpt.dataset.executor as Executor;
      if (nextEx !== currentExecutor) {
        currentExecutor = nextEx;
        onExecutorChange?.(nextEx);
      }
    }

    const modelVal = isCustom ? customInputEl.value.trim() : modelSelectEl.value;
    currentModel = modelVal;
    currentEffort = effortSelectEl.value;

    onChange?.({
      executor: currentExecutor,
      model: modelVal,
      effort: currentEffort || undefined,
    });
  }

  modelSelectEl.addEventListener('change', () => {
    const isCustom = modelSelectEl.value === CUSTOM_MODEL_VAL;
    customInputEl.hidden = !isCustom;
    if (isCustom) {
      customInputEl.focus();
    }
    updateEfforts();
    emitChange();
  });

  customInputEl.addEventListener('input', () => {
    updateEfforts();
    emitChange();
  });

  effortSelectEl.addEventListener('change', () => {
    currentEffort = effortSelectEl.value;
    emitChange();
  });

  rescanBtn.addEventListener('click', () => {
    rescanBtn.classList.add('spinning');
    send({ type: 'models.rescan' });
    showToast('Запрошено сканирование моделей…', 'info');
    setTimeout(() => rescanBtn.classList.remove('spinning'), 1200);
  });

  const unsub = store.on('catalog', () => {
    populateModels();
  });

  populateModels();

  return {
    getValue: () => {
      const isCustom = modelSelectEl.value === CUSTOM_MODEL_VAL;
      const modelVal = isCustom ? customInputEl.value.trim() : modelSelectEl.value;
      return {
        executor: currentExecutor,
        model: modelVal,
        effort: effortSelectEl.value || undefined,
      };
    },
    setValue: (ex: Executor, model: string, effort?: string) => {
      currentExecutor = ex;
      currentModel = model;
      currentEffort = effort ?? '';
      populateModels();
    },
    setFilterExecutor: (ex?: Executor) => {
      filterExecutor = ex;
      if (ex) currentExecutor = ex;
      populateModels();
    },
    updateCatalog: () => {
      populateModels();
    },
    destroy: () => {
      unsub();
    },
  };
}
