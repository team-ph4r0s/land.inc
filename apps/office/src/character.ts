import type { Graphics } from 'pixi.js';
import type { Activity, ModelInfo, Mood } from '@land/protocol';

/** How a character looks: fixed for the agent's lifetime (the model can still change it). */
export interface Look {
  kind: ModelInfo['kind'];
  shirt: number;
  skin: number;
  hair: number;
  bald?: boolean;
  glasses?: boolean;
  civilian?: boolean;
}

/** What it is doing this frame. */
export interface Pose {
  t: number;
  activity: Activity;
  walking: boolean;
  seated: boolean;
  mood?: Mood;
  /** Seconds spent in the current activity. */
  busyFor: number;
  expression?: 'grin' | 'tongue' | 'wink' | 'laugh' | 'surprised' | 'dizzy';
}

const INK = 0x1f2430;

/** Body scale per model: Haiku and the auto-reviewer are the small ones. */
export const KIND_SCALE: Partial<Record<ModelInfo['kind'], number>> = { haiku: 0.86, reviewer: 0.78 };

/**
 * Draw a big-headed office dude, feet at (0, 0). The silhouette and one accessory
 * tell the model apart; the face and the little emotes tell what it is going through.
 * Returns the y of the top of the drawing, for placing the name plate.
 */
export function drawCharacter(g: Graphics, look: Look, pose: Pose): number {
  const { t, activity: a, walking, seated, mood } = pose;
  const bob = walking ? Math.abs(Math.sin(t * 10)) * 2 : a === 'idle' ? Math.sin(t * 2) * 0.6 : 0;
  const swing = walking ? Math.sin(t * 10) * 3 : 0;
  const sit = seated ? 5 : 0;
  // Antigravity floats: no feet on the floor, a slow hover instead of steps.
  const floating = look.kind === 'antigravity';
  const lift = floating ? (seated ? 3 : 8) + Math.sin(t * 2.4) * 1.8 : 0;
  const bodyBottom = -7 + sit - (floating ? lift : bob);
  const bodyTop = bodyBottom - 13;
  const hy = bodyTop - 9; // head centre
  const R = 12;

  if (floating) g.ellipse(0, 0, 9 - lift * 0.3, 3.5 - lift * 0.1).fill({ color: 0x000000, alpha: 0.12 });
  else g.ellipse(0, 0, 12, 5).fill({ color: 0x000000, alpha: 0.18 });

  // Cape goes behind everything else.
  if (look.kind === 'opus') {
    g.poly([-8, bodyTop + 1, 8, bodyTop + 1, 12 + swing * 0.3, bodyBottom + 4, -12 + swing * 0.3, bodyBottom + 4]).fill(0x6d28d9);
  }

  // Legs
  if (floating) {
    // A soft glow where feet would be.
    g.ellipse(0, bodyBottom + 4, 6, 2.5).fill({ color: 0x8ab4f8, alpha: 0.35 + Math.sin(t * 6) * 0.15 });
    g.roundRect(-5, bodyBottom - 1, 4, 5, 2).fill(0x2f3542);
    g.roundRect(1, bodyBottom - 1, 4, 5, 2).fill(0x2f3542);
  } else if (!seated) {
    g.roundRect(-5 + swing * 0.3, -9, 4, 9, 2).fill(0x2f3542);
    g.roundRect(1 - swing * 0.3, -9, 4, 9, 2).fill(0x2f3542);
  } else {
    g.roundRect(-6, -7, 12, 4, 2).fill(0x2f3542);
  }

  // Body
  g.roundRect(-8, bodyTop, 16, 13, 5).fill(look.shirt);
  if (look.kind === 'terra') {
    g.roundRect(-6, bodyTop + 4, 12, 10, 2).fill(0x8b5a2b); // apron
    g.rect(-3, bodyTop + 8, 6, 4).fill(0x6b4423); // pocket
    g.rect(2, bodyTop + 4, 1.6, 6).fill(0x9ca3af); // wrench handle
  }
  if (look.kind === 'sol') g.circle(-4, bodyTop + 4, 2).fill(0xfacc15); // sun pin
  if (look.kind === 'sonnet') g.roundRect(-8, bodyTop - 1, 16, 4, 2).fill(0xf59e0b); // scarf

  // Arms and what the hands hold
  const typing = seated && a === 'write' ? Math.sin(t * 28) * 1.8 : 0;
  if (a === 'wait') {
    g.roundRect(7, hy - 4, 4, 17, 2).fill(look.shirt); // hand up
    g.circle(9, hy - 6, 3).fill(look.skin);
    g.roundRect(-11, bodyTop + 2, 4, 10, 2).fill(look.shirt);
  } else {
    g.roundRect(-11, bodyTop + 2 + typing, 4, 10, 2).fill(look.shirt);
    g.roundRect(7, bodyTop + 2 - typing, 4, 10, 2).fill(look.shirt);
    if (a === 'idle' && !walking) {
      g.roundRect(9, bodyTop + 6, 5, 6, 1).fill(0xffffff); // coffee
      g.rect(10, bodyTop + 7, 3, 1.5).fill(0x6f4e37);
    } else if (look.kind === 'reviewer') {
      g.moveTo(11, bodyTop + 10).lineTo(15, bodyTop + 4).stroke({ width: 2, color: 0x6b4423 });
      g.circle(17, bodyTop + 1, 4).fill({ color: 0xbfe3f5, alpha: 0.6 }).stroke({ width: 1.5, color: 0x374151 });
    } else if (look.kind === 'sol' && a !== 'write') {
      g.rect(9, bodyTop + 4, 6, 8).fill(0xffffff).stroke({ width: 0.8, color: 0x9ca3af }); // notebook
    } else if (a === 'plan') {
      g.rect(10, bodyTop - 2, 2, 8).fill(0xef4444); // marker
    }
  }

  // Head and face
  g.circle(0, hy, R).fill(look.skin);
  if (!look.bald) hair(g, look, hy, R);
  else g.ellipse(-3, hy - 6, 4, 2).fill({ color: 0xffffff, alpha: 0.24 });
  face(g, pose, hy);
  if (look.glasses) {
    g.roundRect(-9, hy - 2, 8, 7, 2).fill({ color: 0xbfe3f5, alpha: 0.22 }).stroke({ width: 1.5, color: INK });
    g.roundRect(1, hy - 2, 8, 7, 2).fill({ color: 0xbfe3f5, alpha: 0.22 }).stroke({ width: 1.5, color: INK });
    g.moveTo(-1, hy).lineTo(1, hy).stroke({ width: 1.5, color: INK });
  }
  if (!look.civilian) headwear(g, look, hy, R, t);

  // Emotes
  let top = hy - R - (look.kind === 'fable' || look.kind === 'luna' ? 14 : look.kind === 'astra' ? 12 : 4);
  if (a === 'wait') {
    const pulse = 1 + Math.sin(t * 7) * 0.12;
    g.circle(0, top - 10, 7 * pulse).fill(0xf59e0b);
    g.roundRect(-1.2, top - 14, 2.4, 6, 1).fill(0xffffff);
    g.circle(0, top - 6.5, 1.3).fill(0xffffff);
    top -= 18;
    // Sweat drop sliding down the temple
    const drop = (t * 0.8) % 1;
    g.circle(-R + 1, hy - 4 + drop * 8, 2.2).fill({ color: 0x7dd3fc, alpha: 1 - drop * 0.6 });
  }
  if (a === 'bash' && pose.busyFor > 20) {
    const on = Math.sin(t * 8) > 0;
    g.circle(R - 1, top - 4, 4).fill(on ? 0xfde047 : 0x78716c); // something takes a while
    g.rect(R - 2.5, top, 3, 3).fill(0x57534e);
  }
  if (a === 'idle' && pose.busyFor > 120 && !walking) {
    const z = (t * 0.6) % 1;
    for (let i = 0; i < 3; i++) {
      const k = (z + i / 3) % 1;
      g.rect(6 + k * 10, top - k * 16, 4 + i, 1.2).fill({ color: INK, alpha: 1 - k }); // z
    }
  }
  if (a === 'write' && seated) {
    for (let i = 0; i < 3; i++) g.rect(-18 - (i % 2) * 3, bodyTop + 2 + i * 4, 5, 1).fill({ color: INK, alpha: 0.35 + 0.3 * Math.abs(Math.sin(t * 20 + i)) });
  }
  if (mood === 'fail') {
    g.circle(-4.5, hy + 5 + ((t * 2) % 1) * 4, 1.4).fill(0x60a5fa);
    g.circle(4.5, hy + 5 + ((t * 2 + 0.5) % 1) * 4, 1.4).fill(0x60a5fa);
  }
  return top;
}

function hair(g: Graphics, look: Look, hy: number, R: number): void {
  switch (look.kind) {
    case 'claude':
    case 'codex':
      g.ellipse(0, hy - R + 3, R - 1, 5).fill(look.hair);
      g.ellipse(3, hy - R, 3, 4).fill(look.hair); // tuft
      break;
    case 'haiku':
    case 'reviewer':
      g.ellipse(0, hy - R + 4, R - 3, 4).fill(look.hair);
      break;
    default:
      g.ellipse(0, hy - R + 4, R - 1, 5).fill(look.hair);
  }
}

function face(g: Graphics, pose: Pose, hy: number): void {
  const { activity: a, mood, t } = pose;
  if (pose.expression) {
    const expression = pose.expression;
    for (const x of [-4.5, 4.5]) {
      if (expression === 'laugh' || expression === 'wink' && x > 0) g.moveTo(x - 2.5, hy + 1).quadraticCurveTo(x, hy - 2, x + 2.5, hy + 1).stroke({ width: 1.5, color: INK });
      else if (expression === 'dizzy') {
        g.moveTo(x - 2, hy - 1).lineTo(x + 2, hy + 3).moveTo(x + 2, hy - 1).lineTo(x - 2, hy + 3).stroke({ width: 1.4, color: INK });
      } else {
        g.circle(x, hy + 1, expression === 'surprised' ? 3 : 2).fill(0xffffff);
        g.circle(x + (expression === 'tongue' ? (x < 0 ? 1 : -1) : 0), hy + 1, 1.4).fill(INK);
      }
    }
    if (expression === 'surprised') g.ellipse(0, hy + 7, 2.6, 3.5).fill(0x7f1d1d);
    else {
      g.ellipse(0, hy + 7, expression === 'laugh' ? 5 : 4, expression === 'laugh' ? 3 + Math.abs(Math.sin(t * 9)) : 2.5).fill(0x7f1d1d);
      if (expression === 'tongue') g.roundRect(0, hy + 7, 4, 5, 2).fill(0xf0879a);
      else g.rect(-3, hy + 5, 6, 1.5).fill(0xffffff);
    }
    return;
  }
  const ex = 4.5;
  const ey = hy + 1;
  const blink = Math.sin(t * 1.7) > 0.985;
  const cool = mood === 'cool';

  // Cheeks
  g.ellipse(-7, hy + 4, 2.2, 1.3).fill({ color: 0xf472b6, alpha: 0.35 });
  g.ellipse(7, hy + 4, 2.2, 1.3).fill({ color: 0xf472b6, alpha: 0.35 });

  if (cool) {
    // Pixel shades after green tests
    g.rect(-9, ey - 3, 18, 2).fill(INK);
    g.rect(-8, ey - 1, 6, 3).fill(INK);
    g.rect(2, ey - 1, 6, 3).fill(INK);
    g.rect(-7, ey - 1, 2, 1).fill(0xffffff);
    g.rect(3, ey - 1, 2, 1).fill(0xffffff);
  } else if (a === 'idle') {
    for (const x of [-ex, ex]) g.moveTo(x - 2, ey + 0.5).quadraticCurveTo(x, ey - 2, x + 2, ey + 0.5).stroke({ width: 1.3, color: INK });
  } else if (a === 'bash' || a === 'web') {
    for (const x of [-ex, ex]) {
      g.circle(x, ey, 2.8).fill(0xffffff).stroke({ width: 0.8, color: INK });
      g.circle(x + (a === 'web' ? Math.sin(t * 2) : 0), ey + 0.5, 1.4).fill(INK);
    }
  } else if (blink) {
    for (const x of [-ex, ex]) g.rect(x - 1.8, ey, 3.6, 1).fill(INK);
  } else {
    const look = a === 'think' ? -1.5 : a === 'read' ? 1 : 0;
    for (const x of [-ex, ex]) {
      g.circle(x, ey + look, 1.9).fill(INK);
      g.circle(x + 0.6, ey + look - 0.7, 0.6).fill(0xffffff);
    }
  }

  // Brows
  if (a === 'write' && !cool) {
    g.moveTo(-7, ey - 5).lineTo(-2, ey - 3).stroke({ width: 1.4, color: INK });
    g.moveTo(7, ey - 5).lineTo(2, ey - 3).stroke({ width: 1.4, color: INK });
  } else if (a === 'wait' || mood === 'fail') {
    g.moveTo(-7, ey - 3).lineTo(-2, ey - 5).stroke({ width: 1.2, color: INK });
    g.moveTo(7, ey - 3).lineTo(2, ey - 5).stroke({ width: 1.2, color: INK });
  }

  // Reading glasses
  if (a === 'read' && !cool) {
    g.circle(-ex, ey + 1, 3.4).stroke({ width: 1, color: 0x374151 });
    g.circle(ex, ey + 1, 3.4).stroke({ width: 1, color: 0x374151 });
    g.moveTo(-1.1, ey + 1).lineTo(1.1, ey + 1).stroke({ width: 1, color: 0x374151 });
  }

  // Mouth
  const my = hy + 6;
  if (a === 'talk') {
    g.ellipse(0, my, 2.4, 1 + Math.abs(Math.sin(t * 12)) * 1.8).fill(0x7f1d1d);
  } else if (a === 'wait') {
    g.circle(0, my, 1.6).fill(0x7f1d1d);
  } else if (a === 'write' && !cool) {
    g.roundRect(-3, my - 1, 6, 2.6, 1).fill(0xffffff).stroke({ width: 0.8, color: INK }); // gritted teeth
    g.moveTo(-3, my + 0.3).lineTo(3, my + 0.3).stroke({ width: 0.5, color: INK });
  } else if (mood === 'fail') {
    g.moveTo(-3, my + 1.5).quadraticCurveTo(0, my - 1.5, 3, my + 1.5).stroke({ width: 1.2, color: INK });
  } else if (cool) {
    g.moveTo(-1, my + 0.5).quadraticCurveTo(2, my + 2, 4, my - 0.5).stroke({ width: 1.2, color: INK }); // smirk
  } else {
    g.moveTo(-2.5, my - 0.5).quadraticCurveTo(0, my + 2, 2.5, my - 0.5).stroke({ width: 1.2, color: INK });
  }
}

function headwear(g: Graphics, look: Look, hy: number, R: number, t: number): void {
  const top = hy - R;
  switch (look.kind) {
    case 'opus': // crown
      g.poly([-7, top + 3, -7, top - 4, -3.5, top, 0, top - 6, 3.5, top, 7, top - 4, 7, top + 3]).fill(0xfacc15);
      g.circle(0, top - 1, 1.3).fill(0xef4444);
      break;
    case 'sonnet': // beret
      g.ellipse(-2, top + 1, 11, 4.5).fill(0x9f1239);
      g.rect(-2.5, top - 5, 1.6, 3).fill(0x9f1239);
      break;
    case 'haiku': // sprout
      g.moveTo(0, top + 2).lineTo(0, top - 6).stroke({ width: 1.4, color: 0x15803d });
      g.ellipse(-3, top - 6, 3, 1.6).fill(0x22c55e);
      g.ellipse(3, top - 7 + Math.sin(t * 3) * 0.6, 3, 1.6).fill(0x4ade80);
      break;
    case 'fable': // storyteller's pointed hat
      g.poly([-10, top + 3, 10, top + 3, 2, top - 16]).fill(0x1e3a8a);
      g.circle(0, top - 4, 1.6).fill(0xfde047);
      break;
    case 'sol': // pencil behind the ear
      g.rect(R - 4, hy - 8, 2.5, 9).fill(0xfacc15);
      g.rect(R - 4, hy - 9, 2.5, 1.5).fill(0xf9a8d4);
      break;
    case 'terra': // work bandana
      g.roundRect(-R, top + 3, R * 2, 3.5, 1.5).fill(0x15803d);
      break;
    case 'luna': // nightcap with a moon
      g.poly([-10, top + 3, 10, top + 3, 13, top - 9]).fill(0x312e81);
      g.circle(13, top - 9, 2.5).fill(0xffffff);
      g.circle(-3, top - 1, 2.2).fill(0xfde68a);
      g.circle(-2, top - 1.6, 2.2).fill(0x312e81);
      break;
    case 'astra': // antenna with a star
      g.moveTo(0, top + 1).lineTo(0, top - 9).stroke({ width: 1.2, color: 0x6b7280 });
      star(g, 0, top - 11, 3.5, 0xfacc15);
      break;
    case 'reviewer': // inspector cap
      g.roundRect(-9, top, 18, 4, 2).fill(0x1f2937);
      g.rect(-2, top + 0.5, 4, 3).fill(0xfacc15);
      break;
    case 'antigravity': {
      g.ellipse(0, hy - 2, R + 5, 4.5).stroke({ width: 1.2, color: 0x8ab4f8, alpha: 0.9 });
      const a = t * 1.6;
      const px = Math.cos(a) * (R + 5);
      const py = hy - 2 + Math.sin(a) * 4.5;
      g.circle(px, py, 2).fill(0xfbbc04);
      break;
    }
    case 'codex': // visor
      g.roundRect(-R + 1, hy - 6, R * 2 - 2, 3, 1.5).fill(0x0f766e);
      break;
    case 'demo': // party hat
      g.poly([-6, top + 3, 6, top + 3, 0, top - 10]).fill(0xf472b6);
      g.circle(0, top - 10, 1.8).fill(0xfde047);
      break;
  }
}

function star(g: Graphics, x: number, y: number, r: number, color: number): void {
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.poly(pts).fill(color);
}
