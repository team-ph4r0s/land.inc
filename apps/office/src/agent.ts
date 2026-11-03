import { Container, Graphics, Text } from 'pixi.js';
import type { Activity, AgentState } from '@land/protocol';
import { depth, iso } from './iso';
import { findPath, type Tile } from './layout';

const SPEED = 2.6; // tiles per second
const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const HAIR = [0x2b1d14, 0x5a3825, 0xb5651d, 0x1c1c1c, 0xd4a017, 0x8e44ad, 0x7f8c8d];
export const SOURCE_COLOR: Record<AgentState['source'], number> = { claude: 0xd97757, codex: 0x10a37f, demo: 0x7c6ff0 };

export const ICON: Record<Activity, string> = {
  think: '💭', write: '⌨️', read: '📖', bash: '🖥️', web: '🌐', plan: '📋', talk: '💬', wait: '✋', idle: '☕',
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** One agent in the office: a little person that walks tile to tile and animates its activity. */
export class AgentSprite {
  readonly view = new Container();
  state: AgentState;
  /** Fractional tile position of the feet. */
  pos: Tile;
  target?: Tile;
  /** Office zone the agent was last sent to. */
  zone?: string;
  leaving = false;
  gone = false;
  selected = false;
  private hover = false;

  private path: Tile[] = [];
  private body = new Graphics();
  private ring = new Graphics();
  private name: Text;
  private namePlate = new Graphics();
  private bubble = new Container();
  private bubbleBg = new Graphics();
  private bubbleText: Text;
  private bubbleUntil = 0;
  private t = Math.random() * 10;
  private skin: number;
  private hair: number;
  private small: boolean;

  constructor(state: AgentState, spawn: Tile) {
    this.state = state;
    this.pos = { ...spawn };
    const h = hash(state.id);
    this.skin = SKIN[h % SKIN.length];
    this.hair = HAIR[(h >>> 8) % HAIR.length];
    this.small = !!state.parentId;

    this.name = new Text({ text: '', style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11, fontWeight: '600', fill: 0xffffff } });
    this.name.anchor.set(0.5, 1);
    this.bubbleText = new Text({
      text: '',
      style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11, fill: 0x1f2430, wordWrap: true, wordWrapWidth: 170 },
    });
    this.bubbleText.anchor.set(0.5, 1);
    this.bubble.addChild(this.bubbleBg, this.bubbleText);
    this.view.addChild(this.ring, this.body, this.namePlate, this.name, this.bubble);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.on('pointerover', () => this.setHover(true));
    this.view.on('pointerout', () => this.setHover(false));
    this.apply(state);
  }

  apply(state: AgentState): void {
    const changed = state.activity !== this.state.activity || state.detail !== this.state.detail;
    this.state = state;
    this.relabel();
    if (changed && state.detail) this.say(state.detail);
  }

  setSelected(on: boolean): void {
    this.selected = on;
    this.relabel();
  }

  private setHover(on: boolean): void {
    this.hover = on;
    this.relabel();
  }

  /** Agents on a break show just an icon so the kitchen does not drown in name plates. */
  private relabel(): void {
    const state = this.state;
    const compact = state.activity === 'idle' && !this.hover && !this.selected;
    const title = state.title.length > 26 ? state.title.slice(0, 25) + '…' : state.title;
    this.name.text = compact ? ICON.idle : `${ICON[state.activity]} ${title}`;
    this.namePlate.clear();
    this.namePlate
      .roundRect(-this.name.width / 2 - 6, -this.name.height - 2, this.name.width + 12, this.name.height + 4, 6)
      .fill({ color: 0x1f2430, alpha: 0.78 });
  }

  say(text: string, ms = 6000): void {
    this.bubbleText.text = text;
    const w = Math.min(190, this.bubbleText.width + 16);
    const hgt = this.bubbleText.height + 10;
    this.bubbleBg.clear();
    this.bubbleBg.roundRect(-w / 2, -hgt - 4, w, hgt, 8).fill({ color: 0xffffff, alpha: 0.96 });
    this.bubbleBg.poly([-5, -4, 5, -4, 0, 3]).fill({ color: 0xffffff, alpha: 0.96 });
    this.bubbleText.position.set(0, -9);
    this.bubbleUntil = performance.now() + ms;
  }

  walkTo(tile: Tile): void {
    if (this.target && this.target.x === tile.x && this.target.y === tile.y) return;
    this.target = tile;
    const from = { x: Math.round(this.pos.x - 0.5), y: Math.round(this.pos.y - 0.5) };
    this.path = findPath(from, tile).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
  }

  /** Skip the walk and appear at the destination right away. */
  teleport(): void {
    const last = this.path[this.path.length - 1];
    if (last) this.pos = { ...last };
    this.path = [];
  }

  get walking(): boolean {
    return this.path.length > 0;
  }

  /** Arrived at its desk and working there. */
  get seated(): boolean {
    return !this.walking && (this.state.activity === 'think' || this.state.activity === 'write' || this.state.activity === 'wait');
  }

  update(dt: number): void {
    this.t += dt;
    let step = SPEED * dt;
    while (step > 0 && this.path.length) {
      const next = this.path[0];
      const dx = next.x - this.pos.x;
      const dy = next.y - this.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= step) {
        this.pos = { ...next };
        this.path.shift();
        step -= dist;
      } else {
        this.pos = { x: this.pos.x + (dx / dist) * step, y: this.pos.y + (dy / dist) * step };
        step = 0;
      }
    }
    if (this.leaving && !this.walking) {
      this.view.alpha -= dt * 1.5;
      if (this.view.alpha <= 0) this.gone = true;
    }

    const s = iso(this.pos.x, this.pos.y);
    this.view.position.set(s.x, s.y);
    this.view.zIndex = depth(this.pos.x, this.pos.y) + 2;
    this.draw();

    const bubbleOn = performance.now() < this.bubbleUntil || this.state.activity === 'wait' || this.selected;
    this.bubble.visible = bubbleOn;
    const top = this.small ? -42 : this.seated ? -46 : -54;
    this.name.position.set(0, top);
    this.namePlate.position.set(0, top);
    this.bubble.position.set(0, top - 18);
  }

  private draw(): void {
    const g = this.body;
    const sc = this.small ? 0.78 : 1;
    const a = this.state.activity;
    const walking = this.walking;
    const seated = this.seated;
    const bob = walking ? Math.abs(Math.sin(this.t * 10)) * 2 : 0;
    const legSwing = walking ? Math.sin(this.t * 10) * 3 : 0;
    const sit = seated ? 6 : 0;
    const shirt = SOURCE_COLOR[this.state.source];

    g.clear();
    g.scale.set(sc);
    g.ellipse(0, 0, 11, 5).fill({ color: 0x000000, alpha: 0.18 });

    // Legs
    if (!seated) {
      g.roundRect(-5 + legSwing * 0.3, -12, 4, 12, 2).fill(0x2f3542);
      g.roundRect(1 - legSwing * 0.3, -12, 4, 12, 2).fill(0x2f3542);
    } else {
      g.roundRect(-6, -9, 12, 5, 2).fill(0x2f3542);
    }
    const y0 = -12 + sit - bob;
    // Body
    g.roundRect(-8, y0 - 17, 16, 18, 6).fill(shirt);
    // Arms
    const typing = seated && a === 'write' ? Math.sin(this.t * 24) * 1.5 : 0;
    if (a === 'wait' && seated) {
      g.roundRect(6, y0 - 34, 4, 18, 2).fill(shirt); // raised hand
      g.circle(8, y0 - 36, 3).fill(this.skin);
    } else {
      g.roundRect(-11, y0 - 15 + typing, 4, 12, 2).fill(shirt);
      g.roundRect(7, y0 - 15 - typing, 4, 12, 2).fill(shirt);
    }
    if (a === 'idle' && !walking) {
      g.roundRect(8, y0 - 8, 5, 6, 1).fill(0xffffff); // coffee
      g.rect(9, y0 - 7, 3, 1.5).fill(0x6f4e37);
    }
    // Head
    g.circle(0, y0 - 24, 8).fill(this.skin);
    g.ellipse(0, y0 - 29, 8.5, 5).fill(this.hair);
    if (a === 'wait') {
      const pulse = 1 + Math.sin(this.t * 6) * 0.12;
      g.circle(0, y0 - 46, 7 * pulse).fill(0xf59e0b);
      g.roundRect(-1.2, y0 - 50, 2.4, 6, 1).fill(0xffffff);
      g.circle(0, y0 - 42, 1.3).fill(0xffffff);
    }

    this.ring.clear();
    if (this.selected) this.ring.ellipse(0, 0, 16, 8).stroke({ width: 2, color: 0xffc56b });
  }
}

