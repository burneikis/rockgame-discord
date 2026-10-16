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

/**
 * A stone. Pentagons are each a little different: they carry their own
 * outline (x, z points), generated when the game starts and kept for good,
 * so whoever ends up holding one holds the same piece.
 */
export interface Stone { id: number; shape: Shape; points?: [number, number][] }

/** A shape name, or a stone (whose own outline wins for pentagons). */
export type StoneRef = Shape | { shape: Shape; points?: [number, number][] };

/** Slab thickness of the flat stones. */
export const THICK = 0.3;

/** A flat outline in the x/z plane: a circle or a convex polygon. */
export type Outline = { kind: 'circle'; radius: number } | { kind: 'polygon'; points: [number, number][] };

export type Geometry =
  | { kind: 'cylinder'; radius: number; height: number }
  | { kind: 'box'; hx: number; hy: number; hz: number }
  /** Regular n-sided prism; vertex k sits at angle 2*pi*k/n, x = r sin, z = r cos (like three's CylinderGeometry). */
  | { kind: 'prism'; sides: number; radius: number; height: number }
  /** Prism of any convex outline (x, z points), centred on its centroid. */
  | { kind: 'polygon'; points: [number, number][]; height: number };

export function polygonArea(points: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

/** Shift a polygon so its centroid is at the origin, optionally scaling it. */
export function centred(points: [number, number][], scale = 1): [number, number][] {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    const cross = x1 * z2 - x2 * z1;
    a += cross;
    cx += (x1 + x2) * cross;
    cz += (z1 + z2) * cross;
  }
  cx /= 3 * a;
  cz /= 3 * a;
  return points.map(([x, z]) => [(x - cx) * scale, (z - cz) * scale]);
}

export function isConvex(points: [number, number][]): boolean {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[(i + 1) % points.length];
    const [cx, cz] = points[(i + 2) % points.length];
    const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** Points of an ellipse at the given angles (degrees), sheared for a lopsided look. Always convex. */
function ellipse(a: number, b: number, degrees: number[], shear = 0): [number, number][] {
  return degrees.map((d) => {
    const t = (d * Math.PI) / 180;
    const x = a * Math.cos(t);
    const z = b * Math.sin(t);
    return [x + shear * z, z];
  });
}

export const GEOMETRY: Record<Shape, Geometry> = {
  circle: { kind: 'cylinder', radius: 0.55, height: THICK },
  shaft: { kind: 'box', hx: 0.75, hy: 0.16, hz: 0.16 },
  triangle: { kind: 'prism', sides: 3, radius: 0.78, height: THICK },
  square: { kind: 'box', hx: 0.55, hy: THICK / 2, hz: 0.55 },
  // The odd one out: a lopsided pentagon with one short side and uneven corners.
  pentagon: {
    kind: 'polygon',
    points: centred([[0.15, 0.78], [0.62, 0.52], [0.66, -0.5], [-0.35, -0.72], [-0.78, 0.18]], 0.85),
    height: THICK,
  },
  cube: { kind: 'box', hx: 0.38, hy: 0.38, hz: 0.38 },
};

/** The geometry of a particular stone. */
export function geometryOf(ref: StoneRef): Geometry {
  if (typeof ref === 'string') return GEOMETRY[ref];
  if (ref.shape === 'pentagon' && ref.points) return { kind: 'polygon', points: ref.points, height: THICK };
  return GEOMETRY[ref.shape];
}

/** Pentagon top faces are capped at this area, and kept above the minimum. */
export const PENTAGON_MAX_AREA = 1.15;
export const PENTAGON_MIN_AREA = 0.75;
const PENTAGON_MIN_SIDE = 0.22;
/** No corner flatter than this (degrees), so it still reads as five-sided. */
const PENTAGON_MAX_CORNER = 160;

/**
 * A random convex pentagon: uneven corner angles and distances give a mix of
 * long and short sides. Scaled down if its face is over the max area.
 */
export function randomPentagon(rand: () => number): [number, number][] {
  for (let attempt = 0; attempt < 200; attempt++) {
    // Five directions with uneven gaps (each gap 35..110 degrees, summing to 360).
    const gaps = Array.from({ length: 5 }, () => 0.5 + rand());
    const total = gaps.reduce((a, b) => a + b, 0);
    let angle = rand() * Math.PI * 2;
    const pts: [number, number][] = [];
    for (const g of gaps) {
      const r = 0.5 + rand() * 0.4;
      pts.push([r * Math.cos(angle), r * Math.sin(angle)]);
      angle += (g / total) * Math.PI * 2;
    }
    if (!isConvex(pts) || maxCorner(pts) > PENTAGON_MAX_CORNER) continue;
    const area = polygonArea(pts);
    const target = Math.min(PENTAGON_MAX_AREA, Math.max(PENTAGON_MIN_AREA, area));
    const out = centred(pts, Math.sqrt(target / area)).map(([x, z]) => [round3(x), round3(z)] as [number, number]);
    if (Math.min(...sideLengths(out)) < PENTAGON_MIN_SIDE) continue;
    // Keep the points counter-clockwise for consistency.
    return signedArea(out) < 0 ? out.reverse() : out;
  }
  const g = GEOMETRY.pentagon;
  return g.kind === 'polygon' ? g.points : [];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function signedArea(points: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

export function sideLengths(points: [number, number][]): number[] {
  return points.map(([x, z], i) => {
    const [x2, z2] = points[(i + 1) % points.length];
    return Math.hypot(x2 - x, z2 - z);
  });
}

/** Largest interior angle, in degrees. */
export function maxCorner(points: [number, number][]): number {
  const n = points.length;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = points[(i + n - 1) % n];
    const [bx, bz] = points[i];
    const [cx, cz] = points[(i + 1) % n];
    const u = [ax - bx, az - bz];
    const v = [cx - bx, cz - bz];
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]));
    max = Math.max(max, (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI);
  }
  return max;
}

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

/** 3D corner points of a polygon prism spanning y = bottom..top. */
export function polygonPoints(points: [number, number][], bottom: number, top: number): number[] {
  const pts: number[] = [];
  for (const y of [bottom, top]) for (const [x, z] of points) pts.push(x, y, z);
  return pts;
}

/** Corner points of a stone in its own frame (the cylinder's rim sampled). */
export function hullPoints(ref: StoneRef): number[] {
  const g = geometryOf(ref);
  if (g.kind === 'prism') return prismPoints(g.sides, g.radius, g.height);
  if (g.kind === 'polygon') return polygonPoints(g.points, -g.height / 2, g.height / 2);
  if (g.kind === 'cylinder') return prismPoints(16, g.radius, g.height);
  const pts: number[] = [];
  for (const x of [-g.hx, g.hx]) for (const y of [-g.hy, g.hy]) for (const z of [-g.hz, g.hz]) pts.push(x, y, z);
  return pts;
}

/** Lowest point of a stone in world space. */
export function lowestY(ref: StoneRef, pose: Pose): number {
  const [qx, qy, qz, qw] = pose.q;
  const pts = hullPoints(ref);
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
export function boundingRadius(ref: StoneRef): number {
  const g = geometryOf(ref);
  if (g.kind === 'box') return Math.hypot(g.hx, g.hy, g.hz);
  if (g.kind === 'polygon') return Math.hypot(Math.max(...g.points.map(([x, z]) => Math.hypot(x, z))), g.height / 2);
  return Math.hypot(g.radius, g.height / 2);
}

/** Base (pedestal) and table. The base top is y = 0. */
export const BASE_HEIGHT = 0.6;

/** Base rocks to build on. Smaller tops are harder; the lobby sorts them by area. */
export const BASES = {
  boulder: { name: 'Boulder', outline: { kind: 'circle', radius: 1.7 } },
  millstone: { name: 'Millstone', outline: { kind: 'circle', radius: 1.25 } },
  flagstone: {
    name: 'Flagstone',
    outline: { kind: 'polygon', points: centred([[-1.0, -0.9], [1.05, -1.0], [0.95, 0.95], [-1.1, 0.85]]) },
  },
  riverStone: {
    name: 'River stone',
    outline: { kind: 'polygon', points: centred(ellipse(1.35, 0.8, [0, 30, 65, 100, 140, 175, 205, 245, 285, 320], 0.25)) },
  },
  stump: { name: 'Stump', outline: { kind: 'circle', radius: 0.95 } },
  ridge: {
    name: 'Ridge',
    outline: { kind: 'polygon', points: centred([[-1.45, -0.42], [1.4, -0.5], [1.5, 0.4], [-1.35, 0.48]]) },
  },
  pebble: {
    name: 'Pebble',
    outline: { kind: 'polygon', points: centred(ellipse(0.85, 0.62, [0, 50, 95, 150, 200, 240, 290, 330], 0.2)) },
  },
  needle: { name: 'Needle', outline: { kind: 'circle', radius: 0.62 } },
} satisfies Record<string, { name: string; outline: Outline }>;

export type BaseId = keyof typeof BASES;
export const DEFAULT_BASE: BaseId = 'stump';

export function outlineArea(o: Outline): number {
  return o.kind === 'circle' ? Math.PI * o.radius ** 2 : polygonArea(o.points);
}

/** Furthest the outline reaches from the centre. */
export function outlineRadius(o: Outline): number {
  return o.kind === 'circle' ? o.radius : Math.max(...o.points.map(([x, z]) => Math.hypot(x, z)));
}

export function baseOutline(id: BaseId): Outline {
  return BASES[id].outline as Outline;
}

/** Base ids from easiest (biggest top) to hardest. */
export const BASE_IDS = (Object.keys(BASES) as BaseId[]).sort((a, b) => outlineArea(baseOutline(b)) - outlineArea(baseOutline(a)));

export function isBaseId(id: unknown): id is BaseId {
  return typeof id === 'string' && Object.hasOwn(BASES, id);
}

/** Rough difficulty label from the top area. */
export function baseDifficulty(id: BaseId): string {
  const a = outlineArea(baseOutline(id));
  return a > 6 ? 'easy' : a > 3.5 ? 'medium' : a > 2 ? 'hard' : 'very hard';
}
/** Stones whose centre drops below this have fallen off the tower. */
export const FALL_Y = -0.05;
/** Stones whose lowest point gets this close to the table have fallen too (e.g. leaning on the base). */
export const TABLE_TOUCH = 0.04;

/** Stones per player for one set (one of every shape). */
export function startingSupply(sets: number, nextId: () => number, rand: () => number = Math.random): Stone[] {
  const out: Stone[] = [];
  for (let s = 0; s < sets; s++) {
    for (const shape of SHAPES) out.push(shape === 'pentagon' ? { id: nextId(), shape, points: randomPentagon(rand) } : { id: nextId(), shape });
  }
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
