import { Container, Graphics, Text } from 'pixi.js';
import { describeModel, type Activity, type AgentState } from '@land/protocol';
import { drawCharacter, KIND_SCALE, type Look } from './character';
import { depth, iso } from './iso';
import { findPath, type Tile } from './layout';

const SPEED = 2.6; // tiles per second
const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const HAIR = [0x2b1d14, 0x5a3825, 0xb5651d, 0x1c1c1c, 0xd4a017, 0x8e44ad, 0x7f8c8d];
export const SOURCE_COLOR: Record<AgentState['source'], number> = { claude: 0xd97757, codex: 0x10a37f, antigravity: 0x4285f4, demo: 0x7c6ff0 };

export const ICON: Record<Activity, string> = {
  think: '💭', write: '⌨️', read: '📖', bash: '🖥️', web: '🌐', plan: '📋', talk: '💬', wait: '✋', idle: '☕',
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** icon: just the activity icon; name: icon and title; full: and the model with its effort. */
export type Detail = 'icon' | 'name' | 'full';

/** Mood from a test run shows for this long after the run finished. */
const MOOD_MS = 90_000;

/** One agent in the office: a little dude that walks tile to tile and acts out its activity. */
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
  /** How much the name plate says at the current zoom; see Office.setZoom. */
  private detail: Detail = 'full';
  /** Another plate is in the way: shrink to the icon unless this agent is the one in focus. */
  private crowded = false;
  /** Size of the plate when shown in full, kept so overlap checks need not re-render it. */
  private fullBox = { x: 0, y: 0, width: 0, height: 0 };

  private path: Tile[] = [];
  private body = new Graphics();
  private ring = new Graphics();
  private name: Text;
  private modelText: Text;
  private namePlate = new Graphics();
  private top = -54;
  /** When the current activity started (performance.now). */
  private since = performance.now();
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
    this.modelText = new Text({ text: '', style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 9, fontWeight: '600', fill: 0xffc56b } });
    this.modelText.anchor.set(0.5, 1);
    this.bubbleText = new Text({
      text: '',
      style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11, fill: 0x1f2430, wordWrap: true, wordWrapWidth: 170 },
    });
    this.bubbleText.anchor.set(0.5, 1);
    this.bubble.addChild(this.bubbleBg, this.bubbleText);
    this.view.addChild(this.ring, this.body, this.namePlate, this.name, this.modelText, this.bubble);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.on('pointerover', () => this.setHover(true));
    this.view.on('pointerout', () => this.setHover(false));
    this.apply(state);
  }

  apply(state: AgentState): void {
    const changed = state.activity !== this.state.activity || state.detail !== this.state.detail;
    if (state.activity !== this.state.activity) this.since = performance.now();
    this.state = state;
    this.small = !!state.parentId;
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
  setDetail(detail: Detail): void {
    if (detail === this.detail) return;
    this.detail = detail;
    this.relabel();
  }

  setCrowded(on: boolean): void {
    if (on === this.crowded) return;
    this.crowded = on;
    this.relabel();
  }

  /** In focus: selected or under the pointer. Such a plate is always shown in full. */
  get focused(): boolean {
    return this.selected || this.hover;
  }

  /** Where the plate would be, shown in full, in world coordinates: for overlap checks. */
  plateRect(): { x: number; y: number; w: number; h: number } {
    const b = this.fullBox;
    return { x: this.view.x + b.x, y: this.view.y + this.namePlate.y + b.y, w: b.width, h: b.height };
  }

  private relabel(): void {
    const state = this.state;
    const compact = !this.focused && (state.activity === 'idle' || this.detail === 'icon' || this.crowded);
    const title = state.title.length > 26 ? state.title.slice(0, 25) + '…' : state.title;
    const pin = state.taskId ? '📌 ' : '';
    // A compact plate still says what the agent is doing: a waiting hand must not look like a coffee break.
    this.name.text = compact ? ICON[state.activity] : `${ICON[state.activity]} ${pin}${title}`;
    const model = describeModel(state.source, state.model).label;
    this.modelText.text = compact || (this.detail === 'name' && !this.focused) ? '' : state.effort ? `${model} · ${state.effort}` : model;
    const w = Math.max(this.name.width, this.modelText.width);
    const h = this.name.height + (this.modelText.text ? this.modelText.height : 0);
    this.namePlate.clear();
    this.namePlate.roundRect(-w / 2 - 6, -h - 2, w + 12, h + 4, 6).fill({ color: 0x1f2430, alpha: 0.8 });
    if (!this.crowded || this.focused) this.fullBox = { x: -w / 2 - 6, y: -h - 2, width: w + 12, height: h + 4 };
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
    const route = findPath(from, tile);
    this.path = route.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
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
    const top = this.top - 4;
    const modelH = this.modelText.text ? this.modelText.height : 0;
    this.modelText.position.set(0, top);
    this.name.position.set(0, top - modelH);
    this.namePlate.position.set(0, top);
    this.bubble.position.set(0, top - modelH - this.name.height - 6);
  }

  private draw(): void {
    const g = this.body;
    const info = describeModel(this.state.source, this.state.model);
    const look: Look = { kind: info.kind, shirt: SOURCE_COLOR[this.state.source], skin: this.skin, hair: this.hair };
    const sc = (this.small ? 0.78 : 1) * (KIND_SCALE[info.kind] ?? 1);
    const mood = this.state.mood && Date.now() - (this.state.moodAt ?? 0) < MOOD_MS ? this.state.mood : undefined;
    g.clear();
    g.scale.set(sc);
    const top = drawCharacter(g, look, {
      t: this.t,
      activity: this.state.activity,
      walking: this.walking,
      seated: this.seated,
      mood,
      busyFor: (performance.now() - this.since) / 1000,
    });
    this.top = top * sc;

    this.ring.clear();
    if (this.selected) this.ring.ellipse(0, 0, 16, 8).stroke({ width: 2, color: 0xffc56b });
  }
}

