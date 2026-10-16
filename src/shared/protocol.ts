import type { Action, GameEvent, GameOptions, LogEntry, Step } from './engine';
import type { Pose, Shape, Stone } from './stones';

export interface MemberView { id: string; name: string; isBot: boolean; connected: boolean }

export interface PlayerView {
  id: string;
  name: string;
  isBot: boolean;
  connected: boolean;
  supply: Stone[];
}

export interface TowerStone { id: number; shape: Shape; pose: Pose }

export interface GameView {
  step: Step;
  turnId: string | null;
  roll: number | null;
  remaining: number;
  /** Stone ids the current player may place next. */
  allowed: number[];
  players: PlayerView[];
  /** Physics tick these poses belong to. */
  tick: number;
  tower: TowerStone[];
  lastPlaced: number | null;
  log: LogEntry[];
  events: GameEvent[];
  /** Milliseconds left on the turn timer (null = no timer). */
  timeLeftMs: number | null;
  winner: string | null;
  options: GameOptions;
}

export interface RoomView {
  id: string;
  hostId: string | null;
  sets: number;
  /** Turn timer in seconds, 0 = off. */
  turnSeconds: number;
  members: MemberView[];
}

/** Body snapshot while the tower moves: [id, shape index, px, py, pz, qx, qy, qz, qw]. */
export type BodyFrame = number[];

/** Someone's stone held over the tower (before they drop it). */
export interface Aim { playerId: string; shape: Shape; pose: Pose | null }

export type ServerMessage =
  | { type: 'state'; you: string; devMode: boolean; room: RoomView; game: GameView | null }
  | { type: 'bodies'; tick: number; bodies: BodyFrame[] }
  | { type: 'aim'; aim: Aim }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export type ClientMessage =
  | { type: 'join'; roomId: string; playerId: string; name: string; accessToken?: string }
  | { type: 'addBot' }
  | { type: 'kick'; playerId: string }
  /** Take a seat again (e.g. after being removed from the lobby). */
  | { type: 'sit' }
  | { type: 'ping' }
  | { type: 'setOptions'; sets?: number; turnSeconds?: number }
  | { type: 'start' }
  | { type: 'act'; action: Action }
  | { type: 'aim'; shape: Shape | null; pose: Pose | null }
  | { type: 'endGame' }
  | { type: 'rigRoll'; value: number };

export const TURN_TIMER_CHOICES = [0, 20, 30, 45, 60, 90];
export const MAX_PLAYERS = 6;

/** How long the client's die tumbles before showing the face. */
export const ROLL_MS = 900;
