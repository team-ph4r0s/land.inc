import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResidentLife, SCRIPTS, type Point } from '../../office/src/resident-life.ts';

function seeded() { let seed = 41; return () => { seed = Math.imul(1664525, seed) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }; }
function route(a: Point, b: Point): Point[] {
  const out: Point[] = [];
  let { x, y } = a;
  while (x !== b.x || y !== b.y) { if (x !== b.x) x += Math.sign(b.x - x); else y += Math.sign(b.y - y); out.push({ x, y }); }
  return out;
}

test('residents persist without agents and cycle through solo scripts and every shared scene', () => {
  const life = new ResidentLife(route, seeded());
  const identities = [...life.people];
  const actions = new Map(life.people.map((r) => [r.id, new Set<string>()]));
  const scenes = new Map<number, Set<number>>();
  for (let i = 0; i < 36_000; i++) {
    const before = life.people.map((r) => ({ x: r.x, y: r.y }));
    life.update(0.1, i < 18_000 ? [{ x: 6, y: 6 }] : []);
    for (const [n, r] of life.people.entries()) {
      assert.equal(r, identities[n]);
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && r.x >= 0 && r.x < 24 && r.y >= 0 && r.y < 18);
      assert.ok(Math.hypot(r.x - before[n].x, r.y - before[n].y) <= 0.421, 'no teleports during script/scene transitions');
      if (!r.moving) actions.get(r.id)!.add(r.action);
    }
    if (life.scene && !life.scene.gathering) {
      const s = life.scene;
      if (!scenes.has(s.index)) scenes.set(s.index, new Set());
      scenes.get(s.index)!.add(s.phase);
      for (const r of life.people.filter((p) => life.participants.includes(p.id))) assert.equal(r.moving, false, 'shared acting waits for everyone to arrive');
    }
  }
  assert.equal(life.people.length, 3);
  for (const ids of scenes.values()) assert.deepEqual([...ids].sort(), [0, 1, 2, 3]);
  assert.equal(scenes.size, 4);
  for (const [id, seen] of actions) assert.ok(seen.size >= 10, `${id} needs varied actions, saw ${[...seen]}`);
  assert.ok(actions.get('vanya')!.has('pocket') && actions.get('vanya')!.has('dumbbell'));
  assert.ok(actions.get('rasul')!.has('faces') && actions.get('rasul')!.has('stumble'));
  assert.ok(actions.get('max')!.has('scooter'));
  assert.deepEqual(Object.values(SCRIPTS).map((s) => s.length), [10, 10, 10]);
});

test('greeting interrupts a shared scene safely and residents resume their routines', () => {
  const life = new ResidentLife(route, seeded());
  for (let i = 0; i < 1000 && !(life.scene && !life.scene.gathering); i++) life.update(0.1, []);
  assert.ok(life.scene);
  const participant = life.participants[0];
  life.greet(participant);
  assert.equal(life.scene, undefined);
  assert.equal(life.people.find((r) => r.id === participant)!.action, 'wave');
  for (let i = 0; i < 150; i++) life.update(0.1, [], true);
  assert.ok(life.people.every((r) => r.text && Number.isFinite(r.x)));
});

test('an excessively slow rendezvous times out rather than freezing residents', () => {
  const life = new ResidentLife(route, seeded());
  for (let i = 0; i < 1000 && !life.scene; i++) life.update(0.1, []);
  assert.ok(life.scene);
  for (const r of life.people) r.path = Array.from({ length: 1000 }, (_, i) => ({ x: i % 2 ? 1 : 22, y: 13 }));
  for (let i = 0; i < 510; i++) life.update(0.1, []);
  assert.equal(life.scene, undefined);
});
