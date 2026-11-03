import { Application, Container } from 'pixi.js';
import type { AgentState, LogEntry } from '@land/protocol';
import { buildScene } from './scene';
import { Office } from './office';
import { connect } from './net';
import { iso } from './iso';
import { W, H } from './layout';
import { Sidebar } from './ui';
import './style.css';

const stage = document.getElementById('stage')!;
const app = new Application();
await app.init({
  resizeTo: stage,
  background: 0x1a1d26,
  antialias: true,
  resolution: Math.min(window.devicePixelRatio, 2),
  autoDensity: true,
});
stage.appendChild(app.canvas);

const world = new Container({ sortableChildren: true });
app.stage.addChild(world);
const office = new Office(world, buildScene(world));

const states = new Map<string, AgentState>();
const logs = new Map<string, LogEntry[]>();
let selected: string | undefined;

const sidebar = new Sidebar(document.getElementById('sidebar')!, (id) => select(id));
office.onSelect = (id) => select(id);

function select(id: string | undefined): void {
  selected = selected === id ? undefined : id;
  office.select(selected);
  sidebar.render(states, logs, selected);
  const a = selected && office.agents.get(selected);
  if (a) focus(a.pos.x, a.pos.y);
}

connect(
  (m) => {
    switch (m.type) {
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
        const l = logs.get(m.id) ?? [];
        l.push(m.entry);
        if (l.length > 40) l.shift();
        logs.set(m.id, l);
        break;
      }
    }
    sidebar.scheduleRender(states, logs, selected);
  },
  (online) => sidebar.setOnline(online),
);

app.ticker.add((t) => office.update(Math.min(t.deltaMS / 1000, 0.1)));

// Camera: drag to pan, wheel to zoom around the cursor, double-click to fit.
let zoom = 1;
function fit(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const left = iso(0, H).x;
  const right = iso(W, 0).x;
  const top = iso(0, 0).y - 110;
  const bottom = iso(W, H).y + 20;
  zoom = Math.min(w / (right - left + 60), h / (bottom - top + 40), 1.6);
  world.scale.set(zoom);
  world.position.set(w / 2 - ((left + right) / 2) * zoom, h / 2 - ((top + bottom) / 2) * zoom);
}
function focus(x: number, y: number): void {
  const p = iso(x, y);
  world.position.set(stage.clientWidth / 2 - p.x * zoom, stage.clientHeight / 2 - (p.y - 30) * zoom);
}
fit();
new ResizeObserver(fit).observe(stage);

let drag: { x: number; y: number; wx: number; wy: number } | undefined;
app.canvas.addEventListener('pointerdown', (e) => (drag = { x: e.clientX, y: e.clientY, wx: world.x, wy: world.y }));
window.addEventListener('pointerup', () => (drag = undefined));
window.addEventListener('pointermove', (e) => {
  if (drag) world.position.set(drag.wx + e.clientX - drag.x, drag.wy + e.clientY - drag.y);
});
app.canvas.addEventListener('dblclick', fit);
app.canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = app.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const next = Math.min(3, Math.max(0.35, zoom * Math.exp(-e.deltaY * 0.0015)));
    world.position.set(mx - ((mx - world.x) * next) / zoom, my - ((my - world.y) * next) / zoom);
    zoom = next;
    world.scale.set(zoom);
  },
  { passive: false },
);
