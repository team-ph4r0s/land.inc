import { Container, Graphics, Text } from 'pixi.js';
import type { AgentState, Collaboration, TeamRun, UpdateState } from '@land/protocol';
import { AgentSprite, type Detail } from './agent';
import { iso } from './iso';
import { DESKS, DOOR, HOME, H, W, SPOTS, ZONE_OF, type Desk, type Tile } from './layout';
import { drawBoard, type Scene } from './scene';
import { box, depth } from './iso';
import { OfficeResidents } from './residents';

const SCREEN = { off: 0x1b2330, think: 0x3b82f6, write: 0x22c55e, wait: 0xf59e0b };

/**
 * Keeps agent sprites in sync with daemon state: assigns desks (one project
 * sits together), sends each agent to the zone of its current activity and
 * lights monitors and server racks accordingly.
 */
export class Office {
  readonly agents = new Map<string, AgentSprite>();
  private deskOwner = new Map<Desk, string>();
  private spotOwner = new Map<string, string>();
  private links = new Graphics();
  private handoffsGfx = new Graphics();
  private handoffs: { from: Tile; to: Tile; t: number; duration: number }[] = [];
  private teamRuns = new Map<string, TeamRun>();
  private fires = new Map<Desk, Graphics>();
  private extinguished = new Map<string, number>();
  private t = 0;
  private world: Container;
  private scene: Scene;
  onSelect?: (id: string) => void;
  onBoard?: () => void;
  onUpdate?: () => void;
  private parcel = new Container();
  private parcelY = 0;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private running = -1;
  readonly residents: OfficeResidents;

  constructor(world: Container, scene: Scene) {
    this.world = world;
    this.scene = scene;
    this.residents = new OfficeResidents(world);
    this.links.zIndex = 99999;
    this.handoffsGfx.zIndex = 99998;
    world.addChild(this.links);
    world.addChild(this.handoffsGfx);
    for (const { desk } of scene.desks) {
      const fire = new Graphics();
      fire.zIndex = 90000;
      fire.eventMode = 'static';
      fire.cursor = 'pointer';
      fire.on('pointertap', () => {
        const id = this.deskOwner.get(desk);
        const at = id && this.agents.get(id)?.state.fireAt;
        if (id && at) this.extinguished.set(id, at);
      });
      this.fires.set(desk, fire);
      world.addChild(fire);
    }
    scene.board.on('pointertap', () => this.onBoard?.());
    const parcel = new Graphics();
    box(parcel, 0, 0, 0.9, 0.9, 24, 0xd3a266);
    box(parcel, 0.38, 0, 0.14, 0.9, 25, 0x7f9f72);
    box(parcel, 0, 0.38, 0.9, 0.14, 25, 0x7f9f72);
    this.parcel.addChild(parcel);
    this.parcel.position.copyFrom(iso(DOOR.x - 2, DOOR.y - 1));
    this.parcelY = this.parcel.y;
    this.parcel.zIndex = depth(DOOR.x - 2, DOOR.y - 1) + 1;
    this.parcel.visible = false;
    this.parcel.eventMode = 'static';
    this.parcel.cursor = 'pointer';
    this.parcel.on('pointertap', () => this.onUpdate?.());
    this.world.addChild(this.parcel);
  }

  setUpdate(state: UpdateState): void {
    this.parcel.visible = !!state.available;
    const old = this.parcel.getChildByLabel('version');
    if (old) { this.parcel.removeChild(old); old.destroy(); }
    if (state.available) {
      const label = new Text({ text: `↑ ${state.available.version}`, style: { fontFamily: 'system-ui', fontSize: 13, fontWeight: '700', fill: 0x244a35 } });
      label.label = 'version';
      label.anchor.set(0.5);
      label.position.set(0, -35);
      this.parcel.addChild(label);
    }
  }

  upsert(state: AgentState): void {
    let a = this.agents.get(state.id);
    if (!a || a.leaving) {
      if (a) this.drop(a);
      const parent = state.parentId ? this.agents.get(state.parentId) : undefined;
      // Subagents appear next to the parent, everyone else comes in through the door.
      const spawn = parent ? { ...parent.pos } : { x: DOOR.x + 0.5, y: DOOR.y + 0.5 };
      a = new AgentSprite(state, spawn);
      a.setDetail(this.detail);
      a.view.on('pointertap', () => this.onSelect?.(state.id));
      this.agents.set(state.id, a);
      this.world.addChild(a.view);
      this.assignDesk(a);
    } else {
      a.apply(state);
    }
    this.route(a);
  }

  remove(id: string): void {
    const a = this.agents.get(id);
    if (!a || a.leaving) return;
    a.leaving = true;
    a.say('Ушёл домой 👋', 3000);
    this.release(a);
    a.walkTo(HOME);
  }

  /** Server snapshot: add/update everyone listed and let the rest leave. */
  reset(states: AgentState[]): void {
    const ids = new Set(states.map((s) => s.id));
    for (const id of this.agents.keys()) if (!ids.has(id)) this.remove(id);
    // Parents first so subagents can spawn next to them.
    for (const s of [...states].sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId))) {
      const fresh = !this.agents.has(s.id);
      this.upsert(s);
      // People already at work when the office opens are at their places, not queueing at the door.
      if (fresh) this.agents.get(s.id)?.teleport();
    }
  }

  private detail: Detail = 'full';
  private nextLayout = 0;

  /** Far away plates show only icons, closer the title, close up the model too. */
  setZoom(zoom: number): void {
    this.residents.setZoom(zoom);
    this.detail = zoom < 0.6 ? 'icon' : zoom < 1.05 ? 'name' : 'full';
    for (const a of this.agents.values()) a.setDetail(this.detail);
  }

  /**
   * Plates that would cover each other: the agent nearer the viewer keeps its plate,
   * the one behind shrinks to its icon. The agent in focus always wins.
   */
  private layoutPlates(): void {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const hits = (r: (typeof placed)[number]) => placed.some((p) => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h);
    const order = [...this.agents.values()]
      .filter((a) => !a.leaving)
      .sort((p, q) => Number(q.focused) - Number(p.focused) || q.view.zIndex - p.view.zIndex);
    for (const a of order) {
      const r = a.plateRect();
      const crowded = !a.focused && hits(r);
      a.setCrowded(crowded);
      if (!crowded) placed.push(r);
    }
  }

  /** Collaborations by id, for the lines between the agents of consecutive turns. */
  private collabs = new Map<string, Collaboration>();
  /** Agents that just handed their turn over meet in the meeting room until this time. */
  private meetings = new Map<string, number>();

  setCollabs(list: Collaboration[]): void {
    this.collabs = new Map(list.map((c) => [c.id, c]));
  }

  triggerArtifactHandoff(from: Tile, to: Tile): void {
    this.handoffs.push({ from, to, t: 0, duration: 1.5 });
  }

  setTeamRuns(runs: TeamRun[]): void {
    const prevRuns = this.teamRuns;
    this.teamRuns = new Map(runs.map((r) => [r.id, r]));

    for (const r of runs) {
      const prev = prevRuns.get(r.id);
      if (!prev) continue;
      for (let i = 0; i < r.steps.length; i++) {
        if (r.steps[i].status === 'done' && prev.steps[i]?.status !== 'done') {
          const fromSeat = { x: 19 + (i % 3), y: 8 };
          const toSeat = { x: 19 + ((i + 1) % 3), y: 11 };
          this.triggerArtifactHandoff(fromSeat, toSeat);
        }
      }
    }

    this.syncTeamStageBubbles();
  }

  teamRun(run: TeamRun): void {
    const prev = this.teamRuns.get(run.id);
    this.teamRuns.set(run.id, run);

    if (prev) {
      for (let i = 0; i < run.steps.length; i++) {
        if (run.steps[i].status === 'done' && prev.steps[i]?.status !== 'done') {
          const fromSeat = { x: 19 + (i % 3), y: 8 };
          const toSeat = { x: 19 + ((i + 1) % 3), y: 11 };
          this.triggerArtifactHandoff(fromSeat, toSeat);
        }
      }
    }

    this.syncTeamStageBubbles();
  }

  private syncTeamStageBubbles(): void {
    for (const a of this.agents.values()) a.setTeamStage(undefined);

    for (const r of this.teamRuns.values()) {
      if (r.status !== 'running') continue;
      const curIdx = r.steps.findIndex((s) => s.status === 'running');
      if (curIdx < 0) continue;
      const step = r.steps[curIdx];

      let stageText = 'Выполняет этап…';
      if (step.kind === 'worker') {
        if (step.produces === 'ChapterDraft' || step.produces === 'ChapterOutline') stageText = 'Пишет главу…';
        else if (step.produces === 'ArchitectureSpec') stageText = 'Проектирует архитектуру…';
        else if (step.produces === 'ImplementationDiff') stageText = 'Пишет код…';
        else stageText = 'Выполняет работу…';
      } else if (step.kind === 'critic') {
        stageText = 'Проверяет логику…';
      } else if (step.kind === 'fixer') {
        stageText = 'Вносит правки…';
      } else if (step.kind === 'synthesizer') {
        stageText = 'Синтезирует решение…';
      } else if (step.kind === 'manager') {
        stageText = 'Координирует команду…';
      }

      let targetSprite: AgentSprite | undefined;
      if (step.agentId) targetSprite = this.agents.get(step.agentId);
      if (!targetSprite && step.taskId) targetSprite = [...this.agents.values()].find((a) => a.state.taskId === step.taskId);
      if (!targetSprite) targetSprite = [...this.agents.values()].find((a) => a.state.source === step.executor);
      if (!targetSprite && this.agents.size > 0) targetSprite = [...this.agents.values()][0];

      if (targetSprite) {
        targetSprite.setTeamStage(stageText, 0.5);
      }
    }
  }

  /** A collaboration changed: whoever just handed a turn over walks to the meeting room and says what. */
  collab(c: Collaboration): void {
    const before = this.collabs.get(c.id);
    this.collabs.set(c.id, c);
    c.turns.forEach((turn, i) => {
      const was = before?.turns[i];
      const next = c.turns[i + 1];
      if (turn.status !== 'done' || was?.status === 'done' || !turn.handoff || !next || next.status !== 'running') return;
      const a = turn.agentId ? this.agents.get(turn.agentId) : undefined;
      if (!a || a.leaving) return;
      this.meetings.set(a.state.id, performance.now() + MEETING_MS);
      a.say(`Передаю коллеге: ${turn.handoff.length > 90 ? turn.handoff.slice(0, 89) + '…' : turn.handoff}`, MEETING_MS);
      this.route(a, true);
      this.triggerArtifactHandoff({ x: 19.5, y: 8.5 }, { x: 21.5, y: 11.5 });
    });
  }

  /** Sticky notes on the cork board follow the number of running tasks. */
  setTasks(running: number): void {
    if (running === this.running) return;
    this.running = running;
    drawBoard(this.scene.board, running);
  }

  select(id: string | undefined): void {
    for (const a of this.agents.values()) a.setSelected(a.state.id === id);
  }

  update(dt: number): void {
    this.t += dt;
    this.residents.update(dt, [...this.agents.values()].filter((a) => !a.leaving).map((a) => a.pos));
    if (this.parcel.visible) this.parcel.y = this.parcelY - (this.reducedMotion.matches ? 0 : Math.sin(this.t * 2) * 3);
    const now = performance.now();
    for (const [id, until] of this.meetings) {
      if (now < until) continue;
      this.meetings.delete(id);
      const a = this.agents.get(id);
      if (a) this.route(a, true); // back to what it is actually doing
    }
    for (const a of [...this.agents.values()]) {
      a.update(dt);
      if (a.gone) this.drop(a);
    }
    this.wander();
    this.paint();

    // Render flying artifact handoffs in meeting room
    this.handoffsGfx.clear();
    for (let i = this.handoffs.length - 1; i >= 0; i--) {
      const h = this.handoffs[i];
      h.t += dt / h.duration;
      if (h.t >= 1) {
        this.handoffs.splice(i, 1);
        continue;
      }
      const s = iso(h.from.x, h.from.y);
      const e = iso(h.to.x, h.to.y);
      const p = h.t;
      const x = s.x + (e.x - s.x) * p;
      const y = s.y + (e.y - s.y) * p - Math.sin(p * Math.PI) * 36;

      this.handoffsGfx.circle(x, y - 20, 7).fill({ color: 0xffd166, alpha: 0.95 });
      this.handoffsGfx.circle(x, y - 20, 14).fill({ color: 0xffd166, alpha: 0.35 });
      for (let k = 1; k <= 3; k++) {
        const lag = Math.max(0, p - k * 0.08);
        const lx = s.x + (e.x - s.x) * lag;
        const ly = s.y + (e.y - s.y) * lag - Math.sin(lag * Math.PI) * 36;
        this.handoffsGfx.circle(lx, ly - 20, 4 - k).fill({ color: 0x4285f4, alpha: 0.7 - k * 0.2 });
      }
    }
    // Plates move with their agents; re-check overlaps a few times a second, not every frame.
    if (now >= this.nextLayout) {
      this.nextLayout = now + 250;
      this.layoutPlates();
    }
  }

  private drop(a: AgentSprite): void {
    this.release(a);
    a.view.destroy({ children: true });
    if (this.agents.get(a.state.id) === a) this.agents.delete(a.state.id);
  }

  private deskOf(a: AgentSprite): Desk | undefined {
    for (const [d, id] of this.deskOwner) if (id === a.state.id) return d;
    return undefined;
  }

  private assignDesk(a: AgentSprite): void {
    const free = DESKS.filter((d) => !this.deskOwner.has(d));
    if (!free.length) return;
    const row = (d: Desk) => d.y;
    const mates = [...this.deskOwner].filter(([, id]) => {
      const o = this.agents.get(id)?.state;
      return o && (o.project === a.state.project || o.id === a.state.parentId);
    });
    const parentDesk = a.state.parentId ? [...this.deskOwner].find(([, id]) => id === a.state.parentId)?.[0] : undefined;
    const occupiedRows = new Set([...this.deskOwner.keys()].map(row));
    const score = (d: Desk) => {
      if (parentDesk) return Math.abs(d.x - parentDesk.x) + Math.abs(d.y - parentDesk.y) * 3;
      if (mates.length) return Math.min(...mates.map(([m]) => Math.abs(d.x - m.x) + Math.abs(d.y - m.y) * 3));
      // A new project takes an empty row when there is one.
      return (occupiedRows.has(d.y) ? 100 : 0) + d.x + d.y;
    };
    free.sort((p, q) => score(p) - score(q));
    this.deskOwner.set(free[0], a.state.id);
  }

  private release(a: AgentSprite): void {
    for (const [d, id] of this.deskOwner) if (id === a.state.id) this.deskOwner.delete(d);
    for (const [k, id] of this.spotOwner) if (id === a.state.id) this.spotOwner.delete(k);
  }

  /** Send the agent to where its current activity happens. */
  private route(a: AgentSprite, force = false): void {
    if (a.leaving) return;
    const zone = this.meetings.has(a.state.id) ? 'meeting' : ZONE_OF[a.state.activity];
    // Already there (e.g. Read → Grep): stay put instead of hopping between spots.
    if (zone === a.zone && a.target && !force) return;
    a.zone = zone;
    for (const [k, id] of this.spotOwner) if (id === a.state.id) this.spotOwner.delete(k);
    if (zone === 'desk') {
      const desk = this.deskOf(a);
      if (desk) return a.walkTo(desk.seat);
      return a.walkTo(this.claim(a, SPOTS.meeting));
    }
    // A break can happen in the cafe or garden; work activities keep their real zones.
    const spots = zone === 'kitchen' && Math.random() < 0.35
      ? SPOTS.kitchen.filter((t) => t.y >= H || t.x >= W)
      : SPOTS[zone];
    a.walkTo(this.claim(a, spots));
  }

  private claim(a: AgentSprite, spots: Tile[]): Tile {
    const k = (t: Tile) => `${t.x},${t.y}`;
    const free = spots.filter((t) => !this.spotOwner.has(k(t)));
    const pool = free.length ? free : spots;
    const near = (t: Tile) => Math.hypot(t.x - a.pos.x, t.y - a.pos.y) + Math.random() * 2;
    const spot = [...pool].sort((p, q) => near(p) - near(q))[0];
    this.spotOwner.set(k(spot), a.state.id);
    return spot;
  }

  /** People at the kitchen shuffle around now and then so the office feels alive. */
  private wander(): void {
    if (Math.random() > 0.004) return;
    const idle = [...this.agents.values()].filter((a) => a.state.activity === 'idle' && !a.walking && !a.leaving);
    const a = idle[Math.floor(Math.random() * idle.length)];
    if (a) this.route(a, true);
  }

  private paint(): void {
    for (const { desk, screen } of this.scene.desks) {
      const a = this.agents.get(this.deskOwner.get(desk) ?? '');
      const fire = this.fires.get(desk)!;
      fire.clear();
      const at = a?.state.fireAt;
      if (a && at && Date.now() - at < 45_000 && this.extinguished.get(a.state.id) !== at) {
        const p = iso(desk.x + 0.5, desk.y + 0.5);
        const flicker = Math.sin(this.t * 12) * 3;
        fire.ellipse(p.x, p.y - 30, 19, 9).fill({ color: 0xdb702f, alpha: 0.18 });
        fire.poly([p.x - 12, p.y - 30, p.x - 8, p.y - 48, p.x - 2, p.y - 40, p.x + 3, p.y - 60 - flicker, p.x + 12, p.y - 37, p.x + 9, p.y - 28]).fill(0xd95532);
        fire.poly([p.x - 7, p.y - 30, p.x - 3, p.y - 43 - flicker, p.x + 2, p.y - 36, p.x + 6, p.y - 47, p.x + 8, p.y - 30]).fill(0xf7b45a);
      }
      let color = SCREEN.off;
      if (a && a.seated) {
        const act = a.state.activity;
        color = act === 'write' ? SCREEN.write : act === 'wait' ? SCREEN.wait : SCREEN.think;
        screen.alpha = act === 'write' ? 0.8 + Math.sin(this.t * 18) * 0.2 : act === 'wait' ? 0.6 + Math.sin(this.t * 6) * 0.4 : 1;
      } else if (a) {
        color = 0x2c3a52; // owner away: screensaver
        screen.alpha = 1;
      } else screen.alpha = 1;
      screen.tint = color;
    }
    const busy = [...this.agents.values()].some((a) => a.state.activity === 'bash' && !a.walking);
    this.scene.racks.forEach((r, i) => (r.alpha = busy ? 0.85 + Math.sin(this.t * 12 + i) * 0.15 : 1));

    // Dotted line from each subagent to its parent.
    const g = this.links;
    g.clear();
    for (const a of this.agents.values()) {
      const p = a.state.parentId && this.agents.get(a.state.parentId);
      if (!p || a.leaving) continue;
      const s = iso(a.pos.x, a.pos.y);
      const e = iso(p.pos.x, p.pos.y);
      const n = Math.max(1, Math.floor(Math.hypot(e.x - s.x, e.y - s.y) / 10));
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        g.circle(s.x + (e.x - s.x) * f, s.y - 20 + (e.y - s.y) * f, 1.6);
      }
      g.fill({ color: 0xffc56b, alpha: 0.7 });
    }
    // A line between the agents of consecutive turns while their team works.
    for (const c of this.collabs.values()) {
      if (c.status !== 'running' && c.status !== 'stopping') continue;
      for (let i = 0; i + 1 < c.turns.length; i++) {
        const a = c.turns[i].agentId && this.agents.get(c.turns[i].agentId!);
        const b = c.turns[i + 1].agentId && this.agents.get(c.turns[i + 1].agentId!);
        if (!a || !b || a === b || a.leaving || b.leaving) continue;
        const s = iso(a.pos.x, a.pos.y);
        const e = iso(b.pos.x, b.pos.y);
        g.moveTo(s.x, s.y - 24).lineTo(e.x, e.y - 24).stroke({ width: 2, color: 0x10a37f, alpha: 0.55 });
      }
    }
  }
}

const MEETING_MS = 20_000;
