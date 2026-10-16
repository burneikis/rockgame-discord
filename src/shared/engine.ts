import { Sim, normalizeQuat } from './physics';
import { VALUE, allowedStones, canMake, startingSupply, type BaseId, type Pose, type Stone } from './stones';

/**
 * Server-authoritative Rock Game rules. The physics simulation is part of the
 * game state: placing or picking up a stone puts the game in the 'settling'
 * step, and the server calls update() every physics tick until the tower is
 * still again, then resolves what fell.
 */

export type Step = 'roll' | 'place' | 'pickup' | 'settling' | 'over';

export interface GameOptions {
  /** Sets of stones per player: 1 (6 stones) or 2 (tournament, 12 stones). */
  sets: number;
  /** Which base rock the tower is built on. */
  base: BaseId;
}

export interface PlayerState { id: string; name: string; isBot: boolean; supply: Stone[] }

export type Action =
  | { kind: 'roll' }
  | { kind: 'place'; stoneId: number; x: number; z: number; q: Pose['q'] }
  | { kind: 'pickup'; stoneId: number };

type EventBody =
  | { kind: 'roll'; value: number }
  | { kind: 'place'; stoneId: number }
  | { kind: 'pickup'; stoneId: number }
  | { kind: 'fall'; count: number }
  | { kind: 'stuck' }
  | { kind: 'turn' }
  | { kind: 'win' };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type GameEvent = { seq: number; playerId: string } & EventBody;

export interface LogEntry { seq: number; text: string }

/** The tower must be still for this many ticks before a move resolves. */
const QUIET_TICKS = 40;
const QUIET_SPEED = 0.04;
const MIN_SETTLE_TICKS = 15;
/** Give up waiting (a stone rocking forever) after this many ticks. */
const MAX_SETTLE_TICKS = 60 * 8;

export class Game {
  readonly players: PlayerState[];
  readonly options: GameOptions;
  readonly sim: Sim;
  /** Stones on the tower (or fallen, until collected). */
  readonly tower = new Map<number, Stone>();
  turn = 0;
  step: Step = 'roll';
  roll: number | null = null;
  /** Pips still to place this turn. */
  remaining = 0;
  /** Physics ticks simulated so far (clients use it to order snapshots). */
  tick = 0;
  winner: string | null = null;
  lastPlaced: number | null = null;
  log: LogEntry[] = [];
  events: GameEvent[] = [];
  private settling: { kind: 'place' | 'pickup'; stone: Stone; ticks: number; quiet: number } | null = null;
  private seq = 0;
  private nextStoneId = 1;

  constructor(members: { id: string; name: string; isBot: boolean }[], options: GameOptions, private rand: () => number = Math.random) {
    this.options = options;
    this.sim = Sim.create(options.base);
    this.players = members.map((m) => ({ ...m, supply: startingSupply(options.sets, () => this.nextStoneId++, this.rand) }));
    this.turn = Math.floor(this.rand() * this.players.length);
    this.say(`${this.current.name} goes first.`);
    this.emit({ kind: 'turn', playerId: this.current.id });
  }

  get current(): PlayerState {
    return this.players[this.turn];
  }

  get currentTurnId(): string | null {
    return this.step === 'over' ? null : this.current.id;
  }

  player(id: string): PlayerState {
    const p = this.players.find((x) => x.id === id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  }

  /** Stones the current player may place next. */
  allowed(): Stone[] {
    return this.step === 'place' ? allowedStones(this.current.supply, this.remaining) : [];
  }

  dispose() {
    this.sim.free();
  }

  private emit(e: DistributiveOmit<GameEvent, 'seq'>) {
    this.events.push({ ...e, seq: ++this.seq } as GameEvent);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  private say(text: string) {
    this.log.push({ seq: ++this.seq, text });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  act(pid: string, action: Action): string | null {
    if (this.step === 'over') return 'The game is over';
    if (this.step === 'settling') return 'Wait for the tower to settle';
    if (pid !== this.current.id) return 'Not your turn';
    const me = this.current;
    switch (action.kind) {
      case 'roll': {
        if (this.step !== 'roll') return 'You already rolled';
        const value = 1 + Math.floor(this.rand() * 6);
        this.roll = value;
        this.emit({ kind: 'roll', playerId: me.id, value });
        const values = me.supply.map((s) => VALUE[s.shape]);
        if (canMake(values, value)) {
          this.step = 'place';
          this.remaining = value;
          this.say(`${me.name} rolled a ${value}.`);
        } else if (this.inPlay().length) {
          this.step = 'pickup';
          this.say(`${me.name} rolled a ${value} and can't make it: they must take a stone from the tower.`);
          this.emit({ kind: 'stuck', playerId: me.id });
        } else {
          this.say(`${me.name} rolled a ${value}, can't make it, and the tower is empty.`);
          this.nextTurn();
        }
        return null;
      }
      case 'place': {
        if (this.step !== 'place') return 'Not time to place a stone';
        const stone = me.supply.find((s) => s.id === action.stoneId);
        if (!stone) return 'That stone is not yours';
        if (!this.allowed().includes(stone)) return `That stone doesn't fit: ${this.remaining} to place`;
        const q = normalizeQuat(action.q);
        if (!q) return 'Bad rotation';
        const pose = this.sim.dropPose(stone, action.x, action.z, q);
        if (!pose) return 'Place it on the base or the tower';
        me.supply = me.supply.filter((s) => s !== stone);
        this.tower.set(stone.id, stone);
        this.sim.add(stone.id, stone, pose);
        this.lastPlaced = stone.id;
        this.emit({ kind: 'place', playerId: me.id, stoneId: stone.id });
        this.settling = { kind: 'place', stone, ticks: 0, quiet: 0 };
        this.step = 'settling';
        return null;
      }
      case 'pickup': {
        if (this.step !== 'pickup') return 'You can only take a stone when you can not place';
        const stone = this.tower.get(action.stoneId);
        if (!stone || this.sim.isFallen(stone.id)) return 'Pick a stone on the tower';
        this.tower.delete(stone.id);
        this.sim.remove(stone.id);
        this.sim.wakeAll();
        me.supply.push(stone);
        if (this.lastPlaced === stone.id) this.lastPlaced = null;
        this.emit({ kind: 'pickup', playerId: me.id, stoneId: stone.id });
        this.say(`${me.name} took a ${stone.shape} from the tower.`);
        this.settling = { kind: 'pickup', stone, ticks: 0, quiet: 0 };
        this.step = 'settling';
        return null;
      }
    }
    return 'Unknown action';
  }

  private inPlay(): number[] {
    return [...this.tower.keys()].filter((id) => !this.sim.isFallen(id));
  }

  /** Advance the simulation one tick. Returns true when the move resolved (state changed). */
  update(): boolean {
    const s = this.settling;
    if (this.step !== 'settling' || !s) return false;
    this.sim.step();
    this.tick++;
    s.ticks++;
    s.quiet = this.sim.maxSpeed() < QUIET_SPEED ? s.quiet + 1 : 0;
    if ((s.ticks < MIN_SETTLE_TICKS || s.quiet < QUIET_TICKS) && s.ticks < MAX_SETTLE_TICKS) return false;
    this.resolve(s.kind, s.stone);
    return true;
  }

  /** Run the simulation until the current move resolves (tests, bots without a server loop). */
  settle() {
    while (this.step === 'settling') this.update();
  }

  private resolve(kind: 'place' | 'pickup', stone: Stone) {
    this.settling = null;
    const me = this.current;
    const fallen = this.sim.fallen();
    for (const id of fallen) {
      me.supply.push(this.tower.get(id)!);
      this.tower.delete(id);
      this.sim.remove(id);
      if (this.lastPlaced === id) this.lastPlaced = null;
    }
    if (fallen.length) {
      this.emit({ kind: 'fall', playerId: me.id, count: fallen.length });
      this.say(`${fallen.length} stone${fallen.length === 1 ? '' : 's'} fell! ${me.name} takes ${fallen.length === 1 ? 'it' : 'them'}.`);
      return this.nextTurn();
    }
    if (kind === 'pickup') return this.nextTurn();
    this.say(`${me.name} placed a ${stone.shape}.`);
    this.remaining -= VALUE[stone.shape];
    if (me.supply.length === 0) {
      this.step = 'over';
      this.winner = me.id;
      this.emit({ kind: 'win', playerId: me.id });
      this.say(`${me.name} placed their last stone and wins!`);
      return;
    }
    if (this.remaining === 0) return this.nextTurn();
    this.step = 'place';
  }

  private nextTurn() {
    this.turn = (this.turn + 1) % this.players.length;
    this.step = 'roll';
    this.roll = null;
    this.remaining = 0;
    this.emit({ kind: 'turn', playerId: this.current.id });
  }

  /** Dev: force the next roll. */
  rigRoll(value: number) {
    const r = this.rand;
    this.rand = () => {
      this.rand = r;
      return (value - 1) / 6 + 0.01;
    };
  }
}
