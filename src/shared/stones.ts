/**
 * Stone shapes, matched to the die faces. Dimensions are shared by the
 * physics (Rapier colliders) and the renderer (three.js meshes), so what you
 * see is exactly what collides.
 */
export const SHAPES = ['circle', 'shaft', 'triangle', 'square', 'pentagon', 'cube'] as const;
export type Shape = (typeof SHAPES)[number];

export const SHAPE_NAMES: Record<Shape, string> = {
  circle: 'Circle',
  shaft: 'Shaft',
  triangle: 'Triangle',
  square: 'Square',
  pentagon: 'Pentagon',
  cube: 'Cube',
};

/** Die face for each shape (circle = 1 ... cube = 6). */
export const VALUE: Record<Shape, number> = { circle: 1, shaft: 2, triangle: 3, square: 4, pentagon: 5, cube: 6 };

export interface Stone { id: number; shape: Shape }

/** Slab thickness of the flat stones. */
export const THICK = 0.3;

export type Geometry =
  | { kind: 'cylinder'; radius: number; height: number }
  | { kind: 'box'; hx: number; hy: number; hz: number }
  /** Regular n-sided prism; vertex k sits at angle 2*pi*k/n, x = r sin, z = r cos (like three's CylinderGeometry). */
  | { kind: 'prism'; sides: number; radius: number; height: number };

export const GEOMETRY: Record<Shape, Geometry> = {
  circle: { kind: 'cylinder', radius: 0.55, height: THICK },
  shaft: { kind: 'box', hx: 1.1, hy: 0.16, hz: 0.16 },
  triangle: { kind: 'prism', sides: 3, radius: 0.78, height: THICK },
  square: { kind: 'box', hx: 0.55, hy: THICK / 2, hz: 0.55 },
  pentagon: { kind: 'prism', sides: 5, radius: 0.68, height: THICK },
  cube: { kind: 'box', hx: 0.38, hy: 0.38, hz: 0.38 },
};

export function prismPoints(sides: number, radius: number, height: number): number[] {
  const pts: number[] = [];
  for (const y of [-height / 2, height / 2]) {
    for (let k = 0; k < sides; k++) {
      const a = (2 * Math.PI * k) / sides;
      pts.push(radius * Math.sin(a), y, radius * Math.cos(a));
    }
  }
  return pts;
}

/** Corner points of a stone in its own frame (the cylinder's rim sampled). */
export function hullPoints(shape: Shape): number[] {
  const g = GEOMETRY[shape];
  if (g.kind === 'prism') return prismPoints(g.sides, g.radius, g.height);
  if (g.kind === 'cylinder') return prismPoints(16, g.radius, g.height);
  const pts: number[] = [];
  for (const x of [-g.hx, g.hx]) for (const y of [-g.hy, g.hy]) for (const z of [-g.hz, g.hz]) pts.push(x, y, z);
  return pts;
}

/** Lowest point of a stone in world space. */
export function lowestY(shape: Shape, pose: Pose): number {
  const [qx, qy, qz, qw] = pose.q;
  const pts = hullPoints(shape);
  let min = Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const [x, y, z] = [pts[i], pts[i + 1], pts[i + 2]];
    // y component of q * v * q^-1
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    const wy = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    min = Math.min(min, pose.p[1] + wy);
  }
  return min;
}

/** Radius of a sphere around the stone's centre that contains it. */
export function boundingRadius(shape: Shape): number {
  const g = GEOMETRY[shape];
  if (g.kind === 'box') return Math.hypot(g.hx, g.hy, g.hz);
  return Math.hypot(g.radius, g.height / 2);
}

/** Base (pedestal) and table. The base top is y = 0. */
export const BASE_RADIUS = 1.7;
export const BASE_HEIGHT = 0.6;
/** Stones whose centre drops below this have fallen off the tower. */
export const FALL_Y = -0.05;
/** Stones whose lowest point gets this close to the table have fallen too (e.g. leaning on the base). */
export const TABLE_TOUCH = 0.04;

/** Stones per player for one set (one of every shape). */
export function startingSupply(sets: number, nextId: () => number): Stone[] {
  const out: Stone[] = [];
  for (let s = 0; s < sets; s++) for (const shape of SHAPES) out.push({ id: nextId(), shape });
  return out;
}

/** Can some subset of `values` add up to exactly `target`? */
export function canMake(values: number[], target: number): boolean {
  if (target === 0) return true;
  if (target < 0) return false;
  let reach = 1n; // bit i set = sum i reachable
  const mask = (1n << BigInt(target + 1)) - 1n;
  for (const v of values) reach = (reach | (reach << BigInt(v))) & mask;
  return ((reach >> BigInt(target)) & 1n) === 1n;
}

/** Stones that may be placed next: each must leave a remainder the rest of the supply can still make. */
export function allowedStones(supply: Stone[], remaining: number): Stone[] {
  return supply.filter((s, i) => {
    const v = VALUE[s.shape];
    if (v > remaining) return false;
    const rest = supply.filter((_, j) => j !== i).map((o) => VALUE[o.shape]);
    return canMake(rest, remaining - v);
  });
}

export interface Pose {
  p: [number, number, number];
  q: [number, number, number, number];
}

/** Quaternion helpers (x, y, z, w). */
export function quatMul(a: Pose['q'], b: Pose['q']): Pose['q'] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatAxis(x: number, y: number, z: number, angle: number): Pose['q'] {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

/** Ways to tip a stone before placing it: flat, on its side, on its end. */
export const TILTS: Pose['q'][] = [
  [0, 0, 0, 1],
  quatAxis(1, 0, 0, Math.PI / 2),
  quatAxis(0, 0, 1, Math.PI / 2),
];

/** Placement rotation from a yaw angle and a tilt index. */
export function placementRotation(yaw: number, tilt: number): Pose['q'] {
  return quatMul(quatAxis(0, 1, 0, yaw), TILTS[((tilt % TILTS.length) + TILTS.length) % TILTS.length]);
}
