import { Container, Graphics, Text } from 'pixi.js';
import { drawCharacter, type Look, type Pose } from './character';
import { depth, iso } from './iso';
import { findPath, type Tile } from './layout';
import { ResidentLife, type ResidentId, type ResidentState } from './resident-life';

export const RESIDENT_LOOKS: Record<ResidentId, Look & { name: string }> = {
  max: { name: 'Макс', kind: 'codex', civilian: true, shirt: 0xe5a14d, skin: 0xffdbac, hair: 0xffdbac, bald: true },
  rasul: { name: 'Расул', kind: 'codex', civilian: true, shirt: 0xb76c99, skin: 0xd4a276, hair: 0x171513 },
  vanya: { name: 'Ваня', kind: 'codex', civilian: true, shirt: 0x679bc0, skin: 0xf1c9a8, hair: 0x77513a, glasses: true },
};

class ResidentSprite {
  readonly view = new Container();
  private actor = new Container();
  private body = new Graphics();
  private props = new Graphics();
  private plate = new Graphics();
  private name: Text;
  private caption: Text;
  private hover = false;
  readonly state: ResidentState;
  constructor(state: ResidentState, world: Container, greet: () => void) {
    this.state = state;
    const look = RESIDENT_LOOKS[state.id];
    this.name = new Text({ text: `${look.name} · не ИИ`, style: { fontFamily: 'system-ui', fontSize: 11, fontWeight: '700', fill: 0x25352e } });
    this.caption = new Text({ text: '', style: { fontFamily: 'system-ui', fontSize: 10, fill: 0x42563e, wordWrap: true, wordWrapWidth: 180, align: 'center' } });
    this.name.anchor.set(0.5, 1); this.caption.anchor.set(0.5, 1);
    this.actor.addChild(this.body, this.props);
    this.view.addChild(this.actor, this.plate, this.name, this.caption);
    this.view.eventMode = 'static'; this.view.cursor = 'pointer';
    this.view.on('pointertap', greet);
    this.view.on('pointerover', () => { this.hover = true; });
    this.view.on('pointerout', () => { this.hover = false; });
    world.addChild(this.view);
  }

  paint(t: number, calm: boolean, zoom: number, speaker: boolean, socialSlot?: number): void {
    const r = this.state, look = RESIDENT_LOOKS[r.id], a = r.action;
    const acting = !r.moving;
    const age = calm ? 0.4 : r.age;
    const wave = Math.sin(age * 8), slow = Math.sin(age * 3);
    let expression: Pose['expression'];
    if (acting) {
      if (a === 'faces') expression = (['tongue', 'wink', 'grin', 'surprised'] as const)[Math.floor(age / 1.2) % 4];
      if (a === 'laugh' || a === 'cheer') expression = 'laugh';
      if (a === 'stumble') expression = 'surprised';
      if (a === 'recover') expression = 'dizzy';
      if (a === 'shrug' || a === 'highfive') expression = 'wink';
      if (a === 'flex') expression = 'grin';
    }
    this.body.clear(); this.props.clear();
    drawCharacter(this.body, look, { t: calm ? 0 : t, activity: acting && a === 'coffee' ? 'idle' : a === 'chat' || a === 'laugh' ? 'talk' : 'think', walking: r.moving && a !== 'scooter' && !calm, seated: false, busyFor: 0, expression });
    this.actor.scale.set(r.facing, 1);
    this.actor.rotation = 0; this.actor.position.set(0, a === 'scooter' ? -4 : 0);
    if (acting && !calm) {
      if (a === 'dance') { this.actor.rotation = wave * 0.14; this.actor.y = -Math.abs(wave) * 4; }
      if (a === 'laugh') { this.actor.rotation = slow * 0.07; this.actor.y = -Math.abs(wave); }
      if (a === 'balance') this.actor.rotation = slow * 0.27;
      if (a === 'stumble') { this.actor.rotation = Math.sin(Math.min(age, 1.5) / 1.5 * Math.PI) * 0.9 * r.facing; this.actor.y = 3 * Math.abs(slow); }
      if (a === 'recover') this.actor.rotation = Math.sin(age * 5) * Math.max(0, 0.25 - age * 0.06);
      if (a === 'sneak') this.actor.y = 3;
      if (a === 'breathe') this.actor.scale.y = 1 + slow * 0.035;
    }
    const g = this.props;
    const arm = (x: number, y: number, from = 9) => { g.moveTo(from, -18).lineTo(x, y).stroke({ width: 4, color: look.shirt }); g.circle(x, y, 3).fill(look.skin); };
    if (a === 'scooter') {
      g.circle(-17, 5, 4).fill(0x263331); g.circle(18, 5, 4).fill(0x263331);
      g.moveTo(-18, 1).lineTo(17, 1).lineTo(19, -24).lineTo(10, -24).stroke({ width: 3, color: 0x4a9b86 });
      arm(17, -24);
    }
    if (acting) {
      const handY = a === 'highfive' && socialSlot !== undefined ? socialSlot === 0 ? -29 : -45 : -37;
      if (a === 'wave' || a === 'highfive' || a === 'cheer') arm(a === 'highfive' ? 16 : 16 + wave * 2, handY);
      if (a === 'highfive' || a === 'cheer') {
        g.moveTo(19, handY - 5).lineTo(22, handY - 8).moveTo(23, handY).lineTo(27, handY).stroke({ width: 1.5, color: 0xe5a14d });
      }
      if (a === 'stretch' || a === 'flex' || a === 'shrug' || a === 'balance' || a === 'dance') {
        const height = a === 'stretch' ? -42 : a === 'flex' ? -32 : -23 + slow * 3;
        arm(17, height); arm(-17, height, -9);
      }
      if (a === 'polish') {
        arm(slow * 7, -43);
        g.moveTo(-13, -43).lineTo(-17, -46).moveTo(-14, -48).lineTo(-14, -40).stroke({ width: 1.5, color: 0xf7cf6b });
      }
      if (a === 'faces') { arm(14, -28); arm(-14, -28, -9); }
      if (a === 'glasses') arm(9, -29);
      if (a === 'yawn') { arm(2, -22); g.ellipse(1, -23, 3, 4).fill(0x7f1d1d); }
      if (a === 'phone') {
        arm(15, -23); g.roundRect(12, -32, 8, 13, 2).fill(0x263331); g.rect(13, -30, 6, 8).fill(0x9dd8cf);
      }
      if (a === 'read') { arm(10, -17); g.poly([0, -23, 10, -21, 20, -23, 20, -12, 10, -10, 0, -12]).fill(0xfff3dc).stroke({ width: 1, color: 0x96693f }); }
      if (a === 'snack') { arm(13, -22); g.circle(14, -24, 5).fill(0xc99b57); for (const [x, y] of [[12, -25], [15, -22], [16, -26]]) g.circle(x, y, 0.9).fill(0x694632); }
      if (a === 'juggle') for (let i = 0; i < 3; i++) {
        const angle = age * 4 + i * Math.PI * 2 / 3;
        g.circle(Math.cos(angle) * 18, -32 - Math.abs(Math.sin(angle)) * 20, 3.6).fill(i === 1 ? 0x82ae61 : 0xf0a13e);
      }
      if (a === 'dumbbell' || a === 'pocket') {
        // The weight travels from the trouser pocket to the hand before the curls.
        const lift = a === 'pocket' ? Math.min(1, age / 1.5) : (slow + 1) / 2;
        const putAway = r.text.includes('Убирает') || r.text.includes('снова в кармане');
        const p = putAway ? 1 - lift : lift;
        const x = 10 + p * 6, y = -8 - p * 23;
        arm(x, y);
        g.moveTo(x - 8, y).lineTo(x + 8, y).stroke({ width: 3, color: 0xaeb9bd });
        g.roundRect(x - 11, y - 6, 5, 12, 1).fill(0x34444d); g.roundRect(x + 6, y - 6, 5, 12, 1).fill(0x34444d);
      }
      if (a === 'help' || a === 'spot') { arm(19, -20 + slow * 3); arm(-15, -23, -9); }
      if (a === 'recover') for (let i = 0; i < 3; i++) g.circle(Math.cos(age * 3 + i * 2) * 15, -47 + Math.sin(age * 3 + i * 2) * 3, 1.8).fill(0xf3c75f);
    }
    const labelY = -52 - (socialSlot ?? 0) * 17;
    const detail = this.hover || socialSlot === undefined && speaker && zoom >= 0.8;
    this.name.y = labelY;
    this.caption.text = r.moving ? a === 'scooter' ? r.text : `${look.name} гуляет по офису` : r.text;
    this.caption.y = labelY - 18;
    this.caption.visible = detail;
    this.plate.clear();
    this.plate.roundRect(-this.name.width / 2 - 6, labelY - 16, this.name.width + 12, 20, 5).fill({ color: 0xfaf9f5, alpha: 0.95 });
    if (detail) this.plate.roundRect(-96, this.caption.y - this.caption.height - 5, 192, this.caption.height + 8, 5).fill({ color: 0xfaf9f5, alpha: 0.95 });
    this.view.position.copyFrom(iso(r.x, r.y)); this.view.zIndex = depth(r.x, r.y) + 5;
  }
}

/** Three permanent, entirely local residents. Daemon snapshots never remove them. */
export class OfficeResidents {
  readonly life: ResidentLife;
  private sprites: ResidentSprite[];
  private t = 0;
  private zoom = 1;
  private calm = false;
  private enabled = true;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  constructor(world: Container, random = Math.random) {
    this.life = new ResidentLife(findPath, random);
    this.sprites = this.life.people.map((r) => new ResidentSprite(r, world, () => this.life.greet(r.id)));
    this.update(0, []);
  }
  setZoom(zoom: number): void { this.zoom = zoom; }
  setMode(mode: 'on' | 'calm' | 'off'): void {
    this.enabled = mode !== 'off';
    this.calm = mode === 'calm';
    for (const s of this.sprites) s.view.visible = this.enabled;
  }
  update(dt: number, agents: Tile[]): void {
    if (!this.enabled) return;
    this.t += dt;
    const isCalm = this.calm || this.reducedMotion.matches;
    this.life.update(dt, agents, isCalm);
    const cast = this.life.scene && !this.life.scene.gathering ? this.life.people.filter((r) => this.life.participants.includes(r.id)) : [];
    this.sprites.forEach((sprite, i) => sprite.paint(this.t, isCalm, this.zoom, Math.floor(this.t / 6) % 3 === i, cast.includes(sprite.state) ? cast.indexOf(sprite.state) : undefined));
  }
}
