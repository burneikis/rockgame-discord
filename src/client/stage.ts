import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Sim, initPhysics } from '../shared/physics';
import { BASE_HEIGHT, DEFAULT_BASE, FALL_Y, SHAPES, baseOutline, boundingRadius, geometryOf, outlineRadius, placementRotation, type BaseId, type Pose, type Shape, type Stone, type StoneRef } from '../shared/stones';
import type { BodyFrame, TowerStone } from '../shared/protocol';

/**
 * The 3D table: renders the stones the server simulates (interpolating
 * between snapshots), shows a ghost of the stone you're about to place
 * (dropped onto the tower with a local copy of the physics world), and lets
 * you click stones to pick them up.
 */

export type StageMode =
  | { kind: 'idle' }
  | {
      kind: 'place';
      stone: Stone;
      onPlace: (x: number, z: number, q: Pose['q']) => void;
      onAim: (pose: Pose | null) => void;
    }
  | { kind: 'pickup'; onPick: (id: number) => void };

export const SHAPE_COLORS: Record<Shape, string> = {
  circle: '#c9cdd1',
  shaft: '#b8aa98',
  triangle: '#d4c3a6',
  square: '#a9b6c0',
  pentagon: '#c7b39c',
  cube: '#9ea7ae',
};

const CLICK_PX = 6;
const CLICK_MS = 600;
const YAW_STEP = Math.PI / 8;

type StoneKind = { shape: Shape; points?: [number, number][] };
interface Body { mesh: THREE.Mesh; stone: StoneKind; from: Pose; to: Pose }

/** Cache key: the shape, or a pentagon's own outline. */
const geometryKey = (ref: StoneRef) =>
  typeof ref === 'string' ? ref : ref.shape === 'pentagon' && ref.points ? `pentagon:${ref.points.join(';')}` : ref.shape;

const geometryCache = new Map<string, THREE.BufferGeometry>();
export function geometryFor(ref: StoneRef): THREE.BufferGeometry {
  const key = geometryKey(ref);
  let geo = geometryCache.get(key);
  if (geo) return geo;
  const g = geometryOf(ref);
  if (g.kind === 'box') geo = new RoundedBoxGeometry(g.hx * 2, g.hy * 2, g.hz * 2, 2, 0.025);
  else if (g.kind === 'cylinder') geo = new THREE.CylinderGeometry(g.radius, g.radius, g.height, 48);
  else if (g.kind === 'polygon') geo = polygonGeometry(g.points, -g.height / 2, g.height / 2);
  else {
    // Same vertex layout as the physics convex hull; split for flat faces.
    geo = new THREE.CylinderGeometry(g.radius, g.radius, g.height, g.sides).toNonIndexed();
    geo.computeVertexNormals();
  }
  geometryCache.set(key, geo);
  return geo;
}

/** Flat-shaded prism of an x/z outline, spanning y = bottom..top. */
function polygonGeometry(points: [number, number][], bottom: number, top: number): THREE.BufferGeometry {
  // Extrude along +z, then turn so the extrusion runs up y. rotateX(-90deg) maps
  // (x, y, z) to (x, z, -y), so outline point (x, z) is drawn at shape (x, -z).
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottom, 0);
  geo.computeVertexNormals();
  return geo;
}

export function baseGeometry(id: BaseId): THREE.BufferGeometry {
  const o = baseOutline(id);
  if (o.kind === 'polygon') return polygonGeometry(o.points, -BASE_HEIGHT, 0);
  const geo = new THREE.CylinderGeometry(o.radius, o.radius * 1.04, BASE_HEIGHT, 96);
  geo.translate(0, -BASE_HEIGHT / 2, 0);
  return geo;
}

export function noiseTexture(size: number, base: [number, number, number], spread: number, veins: number, seed = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = (rnd() - 0.5) * spread;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.globalAlpha = 0.08;
  for (let v = 0; v < veins; v++) {
    ctx.strokeStyle = rnd() < 0.5 ? '#ffffff' : '#000000';
    ctx.lineWidth = 0.5 + rnd() * 1.5;
    ctx.beginPath();
    let x = rnd() * size;
    let y = rnd() * size;
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) ctx.lineTo((x += (rnd() - 0.5) * 60), (y += (rnd() - 0.5) * 60));
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Light oak planks with grain. */
export function woodTexture(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  let s = 5;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const planks = 4;
  const w = size / planks;
  for (let i = 0; i < planks; i++) {
    const hue = 28 + rnd() * 6;
    const light = 30 + rnd() * 7;
    ctx.fillStyle = `hsl(${hue} 34% ${light}%)`;
    ctx.fillRect(i * w, 0, w, size);
    for (let g = 0; g < 40; g++) {
      ctx.strokeStyle = `hsla(${hue - 6} 45% ${light - 12}% / ${0.15 + rnd() * 0.25})`;
      ctx.lineWidth = 0.5 + rnd() * 1.5;
      const x = i * w + rnd() * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      for (let y = 0; y <= size; y += 32) ctx.lineTo(x + Math.sin(y / 60 + g) * 3, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#0005';
    ctx.fillRect(i * w, 0, 2, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function setPose(obj: THREE.Object3D, pose: Pose) {
  obj.position.set(...pose.p);
  obj.quaternion.set(...pose.q);
}

const tmpQa = new THREE.Quaternion();
const tmpQb = new THREE.Quaternion();

export class Stage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private bodies = new Map<number, Body>();
  private stoneMaterial: THREE.MeshStandardMaterial;
  private base: THREE.Mesh;
  private baseId: BaseId = DEFAULT_BASE;
  private raycaster = new THREE.Raycaster();
  private frameTick = -1;
  private frameAt = 0;
  private frameDur = 50;
  private raf = 0;
  private resize: ResizeObserver;
  private sim: Sim | null = null;
  private simKey = '';
  private physicsReady = false;
  private pendingTower: TowerStone[] | null = null;

  private mode: StageMode = { kind: 'idle' };
  private ghost: THREE.Mesh | null = null;
  private ghostKey: number | null = null;
  /** Every stone seen in a full state (so body frames can find pentagon outlines). */
  private known = new Map<number, StoneKind>();
  private ghostPose: Pose | null = null;
  private aimXZ: [number, number] | null = null;
  private yaw = 0;
  private tilt = 0;
  private otherGhost: THREE.Mesh | null = null;
  private hovered: number | null = null;
  private down: { x: number; y: number; t: number } | null = null;
  /** Tells the UI whether the ghost can be dropped right now (for the touch Drop button). */
  onGhostChange: (valid: boolean) => void = () => {};

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.camera.position.set(0, 4.6, 7.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.8, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 28;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.update();

    this.scene.background = new THREE.Color('#1b1611');
    this.scene.fog = new THREE.Fog('#1b1611', 18, 45);
    const hemi = new THREE.HemisphereLight('#fff4e0', '#3a2a1c', 0.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
    sun.position.set(6, 12, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -8;
    sc.right = sc.top = 8;
    sc.near = 1;
    sc.far = 40;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 3;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#b8d0ff', 0.5);
    fill.position.set(-6, 4, -5);
    this.scene.add(fill);

    // Table
    const wood = woodTexture();
    wood.repeat.set(3, 3);
    const table = new THREE.Mesh(
      new THREE.CircleGeometry(16, 64),
      new THREE.MeshStandardMaterial({ map: wood, roughness: 0.75 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -BASE_HEIGHT;
    table.receiveShadow = true;
    this.scene.add(table);

    // Base: a dark granite pedestal
    const granite = noiseTexture(256, [62, 62, 66], 36, 8, 3);
    this.base = new THREE.Mesh(
      baseGeometry(this.baseId),
      new THREE.MeshStandardMaterial({ map: granite, roughness: 0.55, metalness: 0.05 }),
    );
    this.base.castShadow = this.base.receiveShadow = true;
    this.scene.add(this.base);

    this.stoneMaterial = new THREE.MeshStandardMaterial({
      map: noiseTexture(256, [225, 225, 225], 40, 14, 11),
      roughness: 0.85,
      metalness: 0,
    });

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointerleave', this.onPointerLeave);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.loop();

    if (import.meta.env.DEV) Object.assign(window, { __stage: this, __three: THREE });
    void initPhysics().then(() => {
      this.physicsReady = true;
      if (this.pendingTower) this.rebuildSim(this.pendingTower);
    });
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    this.controls.dispose();
    this.renderer.dispose();
    el.remove();
    this.sim?.free();
    this.sim = null;
  }

  private fit() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // Keep the base in view on narrow (portrait) screens.
    this.camera.fov = w / h < 1 ? 60 : 45;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ bodies

  setBase(id: BaseId) {
    if (id === this.baseId) return;
    this.baseId = id;
    this.base.geometry.dispose();
    this.base.geometry = baseGeometry(id);
    this.simKey = '';
    if (this.physicsReady && this.pendingTower) this.rebuildSim(this.pendingTower);
  }

  /** Full tower from a state message. */
  setTower(tick: number, stones: TowerStone[]) {
    for (const s of stones) this.known.set(s.id, { shape: s.shape, points: s.points });
    this.applyPoses(tick, stones);
    this.pendingTower = stones;
    if (this.physicsReady) this.rebuildSim(stones);
  }

  /** Streamed snapshot while the tower moves. */
  pushFrame(tick: number, frames: BodyFrame[]) {
    this.applyPoses(
      tick,
      frames.map((f) => ({
        id: f[0],
        shape: SHAPES[f[1]],
        points: this.known.get(f[0])?.points,
        pose: { p: [f[2], f[3], f[4]], q: [f[5], f[6], f[7], f[8]] },
      })),
    );
  }

  private applyPoses(tick: number, stones: TowerStone[]) {
    if (tick < this.frameTick) return;
    const now = performance.now();
    if (tick > this.frameTick) {
      this.frameDur = Math.min(120, Math.max(30, now - this.frameAt));
      this.frameAt = now;
    }
    this.frameTick = tick;
    const seen = new Set<number>();
    for (const s of stones) {
      seen.add(s.id);
      const b = this.bodies.get(s.id);
      if (b) {
        b.from = { p: b.mesh.position.toArray() as Pose['p'], q: b.mesh.quaternion.toArray() as Pose['q'] };
        b.to = s.pose;
      } else {
        const mat = this.stoneMaterial.clone();
        mat.color.set(SHAPE_COLORS[s.shape]);
        const mesh = new THREE.Mesh(geometryFor(s), mat);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.stoneId = s.id;
        setPose(mesh, s.pose);
        this.scene.add(mesh);
        this.bodies.set(s.id, { mesh, stone: { shape: s.shape, points: s.points }, from: s.pose, to: s.pose });
      }
    }
    for (const [id, b] of this.bodies) {
      if (seen.has(id)) continue;
      this.scene.remove(b.mesh);
      (b.mesh.material as THREE.Material).dispose();
      this.bodies.delete(id);
      if (this.hovered === id) this.hovered = null;
    }
  }

  /** Local static copy of the tower, used to drop the ghost stone onto it. */
  private rebuildSim(stones: TowerStone[]) {
    const key = stones.map((s) => `${s.id}:${s.pose.p.join(',')}`).join('|');
    if (key === this.simKey && this.sim) return;
    this.simKey = key;
    this.sim?.free();
    this.sim = Sim.create(this.baseId);
    for (const s of stones) this.sim.add(s.id, s, s.pose, true);
    this.recomputeGhost();
  }

  private towerTop(): number {
    let top = 0;
    for (const b of this.bodies.values()) if (b.to.p[1] > FALL_Y) top = Math.max(top, b.to.p[1] + boundingRadius(b.stone));
    return top;
  }

  // ------------------------------------------------------------ modes

  setMode(mode: StageMode) {
    const prev = this.mode;
    this.mode = mode;
    if (mode.kind !== 'pickup') this.setHovered(null);
    if (mode.kind === 'place') {
      if (this.ghostKey !== mode.stone.id) {
        this.ghost && this.scene.remove(this.ghost);
        this.ghost = this.makeGhost(mode.stone, '#7dffa8');
        this.ghostKey = mode.stone.id;
        this.scene.add(this.ghost);
      }
      if (prev.kind !== 'place' || prev.stone.id !== mode.stone.id) this.recomputeGhost();
    } else {
      if (this.ghost) this.scene.remove(this.ghost);
      this.ghost = null;
      this.ghostKey = null;
      this.ghostPose = null;
      if (prev.kind === 'place') this.onGhostChange(false);
    }
    this.renderer.domElement.style.cursor = mode.kind === 'idle' ? 'grab' : 'crosshair';
  }

  private makeGhost(stone: StoneRef, color: string): THREE.Mesh {
    const mesh = new THREE.Mesh(
      geometryFor(stone),
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.55, roughness: 0.6, depthWrite: false }),
    );
    mesh.renderOrder = 2;
    mesh.visible = false;
    return mesh;
  }

  rotate(steps: number) {
    this.yaw += steps * YAW_STEP;
    this.recomputeGhost();
  }

  tip() {
    this.tilt = (this.tilt + 1) % 3;
    this.recomputeGhost();
  }

  /** Drop the ghost where it is (the touch-screen Drop button). */
  drop() {
    if (this.mode.kind !== 'place' || !this.ghostPose || !this.aimXZ) return;
    this.mode.onPlace(this.aimXZ[0], this.aimXZ[1], this.ghostPose.q);
  }

  /** Show another player's stone hovering where they aim. */
  setOtherAim(stone: Stone | null, pose: Pose | null) {
    if (this.otherGhost && (!stone || this.otherGhost.userData.stoneId !== stone.id)) {
      this.scene.remove(this.otherGhost);
      this.otherGhost = null;
    }
    if (!stone || !pose) {
      if (this.otherGhost) this.otherGhost.visible = false;
      return;
    }
    if (!this.otherGhost) {
      this.otherGhost = this.makeGhost(stone, '#8fd6ff');
      this.otherGhost.userData.stoneId = stone.id;
      this.scene.add(this.otherGhost);
    }
    this.otherGhost.visible = true;
    setPose(this.otherGhost, pose);
  }

  private recomputeGhost() {
    const mode = this.mode;
    if (mode.kind !== 'place' || !this.ghost) return;
    const q = placementRotation(this.yaw, this.tilt);
    if (!this.aimXZ || !this.sim) {
      this.ghost.visible = false;
      this.ghostPose = null;
      this.onGhostChange(false);
      mode.onAim(null);
      return;
    }
    const [x, z] = this.aimXZ;
    const pose = this.sim.dropPose(mode.stone, x, z, q);
    const mat = this.ghost.material as THREE.MeshStandardMaterial;
    this.ghost.visible = true;
    if (pose) {
      setPose(this.ghost, pose);
      mat.color.set('#7dffa8');
    } else {
      setPose(this.ghost, { p: [x, this.towerTop() + 0.6, z], q });
      mat.color.set('#ff6b6b');
    }
    this.ghostPose = pose;
    this.onGhostChange(!!pose);
    mode.onAim(pose);
  }

  // ------------------------------------------------------------ pointer

  private ndc(e: PointerEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private stoneMeshes(): THREE.Mesh[] {
    return [...this.bodies.values()].filter((b) => b.to.p[1] > FALL_Y).map((b) => b.mesh);
  }

  private aimAt(e: PointerEvent) {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.intersectObjects([...this.stoneMeshes(), this.base], false)[0];
    let point: THREE.Vector3 | null = hit?.point ?? null;
    if (!point) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      point = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    }
    this.aimXZ = point && Math.hypot(point.x, point.z) < outlineRadius(baseOutline(this.baseId)) + 3 ? [point.x, point.z] : null;
    this.recomputeGhost();
  }

  private stoneAt(e: PointerEvent): number | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.intersectObjects(this.stoneMeshes(), false)[0];
    return hit ? (hit.object.userData.stoneId as number) : null;
  }

  private setHovered(id: number | null) {
    if (this.hovered === id) return;
    const prev = this.hovered !== null ? this.bodies.get(this.hovered) : null;
    if (prev) (prev.mesh.material as THREE.MeshStandardMaterial).emissive.set('#000000');
    this.hovered = id;
    const next = id !== null ? this.bodies.get(id) : null;
    if (next) (next.mesh.material as THREE.MeshStandardMaterial).emissive.set('#5a3c00');
  }

  private onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    if (this.mode.kind === 'place') this.aimAt(e);
    else if (this.mode.kind === 'pickup') this.setHovered(this.stoneAt(e));
  };

  private onPointerLeave = () => {
    if (this.mode.kind === 'pickup') this.setHovered(null);
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX || performance.now() - d.t > CLICK_MS) return;
    const mode = this.mode;
    if (mode.kind === 'place') {
      this.aimAt(e);
      // Mouse: click drops. Touch: a tap only moves the ghost; the Drop button drops it.
      if (e.pointerType === 'mouse') this.drop();
    } else if (mode.kind === 'pickup') {
      // Mouse: click picks. Touch: the first tap highlights, a second tap on it picks.
      const id = this.stoneAt(e);
      const confirmed = e.pointerType === 'mouse' || this.hovered === id;
      this.setHovered(id);
      if (id !== null && confirmed) mode.onPick(id);
    }
  };

  // ------------------------------------------------------------ render

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const alpha = Math.min(1, (performance.now() - this.frameAt) / this.frameDur);
    for (const b of this.bodies.values()) {
      const m = b.mesh;
      m.position.set(
        b.from.p[0] + (b.to.p[0] - b.from.p[0]) * alpha,
        b.from.p[1] + (b.to.p[1] - b.from.p[1]) * alpha,
        b.from.p[2] + (b.to.p[2] - b.from.p[2]) * alpha,
      );
      tmpQa.set(...b.from.q);
      tmpQb.set(...b.to.q);
      m.quaternion.slerpQuaternions(tmpQa, tmpQb, alpha);
    }
    // Follow the tower up as it grows, without fighting the user's orbiting.
    const want = Math.max(0.6, this.towerTop() * 0.5);
    const dy = (want - this.controls.target.y) * 0.04;
    if (Math.abs(dy) > 1e-4) {
      this.controls.target.y += dy;
      this.camera.position.y += dy;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
