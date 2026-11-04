import { Application, Container } from 'pixi.js';
import type { AgentState, LogEntry } from '@land/protocol';
import { buildScene } from './scene';
import { Office } from './office';
import { connect } from './net';
import { iso } from './iso';
import { W, H } from './layout';
import { buildCampus, CAMPUS_BOUNDS } from './campus';
import { Sidebar } from './ui';
import { TaskBoardPanel } from './board';
import { MeetingPanel } from './meeting';
import './style.css';

const stage = document.getElementById('stage')!;

// Theme: the system setting, unless the user pinned light or dark with the button (remembered per browser).
type Theme = 'light' | 'dark';
const THEME_KEY = 'land-theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
function savedTheme(): Theme | undefined {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : undefined;
  } catch {
    return undefined; // storage can be unavailable (private mode, blocked site data)
  }
}
/** A pinned theme lives on <html data-theme>; without one the system setting applies. */
const currentTheme = (): Theme => (document.documentElement.dataset.theme as Theme | undefined) ?? (systemDark.matches ? 'dark' : 'light');
function sceneColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--scene').trim() || '#e5e3da';
}
function applyTheme(pin?: Theme): void {
  const pinned = pin ?? savedTheme();
  if (pinned) document.documentElement.dataset.theme = pinned;
  else delete document.documentElement.dataset.theme;
  const dark = currentTheme() === 'dark';
  const button = document.getElementById('theme-toggle');
  if (button) {
    button.textContent = dark ? '☀' : '☾';
    button.setAttribute('aria-label', dark ? 'Светлая тема' : 'Тёмная тема');
  }
}
applyTheme();
const app = new Application();
await app.init({
  resizeTo: stage,
  background: sceneColor(),
  antialias: true,
  resolution: Math.min(window.devicePixelRatio, 2),
  autoDensity: true,
});
stage.appendChild(app.canvas);
const repaintScene = () => (app.renderer.background.color = sceneColor());
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // not remembered for next time, but switched now
  }
  applyTheme(next);
  repaintScene();
});
systemDark.addEventListener('change', () => {
  if (document.documentElement.dataset.theme) return; // the user pinned a theme
  applyTheme();
  repaintScene();
});

const world = new Container({ sortableChildren: true });
app.stage.addChild(world);
const campus = buildCampus(world);
const office = new Office(world, buildScene(world));

const states = new Map<string, AgentState>();
const logs = new Map<string, LogEntry[]>();
let selected: string | undefined;

const sidebar = new Sidebar(document.getElementById('sidebar')!, (id) => select(id));
office.onSelect = (id) => select(id);
office.onBoard = () => sidebar.show('tasks');
let send: ReturnType<typeof connect> = () => false;
const board = new TaskBoardPanel(sidebar.tasksPane, (m) => send(m), (id) => {
  sidebar.show('office');
  if (selected !== id) select(id);
});
const meeting = new MeetingPanel(sidebar.teamPane, (m) => send(m), (id) => {
  sidebar.show('office');
  if (selected !== id) select(id);
});
const syncBoard = () => {
  board.setAgents(new Set(states.keys()));
  meeting.setAgents(new Set(states.keys()));
  sidebar.setMeeting(meeting.running);
  sidebar.setRunning(board.running);
  office.setTasks(board.running);
};

function select(id: string | undefined): void {
  selected = selected === id ? undefined : id;
  office.select(selected);
  sidebar.render(states, logs, selected);
  const a = selected && office.agents.get(selected);
  if (a) focus(a.pos.x, a.pos.y);
}

send = connect(
  (m) => {
    switch (m.type) {
      case 'board':
        board.setBoard(m.config, m.tasks);
        meeting.setModels(Object.values(m.config.executors).flatMap((e) => e.models));
        syncBoard();
        return;
      case 'collabs':
        meeting.setAll(m.collabs);
        office.setCollabs(m.collabs);
        syncBoard();
        return;
      case 'collab':
        meeting.upsert(m.collab);
        office.collab(m.collab);
        syncBoard();
        return;
      case 'task':
        board.upsert(m.task);
        syncBoard();
        return;
      case 'error':
        board.showError(m.message);
        return;
      case 'folders':
        board.foldersResult(m);
        break;
      case 'task.accepted':
        board.submissionResult(m.requestId);
        return;
      case 'task.rejected':
        board.submissionResult(m.requestId, m.message);
        return;
      case 'snapshot':
        states.clear();
        logs.clear();
        for (const a of m.agents) states.set(a.id, a);
        for (const [id, l] of Object.entries(m.logs)) logs.set(id, l);
        office.reset(m.agents);
        break;
      case 'upsert':
        states.set(m.agent.id, m.agent);
        office.upsert(m.agent);
        break;
      case 'remove':
        states.delete(m.id);
        logs.delete(m.id);
        office.remove(m.id);
        if (selected === m.id) selected = undefined;
        break;
      case 'log': {
        if (m.entry.kind === 'system' && m.entry.text.startsWith('Передаёт ответ коллеге')) office.agents.get(m.id)?.say(m.entry.text);
        const l = logs.get(m.id) ?? [];
        l.push(m.entry);
        if (l.length > 40) l.shift();
        logs.set(m.id, l);
        break;
      }
    }
    sidebar.scheduleRender(states, logs, selected);
    if (m.type !== 'log') syncBoard();
  },
  (online) => { sidebar.setOnline(online); if (!online) board.disconnected(); },
);

app.ticker.add((t) => {
  const dt = Math.min(t.deltaMS / 1000, 0.1);
  office.update(dt);
  campus.update(dt);
});

// Camera: drag to pan, wheel or buttons to zoom, double-click or ⤢ to fit.
let zoom = 1;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 3;
/** Zoom to `next` keeping the point (mx, my) of the stage in place. */
function zoomAt(next: number, mx: number, my: number): void {
  next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  world.position.set(mx - ((mx - world.x) * next) / zoom, my - ((my - world.y) * next) / zoom);
  zoom = next;
  world.scale.set(zoom);
  office.setZoom(zoom);
}
type View = 'office' | 'campus' | 'garden';
let currentView: View = 'office';
const VIEWS = {
  office: { minX: 0, minY: 0, maxX: W, maxY: H + 2 },
  campus: CAMPUS_BOUNDS,
  garden: { minX: 23, minY: 0, maxX: 32, maxY: 24 },
};
function fit(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const b = VIEWS[currentView];
  const left = iso(b.minX, b.maxY).x;
  const right = iso(b.maxX, b.minY).x;
  const top = iso(b.minX, b.minY).y - 110;
  const bottom = iso(b.maxX, b.maxY).y + 20;
  zoom = Math.min((w - 32) / (right - left + 40), (h - 100) / (bottom - top + 20), 1.6);
  zoom = Math.max(MIN_ZOOM, zoom);
  world.scale.set(zoom);
  office.setZoom(zoom);
  world.position.set(w / 2 - ((left + right) / 2) * zoom, h / 2 - ((top + bottom) / 2) * zoom);
}
function focus(x: number, y: number): void {
  const p = iso(x, y);
  world.position.set(stage.clientWidth / 2 - p.x * zoom, stage.clientHeight / 2 - (p.y - 30) * zoom);
}
fit();
new ResizeObserver(fit).observe(stage);
document.querySelector('.scene-views')?.addEventListener('click', (e) => {
  const value = (e.target as HTMLElement).closest<HTMLElement>('[data-view]')?.dataset.view;
  if (value !== 'office' && value !== 'campus' && value !== 'garden') return;
  currentView = value;
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.view === value));
  });
  fit();
});

let drag: { x: number; y: number; wx: number; wy: number } | undefined;
app.canvas.addEventListener('pointerdown', (e) => (drag = { x: e.clientX, y: e.clientY, wx: world.x, wy: world.y }));
window.addEventListener('pointerup', () => (drag = undefined));
window.addEventListener('pointermove', (e) => {
  if (drag) world.position.set(drag.wx + e.clientX - drag.x, drag.wy + e.clientY - drag.y);
});
app.canvas.addEventListener('dblclick', fit);
stage.tabIndex = 0;
stage.setAttribute('role', 'region');
stage.setAttribute('aria-label', 'Офис и квартал. Стрелки перемещают камеру, плюс и минус меняют масштаб, 0 возвращает общий вид.');
stage.addEventListener('keydown', (e) => {
  const directions: Record<string, [number, number]> = { ArrowLeft: [50, 0], ArrowRight: [-50, 0], ArrowUp: [0, 50], ArrowDown: [0, -50] };
  const direction = directions[e.key];
  if (direction) world.position.set(world.x + direction[0], world.y + direction[1]);
  else if (e.key === '0') fit();
  else if (e.key === '+' || e.key === '=' || e.key === '-') zoomAt(zoom * (e.key === '-' ? 0.8 : 1.25), stage.clientWidth / 2, stage.clientHeight / 2);
  else return;
  e.preventDefault();
});
app.canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = app.canvas.getBoundingClientRect();
    zoomAt(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  },
  { passive: false },
);
document.querySelector('.scene-controls')?.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
  if (action === 'fit') return fit();
  if (action) zoomAt(zoom * (action === 'in' ? 1.25 : 0.8), stage.clientWidth / 2, stage.clientHeight / 2);
});
