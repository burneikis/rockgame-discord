import { beforeAll, describe, expect, it } from 'vitest';
import { Game } from './engine';
import { botAction } from './bot';
import { Sim, initPhysics } from './physics';
import {
  BASES,
  BASE_HEIGHT,
  BASE_IDS,
  THICK,
  GEOMETRY,
  PENTAGON_MAX_AREA,
  PENTAGON_MIN_AREA,
  maxCorner,
  polygonArea,
  randomPentagon,
  sideLengths,
  allowedStones,
  baseOutline,
  canMake,
  isConvex,
  lowestY,
  outlineArea,
  placementRotation,
  quatAxis,
  type BaseId,
  type Stone,
} from './stones';

/** Tests run on the Millstone: a round base of radius 1.25. */
const OPTS = { sets: 1, base: 'millstone' as BaseId };
const BASE_RADIUS = 1.25;

beforeAll(() => initPhysics());

/** Deterministic random numbers so failures reproduce. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const members = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: true }));

describe('combinations', () => {
  it('finds subset sums', () => {
    expect(canMake([1, 2, 3, 4, 5, 6], 5)).toBe(true);
    expect(canMake([2, 4], 5)).toBe(false);
    expect(canMake([1, 1, 3], 5)).toBe(true);
    expect(canMake([6], 1)).toBe(false);
  });

  it('only allows stones that keep the roll makeable', () => {
    const supply: Stone[] = [
      { id: 1, shape: 'circle' },
      { id: 2, shape: 'shaft' },
      { id: 3, shape: 'square' },
    ];
    // Roll 5: circle + square works, shaft can't be part of any 5.
    expect(allowedStones(supply, 5).map((s) => s.id)).toEqual([1, 3]);
    expect(allowedStones(supply, 6).map((s) => s.id)).toEqual([2, 3]);
  });
});

describe('geometry', () => {
  it('finds the lowest point of a rotated stone', () => {
    expect(lowestY('cube', { p: [0, 0.38, 0], q: [0, 0, 0, 1] })).toBeCloseTo(0);
    expect(lowestY('cube', { p: [0, 1, 0], q: quatAxis(0, 0, 1, Math.PI / 4) })).toBeCloseTo(1 - 0.38 * Math.SQRT2);
    expect(lowestY('shaft', { p: [0, 1, 0], q: quatAxis(0, 0, 1, Math.PI / 2) })).toBeCloseTo(0.25);
  });
});

describe('pentagons', () => {
  it('are random, convex, within the area limits, with long and short sides', () => {
    const rand = seeded(42);
    const seen = new Set<string>();
    let ratios = 0;
    for (let i = 0; i < 300; i++) {
      const p = randomPentagon(rand);
      expect(p).toHaveLength(5);
      expect(isConvex(p)).toBe(true);
      expect(maxCorner(p)).toBeLessThanOrEqual(160.5);
      const area = polygonArea(p);
      expect(area).toBeLessThanOrEqual(PENTAGON_MAX_AREA + 0.01);
      expect(area).toBeGreaterThanOrEqual(PENTAGON_MIN_AREA - 0.01);
      const sides = sideLengths(p);
      ratios += Math.max(...sides) / Math.min(...sides);
      seen.add(p.join(';'));
    }
    expect(seen.size).toBe(300);
    expect(ratios / 300).toBeGreaterThan(1.6);
  });

  it('every player starts with their own pentagon, and it keeps its shape when it changes hands', () => {
    const g = new Game(members(3), { sets: 2, base: 'boulder' }, seeded(11));
    const pentagons = g.players.flatMap((p) => p.supply.filter((s) => s.shape === 'pentagon'));
    expect(pentagons).toHaveLength(6);
    expect(new Set(pentagons.map((s) => s.points!.join(';'))).size).toBe(6);

    const a = g.current;
    a.supply = a.supply.filter((s) => s.shape === 'pentagon');
    const mine = a.supply[0];
    const outline = mine.points!.join(';');
    g.rigRoll(5);
    g.act(a.id, { kind: 'roll' });
    expect(g.act(a.id, { kind: 'place', stoneId: mine.id, x: 0, z: 0, q: [0, 0, 0, 1] })).toBeNull();
    g.settle();
    expect(g.sim.poses().find((s) => s.id === mine.id)!.points!.join(';')).toBe(outline);

    const b = g.current;
    b.supply = [];
    b.supply.push({ id: 999, shape: 'cube' });
    g.rigRoll(1);
    g.act(b.id, { kind: 'roll' });
    expect(g.step).toBe('pickup');
    g.act(b.id, { kind: 'pickup', stoneId: mine.id });
    g.settle();
    const taken = b.supply.find((s) => s.id === mine.id)!;
    expect(taken.points!.join(';')).toBe(outline);
    g.dispose();
  });
});

describe('stones and bases', () => {
  it('has a lopsided but convex pentagon', () => {
    const g = GEOMETRY.pentagon;
    if (g.kind !== 'polygon') throw new Error('pentagon should be a polygon');
    expect(g.points).toHaveLength(5);
    expect(isConvex(g.points)).toBe(true);
    const sides = g.points.map((p, i) => {
      const q = g.points[(i + 1) % 5];
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    });
    expect(Math.max(...sides) / Math.min(...sides)).toBeGreaterThan(1.5);
  });

  it('has convex bases, sorted from the biggest top to the smallest', () => {
    for (const id of BASE_IDS) {
      const o = baseOutline(id);
      if (o.kind === 'polygon') expect(isConvex(o.points), id).toBe(true);
    }
    const areas = BASE_IDS.map((id) => outlineArea(baseOutline(id)));
    expect([...areas].sort((a, b) => b - a)).toEqual(areas);
    expect(BASE_IDS).toHaveLength(Object.keys(BASES).length);
  });

  it('only lets you place on the base you picked', () => {
    const g = new Game(members(2), { sets: 1, base: 'ridge' }, seeded(9));
    // The ridge is long in x and narrow in z.
    expect(g.sim.dropPose('cube', 1.2, 0, [0, 0, 0, 1])).not.toBeNull();
    expect(g.sim.dropPose('cube', 0, 1.2, [0, 0, 0, 1])).toBeNull();
    g.dispose();
  });

  it('can slide a stone under an overhang when aiming low', () => {
    const sim = Sim.create('boulder');
    // A square held up 1.0 above the base: room for a flat circle under it.
    sim.add(1, 'square', { p: [0, 1, 0], q: [0, 0, 0, 1] }, true);
    const flat: [number, number, number, number] = [0, 0, 0, 1];
    const top = sim.dropPose('circle', 0, 0, flat)!;
    expect(top.p[1]).toBeGreaterThan(1);
    const under = sim.dropPose('circle', 0, 0, flat, 0)!;
    expect(under.p[1]).toBeLessThan(0.5);
    // Aiming at the square's top still lands on top.
    expect(sim.dropPose('circle', 0, 0, flat, 1 + THICK / 2)!.p[1]).toBeGreaterThan(1);
    sim.free();
  });
});

describe('game flow', () => {
  it('places a stone on the base and passes the turn when the roll is used up', () => {
    const g = new Game(members(2), OPTS, seeded(1));
    const first = g.current.id;
    g.rigRoll(6);
    expect(g.act(first, { kind: 'roll' })).toBeNull();
    expect(g.step).toBe('place');
    const cube = g.current.supply.find((s) => s.shape === 'cube')!;
    expect(g.act(first, { kind: 'place', stoneId: cube.id, x: 0, z: 0, q: [0, 0, 0, 1] })).toBeNull();
    expect(g.step).toBe('settling');
    g.settle();
    expect(g.tower.has(cube.id)).toBe(true);
    expect(g.sim.pose(cube.id)!.p[1]).toBeCloseTo(0.38, 1);
    expect(g.current.id).not.toBe(first);
    expect(g.step).toBe('roll');
  });

  it('rejects stones that do not fit the roll and placements off the base', () => {
    const g = new Game(members(2), OPTS, seeded(2));
    const pid = g.current.id;
    g.rigRoll(2);
    g.act(pid, { kind: 'roll' });
    const cube = g.current.supply.find((s) => s.shape === 'cube')!;
    expect(g.act(pid, { kind: 'place', stoneId: cube.id, x: 0, z: 0, q: [0, 0, 0, 1] })).toMatch(/doesn't fit/);
    const shaft = g.current.supply.find((s) => s.shape === 'shaft')!;
    expect(g.act(pid, { kind: 'place', stoneId: shaft.id, x: 8, z: 0, q: [0, 0, 0, 1] })).toMatch(/base or the tower/);
    expect(g.act('nobody', { kind: 'roll' })).toBe('Not your turn');
  });

  it('a stone dropped over the edge falls and goes back to the player, ending the turn', () => {
    const g = new Game(members(2), OPTS, seeded(3));
    const pid = g.current.id;
    g.rigRoll(1);
    g.act(pid, { kind: 'roll' });
    const circle = g.current.supply.find((s) => s.shape === 'circle')!;
    // Barely on the rim: the centre is well past the edge, so it tips off.
    expect(g.act(pid, { kind: 'place', stoneId: circle.id, x: BASE_RADIUS + 0.4, z: 0, q: [0, 0, 0, 1] })).toBeNull();
    g.settle();
    expect(g.player(pid).supply.some((s) => s.id === circle.id)).toBe(true);
    expect(g.tower.size).toBe(0);
    expect(g.current.id).not.toBe(pid);
  });

  it('a player who cannot make the roll takes a stone from the tower', () => {
    const g = new Game(members(2), OPTS, seeded(4));
    const a = g.current;
    g.rigRoll(6);
    g.act(a.id, { kind: 'roll' });
    g.act(a.id, { kind: 'place', stoneId: a.supply.find((s) => s.shape === 'cube')!.id, x: 0, z: 0, q: [0, 0, 0, 1] });
    g.settle();
    const b = g.current;
    b.supply = b.supply.filter((s) => s.shape === 'pentagon');
    g.rigRoll(1);
    g.act(b.id, { kind: 'roll' });
    expect(g.step).toBe('pickup');
    const [cubeId] = g.tower.keys();
    expect(g.act(b.id, { kind: 'pickup', stoneId: cubeId })).toBeNull();
    g.settle();
    expect(b.supply.map((s) => s.shape).sort()).toEqual(['cube', 'pentagon']);
    expect(g.tower.size).toBe(0);
    expect(g.current.id).toBe(a.id);
  });

  it('counts a stone leaning against the base from the table as fallen', () => {
    const g = new Game(members(2), OPTS, seeded(6));
    const shaft = { id: 99, shape: 'shaft' as const };
    g.tower.set(shaft.id, shaft);
    // Standing on its end on the table, right next to the base.
    g.sim.add(shaft.id, 'shaft', { p: [BASE_RADIUS + 0.4, -BASE_HEIGHT + 0.75, 0], q: quatAxis(0, 0, 1, Math.PI / 2) });
    expect(g.sim.isFallen(shaft.id)).toBe(true);
  });

  it('can stand a shaft on its end', () => {
    const g = new Game(members(2), OPTS, seeded(7));
    const pose = g.sim.dropPose('shaft', 0, 0, placementRotation(0, 2))!;
    expect(pose.p[1]).toBeCloseTo(0.75, 1);
  });

  it('wins when the last stone stays up', () => {
    const g = new Game(members(2), OPTS, seeded(5));
    const a = g.current;
    a.supply = a.supply.filter((s) => s.shape === 'square');
    g.rigRoll(4);
    g.act(a.id, { kind: 'roll' });
    g.act(a.id, { kind: 'place', stoneId: a.supply[0].id, x: 0, z: 0, q: [0, 0, 0, 1] });
    g.settle();
    expect(g.step).toBe('over');
    expect(g.winner).toBe(a.id);
  });
});

describe('bots', () => {
  it('play on every base without breaking the rules', { timeout: 120_000 }, () => {
    for (const base of BASE_IDS) {
      const rand = seeded(base.length * 31);
      const g = new Game(members(2), { sets: 1, base }, rand);
      for (let moves = 0; g.step !== 'over' && moves < 60; moves++) {
        expect(g.act(g.current.id, botAction(g, rand))).toBeNull();
        g.settle();
      }
      expect(g.players.reduce((n, p) => n + p.supply.length, 0) + g.tower.size).toBe(12);
      g.dispose();
    }
  });

  it('play full games to a finish', { timeout: 120_000 }, () => {
    for (let seed = 1; seed <= 3; seed++) {
      const rand = seeded(seed * 97);
      const g = new Game(members(3), OPTS, rand);
      let moves = 0;
      while (g.step !== 'over' && moves < 400) {
        const err = g.act(g.current.id, botAction(g, rand));
        expect(err).toBeNull();
        g.settle();
        moves++;
      }
      const stones = g.players.reduce((n, p) => n + p.supply.length, 0) + g.tower.size;
      expect(stones).toBe(18);
      expect(g.step).toBe('over');
      g.dispose();
    }
  });
});
