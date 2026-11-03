import type { Graphics } from 'pixi.js';

/** Isometric tile size in pixels (2:1 diamond). */
export const TW = 64;
export const TH = 32;

/** Tile coordinates (x right-down, y left-down) to screen pixels. */
export function iso(x: number, y: number): { x: number; y: number } {
  return { x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) };
}

/** Draw order for something whose footprint is centred at tile point (cx, cy). */
export function depth(cx: number, cy: number): number {
  return (cx + cy) * 10;
}

export function shade(color: number, f: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((color >> 8) & 255) * f));
  const b = Math.min(255, Math.round((color & 255) * f));
  return (r << 16) | (g << 8) | b;
}

const pts = (...p: { x: number; y: number }[]) => p.flatMap((q) => [q.x, q.y]);
const up = (p: { x: number; y: number }, h: number) => ({ x: p.x, y: p.y - h });

/** Floor diamond of one tile area. */
export function diamond(g: Graphics, x: number, y: number, w: number, d: number, color: number, alpha = 1): void {
  g.poly(pts(iso(x, y), iso(x + w, y), iso(x + w, y + d), iso(x, y + d))).fill({ color, alpha });
}

/**
 * Axis-aligned box standing on the floor (or raised by `z`). Only the three
 * faces visible from the camera are drawn: top, +y (left-front), +x (right-front).
 */
export function box(g: Graphics, x: number, y: number, w: number, d: number, h: number, color: number, z = 0): void {
  const a = up(iso(x, y), z);
  const b = up(iso(x + w, y), z);
  const c = up(iso(x + w, y + d), z);
  const dd = up(iso(x, y + d), z);
  g.poly(pts(dd, c, up(c, h), up(dd, h))).fill(shade(color, 0.82));
  g.poly(pts(b, c, up(c, h), up(b, h))).fill(shade(color, 0.68));
  g.poly(pts(up(a, h), up(b, h), up(c, h), up(dd, h))).fill(color);
}

/** Flat quad on the back wall that runs along y = 0 (from x0 to x1, between heights h0 and h1). */
export function wallPanelX(g: Graphics, x0: number, x1: number, h0: number, h1: number, color: number, alpha = 1): void {
  const a = iso(x0, 0);
  const b = iso(x1, 0);
  g.poly(pts(up(a, h0), up(b, h0), up(b, h1), up(a, h1))).fill({ color, alpha });
}

/** Flat quad on the back wall that runs along x = 0 (from y0 to y1). */
export function wallPanelY(g: Graphics, y0: number, y1: number, h0: number, h1: number, color: number, alpha = 1): void {
  const a = iso(0, y0);
  const b = iso(0, y1);
  g.poly(pts(up(a, h0), up(b, h0), up(b, h1), up(a, h1))).fill({ color, alpha });
}
