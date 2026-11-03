import { Container, Graphics } from 'pixi.js';
import type { AgentState, Collaboration } from '@land/protocol';
import { AgentSprite, type Detail } from './agent';
import { iso } from './iso';
import { DESKS, DOOR, HOME, SPOTS, ZONE_OF, type Desk, type Tile } from './layout';
import { drawBoard, type Scene } from './scene';

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
  private fires = new Map<Desk, Graphics>();
  private extinguished = new Map<string, number>();
  private t = 0;
  private world: Container;
  private scene: Scene;
  onSelect?: (id: string) => void;
  onBoard?: () => void;
  private running = -1;

  constructor(world: Container, scene: Scene) {
    this.world = world;
    this.scene = scene;
    this.links.zIndex = 99999;
    world.addChild(this.links);
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
    a.walkTo(this.claim(a, SPOTS[zone]));
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
