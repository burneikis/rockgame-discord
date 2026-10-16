import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Sim, initPhysics } from '../src/shared/physics';
import { BASE_HEIGHT, placementRotation, randomPentagon, type BaseId, type Pose, type Shape, type StoneRef } from '../src/shared/stones';
import { SHAPE_COLORS, baseGeometry, geometryFor, noiseTexture, woodTexture } from '../src/client/stage';

/**
 * Discord activity art (cover, background, icon) built from the game's own
 * assets: the same stone geometry, colours and textures, the base rocks, the
 * oak table and the die. Towers are stacked with the real physics, so every
 * pose is one the game could produce.
 *
 * window.__ready is set once the frame is drawn (art/shoot.mjs waits on it).
 */

const mode = new URLSearchParams(location.search).get('m') ?? 'cover';

// Seeded random so the pentagons (and the picture) are the same every render.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

interface Drop { shape: Shape; x?: number; z?: number; yaw?: number; tilt?: number }
interface Toss { shape: Shape; x: number; z: number; yaw?: number; tilt?: number; y?: number }
type Placed = { shape: Shape; points?: [number, number][]; pose: Pose };

const ref = (shape: Shape): { shape: Shape; points?: [number, number][] } =>
  shape === 'pentagon' ? { shape, points: randomPentagon(rand) } : { shape };

/** Stack stones one by one (each lowered onto the tower like a player would), letting it settle in between. */
function stack(base: BaseId, drops: Drop[], tossed: Toss[] = []): Placed[] {
  const sim = Sim.create(base);
  let id = 1;
  for (const d of drops) {
    const r = ref(d.shape);
    const pose = sim.dropPose(r, d.x ?? 0, d.z ?? 0, placementRotation(d.yaw ?? 0, d.tilt ?? 0));
    if (!pose) {
      console.warn('missed', d);
      continue;
    }
    sim.add(id++, r, pose);
    sim.wakeAll();
    sim.step(240);
  }
  const fell = sim.fallen();
  if (fell.length) console.warn('fell', fell);
  // Stones lying on the table (already fallen), dropped from just above it.
  for (const t of tossed) {
    const r = ref(t.shape);
    sim.add(id++, r, { p: [t.x, t.y ?? -BASE_HEIGHT + 0.6, t.z], q: placementRotation(t.yaw ?? 0, t.tilt ?? 0) });
  }
  sim.step(300);
  const out = sim.poses();
  sim.free();
  return out;
}

// ------------------------------------------------------------------ scene

const W = innerWidth;
const H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(W, H);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 200);

scene.add(new THREE.HemisphereLight('#fff4e0', '#3a2a1c', 0.9));
const sun = new THREE.DirectionalLight('#fff1dc', 2.4);
sun.position.set(6, 12, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -12, bottom: -12, right: 12, top: 12, near: 1, far: 50 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 4;
scene.add(sun);
const fill = new THREE.DirectionalLight('#b8d0ff', 0.5);
fill.position.set(-6, 4, -5);
scene.add(fill);
// Warm rim light from behind so the tower separates from the dark background.
const rim = new THREE.DirectionalLight('#ffcf8a', 1.6);
rim.position.set(-3, 6, -9);
scene.add(rim);

const wood = woodTexture();
wood.repeat.set(7.5, 7.5); // same plank size as the game (3 per 16 units)
const table = new THREE.Mesh(new THREE.CircleGeometry(40, 128), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.75 }));
table.rotation.x = -Math.PI / 2;
table.position.y = -BASE_HEIGHT;
table.receiveShadow = true;
scene.add(table);

const granite = noiseTexture(256, [62, 62, 66], 36, 8, 3);
function addBase(id: BaseId) {
  const m = new THREE.Mesh(baseGeometry(id), new THREE.MeshStandardMaterial({ map: granite, roughness: 0.55, metalness: 0.05 }));
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
}

const stoneTex = noiseTexture(256, [225, 225, 225], 40, 14, 11);
function addStones(stones: Placed[]) {
  for (const s of stones) {
    const mat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.85, color: SHAPE_COLORS[s.shape] });
    const m = new THREE.Mesh(geometryFor(s as StoneRef), mat);
    m.position.set(...s.pose.p);
    m.quaternion.set(...s.pose.q);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
}

/** The die from the HUD (bone white, dark pips) as a rounded cube. */
function addDie(size: number, p: [number, number, number], rot: [number, number, number], top = 6) {
  const PIPS: Record<number, [number, number][]> = {
    1: [[1, 1]],
    2: [[0, 0], [2, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
    6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
  };
  const face = (n: number) => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 256, 256);
    grad.addColorStop(0, '#faf6ef');
    grad.addColorStop(1, '#d8cfc2');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#2a231c';
    for (const [x, y] of PIPS[n]) {
      g.beginPath();
      g.arc(52 + x * 76, 52 + y * 76, 22, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.35 });
  };
  // Box face order: +x, -x, +y, -y, +z, -z. Opposite faces add up to 7.
  const side = top === 6 || top === 1 ? [3, 4, 2, 5] : top === 5 || top === 2 ? [3, 4, 1, 6] : [2, 5, 1, 6];
  const faces = [side[0], side[1], top, 7 - top, side[2], side[3]].map(face);
  const m = new THREE.Mesh(new RoundedBoxGeometry(size, size, size, 4, size * 0.14), faces);
  m.position.set(...p);
  m.rotation.set(...rot);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
}

function overlay(html: string, top: string) {
  const t = document.createElement('div');
  t.className = 'title';
  t.style.top = top;
  t.innerHTML = html;
  document.body.appendChild(t);
}

const TABLE_Y = -BASE_HEIGHT;

// ------------------------------------------------------------------ modes

await initPhysics();

if (mode === 'icon') {
  // A chunky cairn that still reads at 32px, filling the square.
  addBase('stump');
  addStones(
    stack('stump', [
      { shape: 'square', yaw: 0.35 },
      { shape: 'circle', x: 0.04 },
      { shape: 'cube', yaw: 0.6 },
      { shape: 'triangle', yaw: 0.2 },
      { shape: 'circle', x: -0.02 },
    ]),
  );
  addDie(0.55, [1.05, TABLE_Y + 0.275, 0.85], [0, 0.5, 0], 6);
  camera.fov = 34;
  camera.position.set(0.6, 1.8, 5.6);
  camera.lookAt(0.12, 0.62, 0);
  document.body.style.background = 'radial-gradient(circle at 50% 42%, #6a4f33 0%, #3a2e22 38%, #15110d 80%)';
  table.visible = true;
  scene.fog = new THREE.Fog('#15110d', 6, 13);
} else if (mode === 'bg') {
  // Top-down view of the table: fallen stones and the die around the edges, the centre left clear for Discord's UI.
  const edge: Toss[] = [
    { shape: 'square', x: -7.6, z: -3.6, yaw: 0.4 },
    { shape: 'triangle', x: -6.2, z: -4.1, yaw: 1.1 },
    { shape: 'circle', x: -8.3, z: -1.9 },
    { shape: 'shaft', x: -7.4, z: 0.4, yaw: 1.9 },
    { shape: 'pentagon', x: -8.1, z: 2.6, yaw: 0.7 },
    { shape: 'cube', x: -6.6, z: 3.9, yaw: 0.3 },
    { shape: 'circle', x: -4.6, z: 4.6 },
    { shape: 'shaft', x: 4.4, z: -4.5, yaw: 0.25 },
    { shape: 'cube', x: 6.7, z: -3.9, yaw: 0.9 },
    { shape: 'pentagon', x: 8.2, z: -2.2, yaw: 2.2 },
    { shape: 'triangle', x: 7.5, z: 0.2, yaw: 0.4 },
    { shape: 'square', x: 8.0, z: 2.6, yaw: 1.2 },
    { shape: 'circle', x: 6.4, z: 4.1 },
    { shape: 'triangle', x: -3.0, z: -4.8, yaw: 2.6 },
    { shape: 'square', x: 3.4, z: 4.9, yaw: 0.8 },
  ];
  addStones(stack('needle', [], edge));
  addDie(0.75, [-5.3, TABLE_Y + 0.375, -3.0], [0, 0.6, 0], 5);
  addDie(0.75, [5.6, TABLE_Y + 0.375, 2.9], [0, -0.4, 0], 2);
  camera.fov = 40;
  camera.position.set(0, 12.5, 2.2);
  camera.lookAt(0, TABLE_Y, 0);
  sun.position.set(4, 14, 6);
  // Stretch the grain along the planks so the texture's tile seams fall outside the view.
  wood.repeat.set(7.5, 2.5);
  document.body.style.background = '#15110d';
  // Darken the middle so UI on top stays readable.
  const v = document.querySelector<HTMLElement>('.vignette')!;
  v.style.background = 'radial-gradient(ellipse 60% 70% at 50% 50%, #15110db3 0%, #15110d80 45%, #15110d26 80%, #0000 100%), radial-gradient(ellipse at 50% 50%, #0000 60%, #0008 100%)';
} else {
  // Cover: a tall tower on the millstone, a stone that just fell, the die on the table, and the title.
  addBase('millstone');
  addStones(
    stack(
      'millstone',
      [
        { shape: 'square', yaw: 0.3 },
        { shape: 'pentagon', x: 0.05, yaw: 1.0 },
        { shape: 'cube', yaw: 0.55 },
        { shape: 'shaft', yaw: 1.25 },
        { shape: 'circle', x: 0.0 },
        { shape: 'triangle', yaw: 0.9 },
        { shape: 'cube', yaw: 0.15 },
        { shape: 'circle' },
      ],
      [
        { shape: 'triangle', x: 2.0, z: -0.6, yaw: 0.6 },
        { shape: 'shaft', x: -2.0, z: 1.4, yaw: 2.4 },
        { shape: 'pentagon', x: -1.8, z: -1.0, yaw: 1.2 },
      ],
    ),
  );
  addDie(0.6, [1.55, TABLE_Y + 0.3, 1.6], [0, 0.45, 0], 6);
  camera.fov = 32;
  camera.position.set(0, 2.4, 9.2);
  camera.lookAt(0, 1.3, 0);
  // Tower right of centre, title left; both inside the middle ~65% so a 13:11 crop keeps them.
  camera.setViewOffset(W, H, -W * 0.1, 0, W, H);
  scene.fog = new THREE.Fog('#15110d', 9, 20);
  document.body.style.background = 'radial-gradient(ellipse at 66% 40%, #5a4430 0%, #3a2e22 30%, #15110d 75%)';
  overlay(
    `<div class="logo" style="font-size:${H * 0.15}px">ROCK<br>GAME</div>
     <div class="sub" style="font-size:${H * 0.04}px;margin-top:${H * 0.03}px">a stone stacking game</div>`,
    '30%',
  );
  document.querySelector<HTMLElement>('.title')!.style.left = '36%';
}

camera.aspect = W / H;
camera.updateProjectionMatrix();
renderer.render(scene, camera);
(window as unknown as { __ready: boolean }).__ready = true;
