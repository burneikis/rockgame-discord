import RAPIER from '@dimforge/rapier3d-compat';
import { BASE_HEIGHT, BASE_RADIUS, FALL_Y, GEOMETRY, TABLE_TOUCH, boundingRadius, lowestY, prismPoints, type Pose, type Shape } from './stones';

/**
 * Thin wrapper around a Rapier world holding the base, the table and the
 * stones on (or fallen off) the tower. The server runs the real simulation;
 * clients use a copy for placement previews and bots use clones to try moves.
 */

let ready: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export const DT = 1 / 60;
const GRAVITY = { x: 0, y: -16, z: 0 };
const FRICTION = 0.85;
const RESTITUTION = 0.05;
const DENSITY = 2.5;
/** Stones are spawned this far above where they would touch down. */
export const DROP_GAP = 0.02;
/** How far out (from the centre) a stone may be placed or roll before it is out of play. */
const OUT_OF_BOUNDS = 25;

export function colliderDesc(shape: Shape): RAPIER.ColliderDesc {
  const g = GEOMETRY[shape];
  let desc: RAPIER.ColliderDesc | null;
  if (g.kind === 'box') desc = RAPIER.ColliderDesc.cuboid(g.hx, g.hy, g.hz);
  else if (g.kind === 'cylinder') desc = RAPIER.ColliderDesc.cylinder(g.height / 2, g.radius);
  else desc = RAPIER.ColliderDesc.convexHull(new Float32Array(prismPoints(g.sides, g.radius, g.height)));
  if (!desc) throw new Error(`could not build collider for ${shape}`);
  return desc.setFriction(FRICTION).setRestitution(RESTITUTION).setDensity(DENSITY);
}

interface Entry { shape: Shape; body: number }

export class Sim {
  readonly world: RAPIER.World;
  private stones: Map<number, Entry>;
  private table: number;

  private constructor(world: RAPIER.World, stones: Map<number, Entry>, table: number) {
    this.world = world;
    this.stones = stones;
    this.table = table;
  }

  static create(): Sim {
    const world = new RAPIER.World(GRAVITY);
    world.timestep = DT;
    world.numSolverIterations = 8;
    // Parentless colliders are fixed in place at their own translation.
    world.createCollider(RAPIER.ColliderDesc.cylinder(BASE_HEIGHT / 2, BASE_RADIUS).setTranslation(0, -BASE_HEIGHT / 2, 0).setFriction(FRICTION));
    const table = world.createCollider(RAPIER.ColliderDesc.cuboid(40, 0.5, 40).setTranslation(0, -BASE_HEIGHT - 0.5, 0).setFriction(FRICTION));
    return new Sim(world, new Map(), table.handle);
  }

  /** An independent copy (for bots trying out moves). Remember to free() it. */
  clone(): Sim {
    const world = RAPIER.World.restoreSnapshot(this.world.takeSnapshot());
    world.timestep = DT;
    return new Sim(world, new Map(this.stones), this.table);
  }

  free() {
    this.world.free();
  }

  has(id: number) {
    return this.stones.has(id);
  }

  ids(): number[] {
    return [...this.stones.keys()];
  }

  shapeOf(id: number): Shape | undefined {
    return this.stones.get(id)?.shape;
  }

  private body(id: number): RAPIER.RigidBody | null {
    const e = this.stones.get(id);
    return e ? this.world.getRigidBody(e.body) : null;
  }

  add(id: number, shape: Shape, pose: Pose, fixed = false) {
    const desc = (fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
      .setTranslation(...pose.p)
      .setRotation({ x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] })
      .setCanSleep(true);
    const body = this.world.createRigidBody(desc);
    this.world.createCollider(colliderDesc(shape), body);
    this.stones.set(id, { shape, body: body.handle });
  }

  remove(id: number) {
    const b = this.body(id);
    if (b) this.world.removeRigidBody(b);
    this.stones.delete(id);
  }

  wakeAll() {
    this.world.forEachRigidBody((b) => b.wakeUp());
  }

  step(n = 1) {
    for (let i = 0; i < n; i++) this.world.step();
  }

  pose(id: number): Pose | null {
    const b = this.body(id);
    if (!b) return null;
    const t = b.translation();
    const r = b.rotation();
    return { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
  }

  poses(): { id: number; shape: Shape; pose: Pose }[] {
    const out: { id: number; shape: Shape; pose: Pose }[] = [];
    for (const [id, e] of this.stones) out.push({ id, shape: e.shape, pose: this.pose(id)! });
    return out;
  }

  isFallen(id: number): boolean {
    const p = this.pose(id);
    if (!p) return false;
    return (
      p.p[1] < FALL_Y ||
      Math.hypot(p.p[0], p.p[2]) > OUT_OF_BOUNDS ||
      lowestY(this.stones.get(id)!.shape, p) < -BASE_HEIGHT + TABLE_TOUCH
    );
  }

  fallen(): number[] {
    return this.ids().filter((id) => this.isFallen(id));
  }

  /** Fastest linear/angular speed among stones still in play. */
  maxSpeed(): number {
    let max = 0;
    for (const id of this.stones.keys()) {
      if (this.isFallen(id)) continue;
      const b = this.body(id)!;
      if (b.isSleeping()) continue;
      const v = b.linvel();
      const w = b.angvel();
      max = Math.max(max, Math.hypot(v.x, v.y, v.z), Math.hypot(w.x, w.y, w.z) * 0.5);
    }
    return max;
  }

  /** Highest point of the tower (roughly: stone centres plus their bounding radius). */
  topY(): number {
    let top = 0;
    for (const s of this.poses()) if (s.pose.p[1] >= FALL_Y) top = Math.max(top, s.pose.p[1] + boundingRadius(s.shape));
    return top;
  }

  /**
   * Where a stone held at (x, z) with rotation q comes to rest if lowered
   * straight down: just above the first thing it touches. Null when it would
   * miss the base and the tower (land on the table) or is out of reach.
   */
  dropPose(shape: Shape, x: number, z: number, q: Pose['q']): Pose | null {
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) > OUT_OF_BOUNDS) return null;
    const startY = this.topY() + boundingRadius(shape) + 1;
    const rot = { x: q[0], y: q[1], z: q[2], w: q[3] };
    const cast = colliderDesc(shape).shape;
    // Test every collider directly: the world's broad phase only catches up
    // on the next step, so a world query would miss freshly added stones.
    let best: { toi: number; collider: RAPIER.Collider } | null = null;
    const still = { x: 0, y: 0, z: 0 };
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.forEachCollider((c) => {
      const hit = c.castShape(still, cast, { x, y: startY, z }, rot, { x: 0, y: -1, z: 0 }, 0, startY + 10, true);
      if (hit && (!best || hit.time_of_impact < best.toi)) best = { toi: hit.time_of_impact, collider: c };
    });
    const hit = best as { toi: number; collider: RAPIER.Collider } | null;
    if (!hit || hit.collider.handle === this.table) return null;
    const hitBody = hit.collider.parent();
    for (const [id, e] of this.stones) if (e.body === hitBody?.handle && this.isFallen(id)) return null;
    return { p: [x, startY - hit.toi + DROP_GAP, z], q };
  }
}

export function normalizeQuat(q: unknown): Pose['q'] | null {
  if (!Array.isArray(q) || q.length !== 4 || !q.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const len = Math.hypot(...(q as number[]));
  if (len < 1e-6) return null;
  return (q as number[]).map((n) => n / len) as Pose['q'];
}
