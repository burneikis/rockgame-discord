import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, GameView, PlayerView } from '../../shared/protocol';
import { ROLL_MS } from '../../shared/protocol';
import { BASES, SHAPE_NAMES, VALUE, type Pose, type Stone } from '../../shared/stones';
import { Stage, type StageMode } from '../stage';
import { play, setMuted, useMuted } from '../sound';
import type { StateMessage, Subscribe } from '../useConnection';
import { StoneIcon } from './StoneIcon';
import { Die } from './Die';

const AIM_EVERY_MS = 80;
const CALLOUT_MS = 2800;

type Send = (m: ClientMessage) => void;

export function Table({ state, game, send, subscribe }: { state: StateMessage; game: GameView; send: Send; subscribe: Subscribe }) {
  const { you } = state;
  const muted = useMuted();
  const isHost = state.room.hostId === you;
  const me = game.players.find((p) => p.id === you);
  const turn = game.players.find((p) => p.id === game.turnId) ?? null;
  const myTurn = !!me && game.turnId === you;
  const name = (id: string) => game.players.find((p) => p.id === id)?.name ?? '?';

  const [showLog, setShowLog] = useState(false);
  const [hideResults, setHideResults] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [ghostValid, setGhostValid] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [face, setFace] = useState(1);
  const [callout, setCallout] = useState<{ text: string; key: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // ---------------------------------------------------------------- 3D stage
  const stageEl = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  useEffect(() => {
    const s = new Stage(stageEl.current!);
    s.onGhostChange = setGhostValid;
    stage.current = s;
    return () => {
      s.dispose();
      stage.current = null;
    };
  }, []);

  useEffect(() => stage.current?.setBase(game.options.base), [game.options.base]);
  useEffect(() => stage.current?.setTower(game.tick, game.tower), [game.tick, game.tower]);

  // Body frames and other players' aims bypass React.
  const turnRef = useRef({ turnId: game.turnId, step: game.step });
  turnRef.current = { turnId: game.turnId, step: game.step };
  useEffect(
    () =>
      subscribe((msg) => {
        const s = stage.current;
        if (!s) return;
        if (msg.type === 'bodies') s.pushFrame(msg.tick, msg.bodies);
        else if (msg.aim.playerId === turnRef.current.turnId && turnRef.current.step === 'place') s.setOtherAim(msg.aim.stone, msg.aim.pose);
      }),
    [subscribe],
  );
  useEffect(() => stage.current?.setOtherAim(null, null), [game.step, game.turnId, game.remaining]);

  // ---------------------------------------------------------------- events
  const lastSeq = useRef<number | null>(null);
  // Callouts that would spoil the roll are held until the die stops.
  const rollingRef = useRef(false);
  const afterRoll = useRef<(() => void)[]>([]);
  const whenRolled = (fn: () => void) => (rollingRef.current ? afterRoll.current.push(fn) : fn());
  useEffect(() => {
    const latest = game.events.at(-1)?.seq ?? 0;
    if (lastSeq.current === null) {
      lastSeq.current = latest;
      return;
    }
    for (const e of game.events) {
      if (e.seq <= lastSeq.current) continue;
      const who = e.playerId === you ? 'You' : name(e.playerId);
      switch (e.kind) {
        case 'roll':
          rollingRef.current = true;
          setRolling(true);
          play('roll');
          break;
        case 'place':
          play('place');
          break;
        case 'pickup':
          play('pickup');
          break;
        case 'fall':
          play('fall');
          setCallout({ text: `${e.count} stone${e.count === 1 ? '' : 's'} fell! ${who} take${e.playerId === you ? '' : 's'} ${e.count === 1 ? 'it' : 'them'}.`, key: e.seq });
          break;
        case 'stuck': {
          const text = `${who} can't make ${game.roll}: take${e.playerId === you ? '' : 's'} a stone from the tower.`;
          whenRolled(() => {
            play('stuck');
            setCallout({ text, key: e.seq });
          });
          break;
        }
        case 'turn':
          if (e.playerId === you) play('turn');
          break;
        case 'win':
          play('win');
          break;
      }
    }
    lastSeq.current = latest;
  });

  useEffect(() => {
    if (!rolling) return;
    const flick = window.setInterval(() => setFace(1 + Math.floor(Math.random() * 6)), 80);
    const stop = window.setTimeout(() => {
      rollingRef.current = false;
      setRolling(false);
      const queued = afterRoll.current.splice(0);
      queued.forEach((fn) => fn());
    }, ROLL_MS);
    return () => {
      window.clearInterval(flick);
      window.clearTimeout(stop);
    };
  }, [rolling]);

  useEffect(() => {
    if (!callout) return;
    const t = window.setTimeout(() => setCallout(null), CALLOUT_MS);
    return () => window.clearTimeout(t);
  }, [callout]);

  useEffect(() => {
    if (!confirmEnd) return;
    const t = window.setTimeout(() => setConfirmEnd(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmEnd]);

  // Turn timer countdown
  const [timerBase, setTimerBase] = useState<{ at: number; ms: number } | null>(null);
  useEffect(() => setTimerBase(game.timeLeftMs === null ? null : { at: Date.now(), ms: game.timeLeftMs }), [game.timeLeftMs]);
  useEffect(() => {
    if (!timerBase) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [timerBase]);
  const timeLeft = timerBase ? Math.max(0, timerBase.ms - (now - timerBase.at)) : null;
  const timerFrac = timeLeft !== null && state.room.turnSeconds ? Math.min(1, timeLeft / (state.room.turnSeconds * 1000)) : null;

  // ---------------------------------------------------------------- my move
  const canRoll = myTurn && game.step === 'roll';
  const placing = myTurn && game.step === 'place' && !rolling;
  const picking = myTurn && game.step === 'pickup' && !rolling;
  const allowed = new Set(placing ? game.allowed : []);
  const chosen: Stone | null = placing
    ? (me!.supply.find((s) => s.id === selected && allowed.has(s.id)) ??
      // Default to the biggest stone that fits (the single matching stone when there is one).
      [...me!.supply].filter((s) => allowed.has(s.id)).sort((a, b) => VALUE[b.shape] - VALUE[a.shape])[0] ??
      null)
    : null;

  const aimState = useRef<{ last: number; pending: Pose | null; timer?: number }>({ last: 0, pending: null });
  const sendAim = useCallback(
    (stoneId: number, pose: Pose | null) => {
      const a = aimState.current;
      a.pending = pose;
      const flush = () => {
        a.last = Date.now();
        a.timer = undefined;
        send({ type: 'aim', stoneId, pose: a.pending });
      };
      if (a.timer) return;
      const wait = AIM_EVERY_MS - (Date.now() - a.last);
      if (wait <= 0) flush();
      else a.timer = window.setTimeout(flush, wait);
    },
    [send],
  );

  // Stone objects are new on every state update; key the effect on the id.
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const chosenId = chosen?.id ?? null;
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    let mode: StageMode = { kind: 'idle' };
    const stone = chosenRef.current;
    if (chosenId !== null && stone) {
      mode = {
        kind: 'place',
        stone,
        onAim: (pose) => sendAim(chosenId, pose),
        onPlace: (x, z, q, y) => send({ type: 'act', action: { kind: 'place', stoneId: chosenId, x, z, q, y } }),
      };
    } else if (picking) {
      mode = { kind: 'pickup', onPick: (stoneId) => send({ type: 'act', action: { kind: 'pickup', stoneId } }) };
    }
    s.setMode(mode);
  }, [chosenId, picking, send, sendAim]);

  const roll = useCallback(() => send({ type: 'act', action: { kind: 'roll' } }), [send]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const s = stage.current;
      if (e.key === ' ' && canRoll) {
        e.preventDefault();
        roll();
      } else if (placing && s) {
        if (e.key === 'q' || e.key === 'Q') s.rotate(-1);
        else if (e.key === 'e' || e.key === 'E') s.rotate(1);
        else if (e.key === 'r' || e.key === 'R') s.tip();
        else if (e.key === 'Enter') s.drop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canRoll, placing, roll]);

  // ---------------------------------------------------------------- render
  const winner = game.winner ? game.players.find((p) => p.id === game.winner) : null;
  const status = statusText(game, turn, you, rolling);

  useEffect(() => {
    if (!winner) setHideResults(false);
  }, [winner]);

  return (
    <div className="table">
      <div className="topbar">
        <span className="logo small-logo">ROCK GAME</span>
        <span className="chip">{game.options.sets === 2 ? 'Tournament (12 stones)' : '6 stones each'}</span>
        <span className="chip">{BASES[game.options.base].name}</span>
        {state.room.turnSeconds > 0 && <span className="chip">{state.room.turnSeconds}s turns</span>}
        <span className="spacer" />
        {state.devMode && (
          <label className="dev">
            DEV next roll
            <select value="" onChange={(e) => e.target.value && send({ type: 'rigRoll', value: Number(e.target.value) })}>
              <option value="">-</option>
              {[1, 2, 3, 4, 5, 6].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className={`btn tiny ghost${showLog ? ' on' : ''}`} onClick={() => setShowLog((v) => !v)}>
          Log
        </button>
        <button className={`btn tiny ghost sound-toggle${muted ? '' : ' on'}`} onClick={() => setMuted(!muted)}>
          {muted ? 'Sound off' : 'Sound on'}
        </button>
        {isHost && (
          // window.confirm() is blocked inside the Discord activity iframe.
          <span className="confirm-wrap">
            <button className={`btn tiny ghost${confirmEnd ? ' on' : ''}`} onClick={() => setConfirmEnd((v) => !v)}>
              End game
            </button>
            {confirmEnd && (
              <span className="confirm-pop">
                <span className="small warn">End for everyone?</span>
                <button className="btn tiny danger" onClick={() => send({ type: 'endGame' })}>
                  Yes, end game
                </button>
                <button className="btn tiny ghost" onClick={() => setConfirmEnd(false)}>
                  Cancel
                </button>
              </span>
            )}
          </span>
        )}
      </div>

      <div className="main">
        <div className="stage-wrap">
          <div className="stage" ref={stageEl} />

          <div className="players">
            {game.players.map((p) => (
              <PlayerRow key={p.id} p={p} isYou={p.id === you} isTurn={p.id === game.turnId} timerFrac={p.id === game.turnId ? timerFrac : null} />
            ))}
          </div>

          {callout && (
            <div className="callout" key={callout.key}>
              {callout.text}
            </div>
          )}

          {winner &&
            (hideResults ? (
              <button className="btn tiny results-show" onClick={() => setHideResults(false)}>
                Show results
              </button>
            ) : (
              <div className="panel summary results-dock">
                <button className="btn tiny ghost summary-hide" title="Hide to take a clean screenshot" onClick={() => setHideResults(true)}>
                  Hide
                </button>
                <div className="logo">{winner.id === you ? 'You win!' : `${winner.name} wins!`}</div>
                <div className="muted">Last stone placed, and nothing fell.</div>
                <ul className="final">
                  {[...game.players]
                    .sort((a, b) => a.supply.length - b.supply.length)
                    .map((p) => (
                      <li key={p.id}>
                        <span className="ellipsis">{p.name}</span>
                        <span className="muted">{p.supply.length} stone{p.supply.length === 1 ? '' : 's'} left</span>
                      </li>
                    ))}
                </ul>
                {isHost ? (
                  <div className="row">
                    <button className="btn primary" onClick={() => send({ type: 'start' })}>
                      Play again
                    </button>
                    <button className="btn" onClick={() => send({ type: 'endGame' })}>
                      Back to lobby
                    </button>
                  </div>
                ) : (
                  <div className="muted">Waiting for the host...</div>
                )}
              </div>
            ))}

          {!winner && (
            <div className="hud">
              <div className="hud-row">
                <Die value={game.roll} rolling={rolling} face={face} />
                <div className="status">
                  <div className="status-main ellipsis">{status}</div>
                  {placing && <div className="muted small">Click the tower to drop. Drag to look around. Q/E rotate, R tip over.</div>}
                  {picking && <div className="muted small">Click a stone to take it. Anything that falls is yours too.</div>}
                  {canRoll && <div className="muted small">Press Space or the button.</div>}
                </div>
                {canRoll && (
                  <button className="btn primary big" onClick={roll}>
                    Roll
                  </button>
                )}
                {placing && (
                  <div className="row place-tools">
                    <button className="btn" title="Rotate left (Q)" onClick={() => stage.current?.rotate(-1)}>
                      &#8634;
                    </button>
                    <button className="btn" title="Rotate right (E)" onClick={() => stage.current?.rotate(1)}>
                      &#8635;
                    </button>
                    <button className="btn" title="Tip over (R)" onClick={() => stage.current?.tip()}>
                      Tip
                    </button>
                    <button className="btn primary" disabled={!ghostValid} title="Drop (Enter)" onClick={() => stage.current?.drop()}>
                      Drop
                    </button>
                  </div>
                )}
              </div>
              {me && (
                <div className="tray">
                  {[...me.supply]
                    .sort((a, b) => VALUE[a.shape] - VALUE[b.shape] || a.id - b.id)
                    .map((s) => (
                      <button
                        key={s.id}
                        className={`tray-stone${allowed.has(s.id) ? ' allowed' : ''}${chosen?.id === s.id ? ' chosen' : ''}`}
                        disabled={!allowed.has(s.id)}
                        title={`${SHAPE_NAMES[s.shape]} (${VALUE[s.shape]})`}
                        onClick={() => setSelected(s.id)}
                      >
                        <StoneIcon shape={s.shape} points={s.points} size={38} showValue />
                      </button>
                    ))}
                  {me.supply.length === 0 && <span className="muted">No stones left</span>}
                </div>
              )}
            </div>
          )}
        </div>
        {showLog && (
          <div className="log">
            {[...game.log].reverse().map((l) => (
              <div key={l.seq}>{l.text}</div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

function statusText(game: GameView, turn: PlayerView | null, you: string, rolling: boolean): string {
  if (!turn) return '';
  const mine = turn.id === you;
  const who = mine ? 'You' : turn.name;
  if (rolling) return `${who} ${mine ? 'roll' : 'rolls'}...`;
  switch (game.step) {
    case 'roll':
      return mine ? 'Your turn: roll the die' : `${turn.name}'s turn`;
    case 'place':
      return `${mine ? 'Place' : `${turn.name} is placing`} ${game.remaining}${game.remaining === game.roll ? '' : ' more'}`;
    case 'pickup':
      return mine ? `Can't make ${game.roll}: take a stone from the tower` : `${turn.name} must take a stone`;
    case 'settling':
      return 'Steady...';
    case 'over':
      return 'Game over';
  }
}

function PlayerRow({ p, isYou, isTurn, timerFrac }: { p: PlayerView; isYou: boolean; isTurn: boolean; timerFrac: number | null }) {
  return (
    <div className={`player${isTurn ? ' turn' : ''}${p.connected ? '' : ' offline'}`}>
      <div className="player-head">
        <span className="ellipsis player-name">{p.name}</span>
        {isYou && <span className="tag you">you</span>}
        {p.isBot && <span className="tag">bot</span>}
        {!p.connected && <span className="tag offline">offline</span>}
        <span className="count">{p.supply.length}</span>
      </div>
      <div className="mini-supply">
        {[...p.supply]
          .sort((a, b) => VALUE[a.shape] - VALUE[b.shape])
          .map((s) => (
            <StoneIcon key={s.id} shape={s.shape} points={s.points} size={16} />
          ))}
      </div>
      {timerFrac !== null && (
        <div className="timer">
          <div style={{ width: `${timerFrac * 100}%` }} />
        </div>
      )}
    </div>
  );
}
