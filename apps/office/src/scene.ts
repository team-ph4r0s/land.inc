import { Container, Graphics, Text } from 'pixi.js';
import { box, depth, diamond, iso, shade, wallPanelX, wallPanelY } from './iso';
import {
  COFFEE_TABLE, COUNTER, DESKS, DOOR, GLASS, H, KIOSKS, MEETING_TABLE, PLANTS, RACKS, RECEPTION, SHELVES, SOFA, W,
  type Desk, type Tile,
} from './layout';

const WALL_H = 96;

export interface DeskView {
  desk: Desk;
  screen: Graphics;
}

export interface Scene {
  desks: DeskView[];
  racks: Graphics[];
  /** Cork board on the left wall: the task board. */
  board: Graphics;
}

/** Static office: floor, walls and furniture. Each furniture tile is its own depth-sorted node. */
export function buildScene(world: Container): Scene {
  world.addChild(floor());
  world.addChild(walls());
  const board = new Graphics();
  board.zIndex = -89000;
  board.eventMode = 'static';
  board.cursor = 'pointer';
  drawBoard(board, 0);
  const title = new Text({ text: 'ЗАДАЧИ', style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 10, fontWeight: '800', fill: 0x5b3a1e, letterSpacing: 1.5 } });
  const tp = iso(0, 9.7);
  title.anchor.set(0.5);
  title.position.set(tp.x, tp.y - 79);
  title.skew.set(0, -0.46);
  title.zIndex = board.zIndex + 1;
  world.addChild(title);
  world.addChild(board);

  const add = (t: Tile, draw: (g: Graphics) => void, lift = 0) => {
    const g = new Graphics();
    draw(g);
    g.zIndex = depth(t.x + 0.5, t.y + 0.5) + lift;
    world.addChild(g);
    return g;
  };

  for (const t of SHELVES) add(t, (g) => shelf(g, t));
  const racks = RACKS.map((t) => add(t, (g) => rack(g, t)));
  for (const t of GLASS) add(t, (g) => glass(g, t));
  for (const t of KIOSKS) add(t, (g) => kiosk(g, t));
  for (const t of MEETING_TABLE) add(t, (g) => box(g, t.x, t.y, 1, 1, 22, 0x8a6a4f));
  for (const t of COUNTER) add(t, (g) => counter(g, t, t.y === 14));
  for (const t of SOFA) add(t, (g) => sofa(g, t));
  for (const t of PLANTS) add(t, (g) => plant(g, t));
  for (const t of RECEPTION) add(t, (g) => {
    box(g, t.x, t.y, 1, 0.7, 28, 0x526b60);
    box(g, t.x - 0.04, t.y - 0.04, 1.08, 0.78, 3, 0xeadcc2, 28);
    for (let i = 0; i < 5; i++) box(g, t.x + i * 0.2, t.y + 0.69, 0.035, 0.025, 23, 0x94aa92);
  });
  for (const t of COFFEE_TABLE) add(t, (g) => {
    box(g, t.x + 0.1, t.y + 0.1, 0.8, 0.8, 13, 0xb98662);
    box(g, t.x + 0.2, t.y + 0.2, 0.32, 0.42, 1, 0xf3e9d4, 13);
  });
  for (const d of DESKS) add(d.seat, (g) => chair(g, d.seat));
  for (const x of [19, 20, 21]) {
    add({ x, y: 8 }, (g) => chair(g, { x, y: 8 }, 0xb78366));
    add({ x, y: 11 }, (g) => chair(g, { x, y: 11 }, 0xb78366));
  }

  const desks = DESKS.map((d) => {
    const screen = new Graphics();
    const g = add(d, (g) => deskBody(g, d));
    const s = iso(d.x + 0.5, d.y + 0.5);
    // Monitor on the far side of the desk, facing the seat.
    screen.poly([s.x - 13, s.y - 44, s.x + 9, s.y - 33, s.x + 9, s.y - 19, s.x - 13, s.y - 30]).fill(0xffffff);
    screen.tint = 0x1b2330;
    screen.zIndex = g.zIndex + 1;
    world.addChild(screen);
    return { desk: d, screen };
  });

  return { desks, racks, board };
}

function floor(): Container {
  const layer = new Container();
  const g = new Graphics();
  layer.addChild(g);
  // A raised cutaway slab gives the building a clear edge against the city.
  box(g, 0, 0, W, H, 9, 0xc1b9a8, -9);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c = (x + y) % 2 ? 0xeadfc9 : 0xe5d8c0;
      if (x >= 17 && y <= 5) c = (x + y) % 2 ? 0xa6afa9 : 0x9da8a1; // server room
      else if (x >= 17 && y >= 7 && y <= 12) c = 0xc3ccc0; // meeting carpet
      else if (x <= 6 && y >= 12) c = (x + y) % 2 ? 0xe0d9c8 : 0xdad3c1; // kitchen
      else if (y <= 1 && x <= 7) c = 0xcac5b5; // archive
      diamond(g, x + 0.01, y + 0.01, 0.98, 0.98, c);
      // Narrow timber boards, rather than a checkerboard across the whole room.
      if (x > 2 && x < 18 && y > 2 && y < 13) {
        diamond(g, x, y + 0.48, 1, 0.025, 0xcab89a, 0.38);
      }
    }
  }
  for (const x of [3.6, 8.6, 13.6]) {
    diamond(g, x, 3.5, 3.8, 8.6, 0x91a99b);
    diamond(g, x + 0.12, 3.62, 3.56, 8.36, 0xc7d2bf);
    for (let y = 3.8; y < 12; y += 0.36) diamond(g, x + 0.2, y, 3.4, 0.018, 0x9caf9d, 0.4);
  }
  diamond(g, 2.4, 13.2, 4.7, 3.8, 0xcc9e7e);
  diamond(g, 17.7, 7.4, 5.4, 5, 0x7c9688);
  diamond(g, DOOR.x - 0.5, DOOR.y + 0.15, 2, 0.85, 0x526b60);
  diamond(g, 10.5, 13.2, 1.9, 3.3, 0xf4ecd9);
  layer.zIndex = -100000;
  label(layer, 'АРХИВ', 3.5, 2.2);
  label(layer, 'СЕРВЕРНАЯ', 20.5, 2.4);
  label(layer, 'ИНТЕРНЕТ', 2.2, 7.4);
  label(layer, 'СТУДИЯ / 18 МЕСТ', 11, 12.7);
  label(layer, 'ПЕРЕГОВОРКА', 20.5, 12.6);
  label(layer, 'КОФЕ И ПАУЗА', 4.5, 17.4);
  label(layer, 'РЕСЕПШН', 15, 16.7);
  label(layer, 'ВХОД', DOOR.x + 0.5, DOOR.y + 0.5);
  return layer;
}

function label(parent: Container, text: string, x: number, y: number): void {
  const t = new Text({ text, style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11, fontWeight: '700', fill: 0x000000, letterSpacing: 2 } });
  const p = iso(x, y);
  t.anchor.set(0.5);
  t.position.set(p.x, p.y);
  t.alpha = 0.38;
  t.skew.set(-0.46, 0.46);
  parent.addChild(t);
}

function walls(): Container {
  const layer = new Container();
  const g = new Graphics();
  layer.addChild(g);
  wallPanelX(g, 0, W, 0, WALL_H, 0xf5f0e3);
  wallPanelY(g, 0, H, 0, WALL_H, 0xe7e8db);
  wallPanelX(g, 17.5, W, 0, WALL_H, 0x435d56);
  // Timber acoustic wall in the archive, with a continuous picture rail.
  wallPanelX(g, 0.3, 7.3, 8, 89, 0xc29b73);
  for (let x = 0.4; x < 7.3; x += 0.23) wallPanelX(g, x, x + 0.035, 8, 89, 0x9c7653);
  wallPanelY(g, 0, H, 84, 87, 0xc5ba9f);
  wallPanelX(g, 0, W, WALL_H, WALL_H + 6, 0xfaf6f0);
  wallPanelY(g, 0, H, WALL_H, WALL_H + 6, 0xf3ede4);
  wallPanelX(g, 0, W, 0, 6, 0xb9a98f); // skirting
  wallPanelY(g, 0, H, 0, 6, 0xae9e85);
  // Whiteboard
  wallPanelX(g, 8.8, 12.2, 26, 74, 0x9aa3ad);
  wallPanelX(g, 9, 12, 29, 71, 0xfdfdfb);
  for (const [x0, x1, h, c] of [[9.3, 10.6, 62, 0x3b82f6], [9.3, 11.4, 54, 0xef4444], [9.3, 10.1, 46, 0x22c55e], [10.4, 11.6, 38, 0x3b82f6]] as const)
    wallPanelX(g, x0, x1, h, h + 2.5, c);
  // Windows over the internet corner and the kitchen
  for (const [y0, y1] of [[3.6, 6.4], [12.6, 16.4]] as const) {
    wallPanelY(g, y0, y1, 24, 82, 0x526b60);
    wallPanelY(g, y0 + 0.1, y1 - 0.1, 27, 79, 0xb5d0cd);
    wallPanelY(g, y0 + 0.15, y1 - 0.15, 28, 44, 0xcde0ce);
    wallPanelY(g, (y0 + y1) / 2 - 0.04, (y0 + y1) / 2 + 0.04, 33, 77, 0x8b9bb0);
  }
  // Ceiling lights are represented on the rear wall to keep people unobscured.
  for (const x of [8.3, 12.7, 16.8]) {
    wallPanelX(g, x, x + 0.6, 82, 86, 0xc3a574);
    wallPanelX(g, x + 0.04, x + 0.56, 80, 82, 0xffedbc);
  }
  // Company sign
  wallPanelX(g, 13.4, 16.2, 52, 76, 0x4c584c);
  const sign = new Text({ text: 'land.inc', style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 15, fontWeight: '800', fill: 0xe6e6d9 } });
  const s = iso(14.8, 0);
  sign.anchor.set(0.5);
  sign.position.set(s.x, s.y - 64);
  sign.skew.set(0, 0.46);
  layer.addChild(sign);
  layer.zIndex = -90000;
  return layer;
}

/** Cork board with one sticky note per running task (up to eight). */
export function drawBoard(g: Graphics, running: number): void {
  g.clear();
  wallPanelY(g, 8.1, 11.3, 22, 72, 0x7a5a3e);
  wallPanelY(g, 8.25, 11.15, 25, 69, 0xc89f72);
  const colors = [0xfde047, 0xf9a8d4, 0x86efac, 0x93c5fd];
  for (let i = 0; i < Math.min(running, 8); i++) {
    const y0 = 8.45 + (i % 4) * 0.68;
    const h0 = i < 4 ? 46 : 30;
    wallPanelY(g, y0, y0 + 0.5, h0, h0 + 14, colors[i % colors.length]);
    wallPanelY(g, y0 + 0.22, y0 + 0.28, h0 + 12, h0 + 14.5, 0xef4444); // pin
  }
  if (!running) wallPanelY(g, 9.3, 10.1, 38, 52, 0xfdfdfb, 0.7);
}

function deskBody(g: Graphics, d: Tile): void {
  // Slender legs and a floating oak surface replace solid storage cubes.
  for (const [dx, dy] of [[0.12, 0.16], [0.82, 0.16], [0.12, 0.8], [0.82, 0.8]])
    box(g, d.x + dx, d.y + dy, 0.06, 0.06, 20, 0x52605a);
  box(g, d.x + 0.04, d.y + 0.08, 0.94, 0.86, 3, 0xd8b58a, 20);
  box(g, d.x + 0.08, d.y + 0.15, 0.24, 0.58, 14, 0xe8e1cf, 3);
  const s = iso(d.x + 0.5, d.y + 0.5);
  g.poly([s.x - 15, s.y - 46, s.x + 11, s.y - 33, s.x + 11, s.y - 17, s.x - 15, s.y - 30]).fill(0x2a2f3a); // monitor frame
  g.rect(s.x - 3, s.y - 24, 4, 6).fill(0x2a2f3a);
  g.poly([s.x + 2, s.y - 18, s.x + 14, s.y - 12, s.x + 8, s.y - 9, s.x - 4, s.y - 15]).fill(0x3a3f4a); // keyboard
  g.circle(s.x + 18, s.y - 22, 3).fill(0xf5f5f5); // mug
  g.circle(s.x + 18, s.y - 23, 1.8).fill(0x98694d);
  g.moveTo(s.x + 11, s.y - 40).lineTo(s.x + 18, s.y - 51).lineTo(s.x + 23, s.y - 49).stroke({ width: 2, color: 0x53645c });
}

function chair(g: Graphics, t: Tile, color = 0x5b756b): void {
  const p = iso(t.x + 0.5, t.y + 0.5);
  g.ellipse(p.x, p.y + 2, 12, 5).fill({ color: 0x33443b, alpha: 0.12 });
  g.moveTo(p.x, p.y).lineTo(p.x, p.y - 10).stroke({ width: 2, color: 0x53605a });
  box(g, t.x + 0.2, t.y + 0.2, 0.58, 0.58, 4, color, 10);
  box(g, t.x + 0.2, t.y + 0.7, 0.58, 0.12, 16, shade(color, 0.9), 10);
}

function shelf(g: Graphics, t: Tile): void {
  box(g, t.x + 0.05, t.y + 0.1, 0.9, 0.45, 70, 0x7a5a3e);
  const colors = [0xe76f51, 0x2a9d8f, 0xe9c46a, 0x264653, 0xf4a261, 0x8ab17d];
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 4; i++) {
      const x = t.x + 0.12 + i * 0.2;
      const h = 14 + ((t.x * 7 + row * 3 + i * 5) % 6);
      box(g, x, t.y + 0.55, 0.14, 0.02, h, colors[(t.x + row * 2 + i) % colors.length], 6 + row * 21);
    }
  }
}

function rack(g: Graphics, t: Tile): void {
  box(g, t.x + 0.1, t.y + 0.15, 0.8, 0.7, 78, 0x2b303b);
  const f = iso(t.x + 0.9, t.y + 0.85);
  for (let i = 0; i < 6; i++) g.rect(f.x - 20, f.y - 70 + i * 11, 3, 2).fill(i % 2 ? 0x22c55e : 0x60a5fa);
}

function glass(g: Graphics, t: Tile): void {
  const a = iso(t.x + 0.5, t.y);
  const b = iso(t.x + 0.5, t.y + 1);
  g.poly([a.x, a.y, b.x, b.y, b.x, b.y - 70, a.x, a.y - 70]).fill({ color: 0xcadad1, alpha: 0.35 });
  g.moveTo(a.x, a.y - 70).lineTo(b.x, b.y - 70).stroke({ width: 2, color: 0x8b9bb0 });
  g.moveTo(a.x, a.y).lineTo(a.x, a.y - 70).stroke({ width: 1.5, color: 0x526b60 });
  g.moveTo(a.x, a.y - 30).lineTo(b.x, b.y - 30).stroke({ width: 5, color: 0xe6ede2, alpha: 0.5 });
}

function kiosk(g: Graphics, t: Tile): void {
  box(g, t.x + 0.15, t.y + 0.15, 0.6, 0.7, 26, 0x5b6474);
  const s = iso(t.x + 0.45, t.y + 0.5);
  g.circle(s.x, s.y - 44, 10).fill(0x38bdf8);
  g.ellipse(s.x, s.y - 44, 4, 10).stroke({ width: 1.2, color: 0xe0f2fe });
  g.moveTo(s.x - 10, s.y - 44).lineTo(s.x + 10, s.y - 44).stroke({ width: 1.2, color: 0xe0f2fe });
}

function counter(g: Graphics, t: Tile, coffee: boolean): void {
  box(g, t.x + 0.05, t.y + 0.02, 0.8, 0.96, 26, 0xf2efe9);
  if (coffee) {
    box(g, t.x + 0.2, t.y + 0.3, 0.4, 0.4, 24, 0x4c584c, 26);
    const s = iso(t.x + 0.6, t.y + 0.7);
    g.circle(s.x, s.y - 40, 2.5).fill(0xef4444);
  }
}

function sofa(g: Graphics, t: Tile): void {
  const c = 0xd5aa85;
  box(g, t.x, t.y + 0.15, 1, 0.8, 12, c);
  box(g, t.x, t.y + 0.7, 1, 0.25, 26, shade(c, 0.9));
  box(g, t.x + 0.12, t.y + 0.25, 0.76, 0.4, 3, 0xe1b995, 12);
  box(g, t.x + 0.15, t.y + 0.61, 0.3, 0.12, 10, 0x778f7d, 15);
}

function plant(g: Graphics, t: Tile): void {
  box(g, t.x + 0.3, t.y + 0.3, 0.4, 0.4, 14, 0xb5651d);
  const s = iso(t.x + 0.5, t.y + 0.5);
  for (const [dx, dy, r, c] of [[0, -30, 10, 0x647c59], [-7, -24, 8, 0x78906b], [7, -22, 8, 0x78906b], [0, -38, 7, 0x91a582]] as const)
    g.circle(s.x + dx, s.y + dy, r).fill(c);
}
