import { Container, Graphics, Text } from 'pixi.js';
import { box, depth, diamond, iso } from './iso';
import type { Tile } from './layout';

/** The campus is part of the same world as the office, including camera fitting. */
export const CAMPUS_BOUNDS = { minX: 0, minY: 0, maxX: 32, maxY: 30 };

const TREES: Tile[] = [
  { x: 1, y: 19 }, { x: 8, y: 20 }, { x: 15, y: 20 }, { x: 23, y: 20 },
  { x: 30, y: 2 }, { x: 30, y: 12 }, { x: 26, y: 16 }, { x: 30, y: 21 },
];
const BENCHES: Tile[] = [{ x: 16, y: 22 }, { x: 21, y: 22 }, { x: 26, y: 12 }];
const TABLES: Tile[] = [{ x: 3, y: 20 }, { x: 6, y: 22 }];
const BIKE_RACK: Tile[] = [{ x: 18, y: 24 }, { x: 19, y: 24 }, { x: 20, y: 24 }];
const area = (x: number, y: number, w: number, h: number): Tile[] =>
  Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }));

/** Footprints shared with navigation; the central entrance and crossing stay clear. */
export const CAMPUS_OBSTACLES: Tile[] = [
  ...TREES, ...BENCHES.flatMap((t) => area(t.x, t.y, 2, 1)),
  ...TABLES.flatMap((t) => area(t.x, t.y, 2, 2)), ...BIKE_RACK,
  ...area(26, 6, 4, 4), { x: 2, y: 24 }, { x: 23, y: 24 },
];

const C = {
  stone: 0xd8d6c8, grout: 0xc6c7b9, grass: 0x9eaf8c, darkGrass: 0x8fa47e,
  timber: 0xb98661, metal: 0x394e49, leaf: 0x6e8d62, cream: 0xf0e6d2,
};

export function buildCampus(world: Container): { update(dt: number): void } {
  world.addChild(ground());
  const add = (t: Tile, draw: (g: Graphics) => void): Graphics => {
    const g = new Graphics();
    draw(g);
    g.zIndex = depth(t.x + 0.5, t.y + 0.5);
    world.addChild(g);
    return g;
  };

  for (const t of TREES) add(t, (g) => tree(g, t));
  for (const t of BENCHES) add(t, (g) => bench(g, t));
  for (const t of TABLES) add(t, (g) => cafeTable(g, t));
  for (const t of [{ x: 2, y: 24 }, { x: 23, y: 24 }]) add(t, (g) => lamp(g, t));
  for (const t of BIKE_RACK) add(t, (g) => bicycle(g, t));
  add({ x: 27.5, y: 7.5 }, pond);
  add({ x: 25, y: 2 }, (g) => {
    box(g, 25.1, 2.1, 0.14, 0.14, 40, C.metal);
    const p = iso(25.2, 2.2);
    g.roundRect(p.x - 26, p.y - 61, 72, 27, 4).fill(C.metal);
    const title = new Text({ text: 'САД →', style: { fontFamily: 'system-ui, sans-serif', fontSize: 10, fontWeight: '700', fill: C.cream, letterSpacing: 1 } });
    title.position.set(p.x - 20, p.y - 54);
    title.zIndex = depth(25.5, 2.5) + 1;
    world.addChild(title);
  });

  const car = new Container();
  const body = new Graphics();
  // A local-coordinate vehicle: reposition the container, never rebuild geometry per frame.
  diamond(body, -0.15, -0.1, 2.6, 1.2, 0x293b37, 0.15);
  box(body, 0, 0, 2.3, 1, 14, 0xc47755, 7);
  box(body, 0.6, 0.08, 1.05, 0.84, 16, 0xdfae85, 21);
  box(body, 0.64, 0.12, 0.9, 0.76, 1, 0x91b7b0, 37);
  for (const x of [0.4, 1.9]) {
    const p = iso(x, 1);
    body.ellipse(p.x, p.y - 6, 7, 9).fill(0x303a37);
    body.ellipse(p.x, p.y - 6, 3, 4).fill(0xbabfb6);
  }
  car.addChild(body);
  world.addChild(car);
  let elapsed = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const placeCar = () => {
    const x = -3 + (18 + elapsed * 1.4) % 38;
    const p = iso(x, 27.5);
    car.position.set(p.x, p.y);
    car.zIndex = depth(x + 1.2, 28);
    // Disappear at the block edges before wrapping, rather than teleporting mid-road.
    car.alpha = Math.max(0, Math.min(1, (x + 1) / 2, (32 - x) / 2));
  };
  placeCar();
  return {
    update(dt) {
      if (!reducedMotion.matches) elapsed += dt;
      placeCar();
    },
  };
}

function ground(): Container {
  const layer = new Container();
  const g = new Graphics();
  layer.addChild(g);
  layer.zIndex = -110000;
  // An outlined city block, with a quiet garden wrapping the east facade.
  box(g, 0, 18, 32, 12, 7, 0xb5bcae, -7);
  for (let y = 18; y < 25; y++) {
    for (let x = 0; x < 32; x++) diamond(g, x, y, 0.98, 0.98, (x + y) % 3 ? C.stone : 0xe1dfd2);
  }
  for (let y = 0; y < 18; y++) {
    for (let x = 24; x < 32; x++) diamond(g, x, y, 1, 1, (x + y) % 2 ? C.grass : C.darkGrass);
  }
  diamond(g, 24, 0, 1, 18, 0xd8d4bf);
  diamond(g, 24, 4, 8, 1.4, 0xe5dfcb);
  diamond(g, 28, 4, 1.4, 14, 0xe5dfcb);
  diamond(g, 24, 14, 8, 1.4, 0xe5dfcb);
  // Timber cafe deck, set apart from the entrance's pale paving.
  diamond(g, 1.5, 19, 6.5, 4.5, 0xc19a76);
  for (let y = 19; y < 23.5; y += 0.28) diamond(g, 1.5, y, 6.5, 0.035, 0x997957, 0.45);
  diamond(g, 10, 18, 3, 7, 0xeee9db);
  diamond(g, 10, 18, 0.08, 7, 0xb8b49d);
  diamond(g, 12.92, 18, 0.08, 7, 0xb8b49d);
  for (const t of TREES) diamond(g, t.x - 0.35, t.y - 0.35, 1.7, 1.7, C.darkGrass);
  diamond(g, 0, 25, 32, 4.5, 0x65736e);
  diamond(g, 0, 25, 32, 0.12, 0xf0e9d8);
  diamond(g, 0, 29.4, 32, 0.1, 0xe4decd);
  for (let x = 1; x < 32; x += 3) {
    if (x >= 10 && x < 13) continue;
    diamond(g, x, 27.2, 1.5, 0.08, 0xe1dcc6);
  }
  for (let y = 25.2; y < 29.2; y += 0.65) diamond(g, 10, y, 3, 0.32, 0xf3eddc);
  diamond(g, 10, 24.4, 3, 0.3, 0xd0af67);
  diamond(g, 10, 29.5, 3, 0.5, 0xd0af67);
  const label = new Text({ text: 'land.inc / ГОРОДСКОЙ ДВОР', style: { fontFamily: 'system-ui, sans-serif', fontSize: 12, fontWeight: '600', fill: 0x627364, letterSpacing: 2 } });
  const p = iso(18.5, 19.3);
  label.anchor.set(0.5);
  label.position.set(p.x, p.y);
  label.skew.set(-0.46, 0.46);
  layer.addChild(label);
  return layer;
}

function tree(g: Graphics, t: Tile): void {
  const p = iso(t.x + 0.5, t.y + 0.5);
  g.ellipse(p.x + 10, p.y + 2, 31, 13).fill({ color: 0x3c5745, alpha: 0.13 });
  box(g, t.x + 0.15, t.y + 0.15, 0.7, 0.7, 7, 0xadae94);
  g.moveTo(p.x, p.y - 6).lineTo(p.x, p.y - 61).stroke({ color: 0x7e6750, width: 7 });
  g.moveTo(p.x, p.y - 30).lineTo(p.x - 15, p.y - 50).stroke({ color: 0x7e6750, width: 4 });
  g.circle(p.x - 14, p.y - 56, 22).fill(0x62845e);
  g.circle(p.x + 15, p.y - 60, 23).fill(0x779568);
  g.circle(p.x, p.y - 79, 24).fill(0x88a675);
  g.circle(p.x - 9, p.y - 84, 12).fill({ color: 0xb4c68c, alpha: 0.45 });
}

function bench(g: Graphics, t: Tile): void {
  for (const x of [t.x + 0.2, t.x + 1.6]) box(g, x, t.y + 0.2, 0.12, 0.6, 10, C.metal);
  box(g, t.x, t.y + 0.15, 2, 0.65, 4, C.timber, 10);
  box(g, t.x, t.y + 0.1, 2, 0.12, 14, C.timber, 13);
}

function cafeTable(g: Graphics, t: Tile): void {
  box(g, t.x + 0.7, t.y + 0.7, 0.15, 0.15, 22, C.metal);
  box(g, t.x + 0.25, t.y + 0.25, 1.1, 1.1, 3, C.cream, 22);
  for (const d of [0, 1.5]) box(g, t.x + d, t.y + 0.55, 0.4, 0.55, 13, 0x8a9b7f);
  const p = iso(t.x + 0.8, t.y + 0.8);
  g.moveTo(p.x, p.y - 25).lineTo(p.x, p.y - 77).stroke({ color: C.metal, width: 3 });
  g.poly([p.x - 51, p.y - 65, p.x, p.y - 96, p.x + 51, p.y - 65, p.x, p.y - 43]).fill(0xe7c79c);
  g.poly([p.x, p.y - 96, p.x + 51, p.y - 65, p.x, p.y - 43]).fill(0xd7ad7f);
  g.moveTo(p.x - 51, p.y - 65).lineTo(p.x + 51, p.y - 65).stroke({ color: 0xf6e6c8, width: 1 });
}

function lamp(g: Graphics, t: Tile): void {
  const p = iso(t.x + 0.5, t.y + 0.5);
  box(g, t.x + 0.35, t.y + 0.35, 0.3, 0.3, 5, C.metal);
  g.moveTo(p.x, p.y - 4).lineTo(p.x, p.y - 80).lineTo(p.x + 14, p.y - 80).stroke({ color: C.metal, width: 3 });
  g.roundRect(p.x + 6, p.y - 83, 21, 6, 3).fill(C.metal);
  g.rect(p.x + 9, p.y - 77, 14, 3).fill(0xffe9ae);
}

function bicycle(g: Graphics, t: Tile): void {
  const p = iso(t.x + 0.5, t.y + 0.5);
  g.roundRect(p.x - 16, p.y - 19, 28, 22, 7).stroke({ color: 0x8c9a91, width: 3 });
  for (const dx of [-13, 13]) g.ellipse(p.x + dx, p.y - 8, 8, 10).stroke({ color: C.metal, width: 2 });
  g.moveTo(p.x - 13, p.y - 8).lineTo(p.x - 4, p.y - 22).lineTo(p.x + 5, p.y - 8).lineTo(p.x - 13, p.y - 8)
    .moveTo(p.x - 4, p.y - 22).lineTo(p.x + 8, p.y - 22).lineTo(p.x + 13, p.y - 8).stroke({ color: 0xb47254, width: 2 });
  g.moveTo(p.x + 8, p.y - 22).lineTo(p.x + 6, p.y - 28).lineTo(p.x + 12, p.y - 29).stroke({ color: C.metal, width: 2 });
}

function pond(g: Graphics): void {
  box(g, 26, 6, 4, 4, 8, 0xc9ccba);
  box(g, 26.18, 6.18, 3.64, 3.64, 1, 0x8fb6ad, 8);
  for (const [x, y] of [[27, 7], [28.5, 8.4], [26.8, 8.6]]) {
    const p = iso(x, y);
    g.ellipse(p.x, p.y - 10, 13, 5).stroke({ color: 0xc3ded1, width: 1.5, alpha: 0.7 });
  }
  diamond(g, 28.8, 6.5, 0.45, 0.45, 0x789a69);
  diamond(g, 29, 7, 0.55, 0.55, 0x789a69);
}
