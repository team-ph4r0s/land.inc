import type { Activity } from '@land/protocol';

/** Office floor plan in tile coordinates. */
export const W = 24;
export const H = 18;
export const DOOR = { x: 11, y: H - 1 };
export const HOME = { x: 14, y: H + 3 };

export interface Tile {
  x: number;
  y: number;
}

export interface Desk extends Tile {
  /** Where the owner sits (in front of the desk). */
  seat: Tile;
}

export type Zone = 'archive' | 'server' | 'internet' | 'board' | 'meeting' | 'kitchen' | 'desk';

export const ZONE_OF: Record<Activity, Zone> = {
  think: 'desk',
  write: 'desk',
  wait: 'desk',
  read: 'archive',
  bash: 'server',
  web: 'internet',
  plan: 'board',
  talk: 'meeting',
  idle: 'kitchen',
};

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const DESKS: Desk[] = [4, 7, 10].flatMap((y) =>
  [4, 6, 8, 10, 12, 14].map((x) => ({ x, y, seat: { x, y: y + 1 } })),
);

/** Tiles occupied by furniture; everything else is walkable. */
export const SHELVES: Tile[] = range(1, 6).map((x) => ({ x, y: 0 }));
export const RACKS: Tile[] = [...range(19, 23).map((x) => ({ x, y: 0 })), ...range(20, 23).map((x) => ({ x, y: 3 }))];
export const GLASS: Tile[] = range(0, 3).map((y) => ({ x: 17, y }));
export const KIOSKS: Tile[] = range(4, 6).map((y) => ({ x: 0, y }));
export const MEETING_TABLE: Tile[] = range(19, 21).flatMap((x) => [9, 10].map((y) => ({ x, y })));
export const COUNTER: Tile[] = range(13, 16).map((y) => ({ x: 0, y }));
export const SOFA: Tile[] = range(3, 5).map((x) => ({ x, y: 16 }));
export const PLANTS: Tile[] = [
  { x: 0, y: 0 },
  { x: 16, y: 0 },
  { x: 0, y: 9 },
  { x: 15, y: 13 },
  { x: 23, y: 7 },
  { x: 23, y: 13 },
];

export const SPOTS: Record<Exclude<Zone, 'desk'>, Tile[]> = {
  archive: range(1, 6).map((x) => ({ x, y: 1 })),
  server: [...range(19, 23).map((x) => ({ x, y: 1 })), ...range(20, 23).map((x) => ({ x, y: 4 }))],
  internet: range(4, 6).map((y) => ({ x: 1, y })),
  board: range(9, 12).map((x) => ({ x, y: 1 })),
  meeting: [
    ...range(19, 21).map((x) => ({ x, y: 8 })),
    ...range(19, 21).map((x) => ({ x, y: 11 })),
    { x: 18, y: 9 },
    { x: 18, y: 10 },
    { x: 22, y: 9 },
    { x: 22, y: 10 },
  ],
  kitchen: [...range(13, 16).map((y) => ({ x: 1, y })), ...range(3, 5).map((x) => ({ x, y: 15 })), { x: 2, y: 13 }, { x: 2, y: 14 }],
};

const key = (t: Tile) => t.y * W + t.x;
const blocked = new Set<number>(
  [...DESKS, ...SHELVES, ...RACKS, ...GLASS, ...KIOSKS, ...MEETING_TABLE, ...COUNTER, ...SOFA, ...PLANTS].map(key),
);

export function walkable(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < W && y < H && !blocked.has(y * W + x);
}

/** Shortest 8-directional path (no corner cutting) from a to b, excluding a. */
export function findPath(a: Tile, b: Tile): Tile[] {
  if (a.x === b.x && a.y === b.y) return [];
  const prev = new Map<number, number>();
  const start = key(a);
  const goal = key(b);
  const queue = [start];
  prev.set(start, -1);
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (cur === goal) break;
    const cx = cur % W;
    const cy = Math.floor(cur / W);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!walkable(nx, ny) && !(nx === b.x && ny === b.y)) continue;
      if (dx && dy && (!walkable(cx + dx, cy) || !walkable(cx, cy + dy))) continue;
      const k = ny * W + nx;
      if (prev.has(k)) continue;
      prev.set(k, cur);
      queue.push(k);
    }
  }
  if (!prev.has(goal)) return [b];
  const path: Tile[] = [];
  for (let k = goal; k !== start; k = prev.get(k)!) path.push({ x: k % W, y: Math.floor(k / W) });
  return path.reverse();
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
