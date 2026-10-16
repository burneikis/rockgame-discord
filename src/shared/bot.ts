import type { Action, Game } from './engine';
import { Sim } from './physics';
import { BASE_RADIUS, VALUE, placementRotation, type Pose, type Shape, type Stone } from './stones';

/**
 * Bot: tries candidate moves in cloned physics worlds and keeps the one that
 * disturbs the tower least. Also plays for timed-out or disconnected players.
 */

const TRY_TICKS = 75;
const SHORTLIST = 8;

export function botAction(game: Game, rand: () => number = Math.random): Action {
  if (game.step === 'roll') return { kind: 'roll' };
  if (game.step === 'pickup') return pickupAction(game);
  return placeAction(game, rand);
}

/** How much the tower moved (and how much fell) after a trial. */
function disturbance(before: Sim, after: Sim): { fell: number; moved: number } {
  let fell = 0;
  let moved = 0;
  for (const id of after.ids()) {
    const a = after.pose(id)!;
    if (after.isFallen(id)) fell++;
    const b = before.pose(id);
    if (b) moved += Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
  }
  return { fell, moved };
}

interface Candidate { stone: Stone; x: number; z: number; q: Pose['q']; pose: Pose; guess: number }

function placeAction(game: Game, rand: () => number): Action {
  const allowed = game.allowed();
  const byShape = new Map<Shape, Stone>();
  for (const s of allowed) if (!byShape.has(s.shape)) byShape.set(s.shape, s);
  const tower = game.sim.poses().filter((s) => !game.sim.isFallen(s.id));

  // Spots to try: the base, and on top of every stone.
  const spots: [number, number][] = [[0, 0]];
  for (let i = 0; i < 6; i++) {
    const r = Math.sqrt(rand()) * BASE_RADIUS * 0.7;
    const a = rand() * Math.PI * 2;
    spots.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  for (const s of tower) {
    spots.push([s.pose.p[0], s.pose.p[2]]);
    spots.push([s.pose.p[0] + (rand() - 0.5) * 0.3, s.pose.p[2] + (rand() - 0.5) * 0.3]);
  }

  const cands: Candidate[] = [];
  for (const stone of byShape.values()) {
    for (const [x, z] of spots) {
      const yaw = rand() * Math.PI * 2;
      const q = placementRotation(yaw, 0);
      const pose = game.sim.dropPose(stone.shape, x, z, q);
      if (!pose) continue;
      // Lower and more central is safer; fewer pips per stone sheds more stones.
      const guess = -pose.p[1] * 0.6 - Math.hypot(x, z) * 0.25 - VALUE[stone.shape] * 0.05 + rand() * 0.2;
      cands.push({ stone, x, z, q, pose, guess });
    }
  }
  if (!cands.length) {
    const stone = allowed[0];
    return { kind: 'place', stoneId: stone.id, x: 0, z: 0, q: [0, 0, 0, 1] };
  }
  cands.sort((a, b) => b.guess - a.guess);

  let best = cands[0];
  let bestScore = -Infinity;
  for (const c of cands.slice(0, SHORTLIST)) {
    const trial = game.sim.clone();
    try {
      trial.add(-1, c.stone.shape, c.pose);
      trial.step(TRY_TICKS);
      const { fell, moved } = disturbance(game.sim, trial);
      const self = trial.pose(-1)!;
      const slid = Math.hypot(self.p[0] - c.pose.p[0], self.p[1] - c.pose.p[1], self.p[2] - c.pose.p[2]);
      const score = -fell * 100 - moved * 4 - slid * 6 + c.guess;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    } finally {
      trial.free();
    }
  }
  return { kind: 'place', stoneId: best.stone.id, x: best.x, z: best.z, q: best.q };
}

function pickupAction(game: Game): Action {
  // Taking from the top is usually safest; try the highest few and keep the calmest.
  const tower = game.sim
    .poses()
    .filter((s) => !game.sim.isFallen(s.id))
    .sort((a, b) => b.pose.p[1] - a.pose.p[1])
    .slice(0, 6);
  let best = tower[0].id;
  let bestScore = -Infinity;
  for (const s of tower) {
    const trial = game.sim.clone();
    try {
      trial.remove(s.id);
      trial.wakeAll();
      trial.step(TRY_TICKS);
      const { fell, moved } = disturbance(game.sim, trial);
      const score = -fell * 100 - moved * 4;
      if (score > bestScore) {
        bestScore = score;
        best = s.id;
      }
    } finally {
      trial.free();
    }
  }
  return { kind: 'pickup', stoneId: best };
}
