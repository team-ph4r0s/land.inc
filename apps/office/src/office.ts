import { Container, Graphics } from 'pixi.js';
import type { AgentState } from '@land/protocol';
import { AgentSprite } from './agent';
import { iso } from './iso';
import { DESKS, DOOR, SPOTS, ZONE_OF, type Desk, type Tile } from './layout';
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
    a.walkTo(DOOR);
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
    for (const a of [...this.agents.values()]) {
      a.update(dt);
      if (a.gone) this.drop(a);
    }
    this.wander();
    this.paint();
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
    const zone = ZONE_OF[a.state.activity];
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
  }
}
