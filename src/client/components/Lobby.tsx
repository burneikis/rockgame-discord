import { MAX_PLAYERS, TURN_TIMER_CHOICES, type ClientMessage } from '../../shared/protocol';
import { SHAPES, SHAPE_NAMES, VALUE } from '../../shared/stones';
import type { StateMessage } from '../useConnection';
import { isInDiscord } from '../identity';
import { StoneIcon } from './StoneIcon';

export function Lobby({ state, send }: { state: StateMessage; send: (m: ClientMessage) => void }) {
  const { room, you } = state;
  const isHost = room.hostId === you;
  const host = room.members.find((m) => m.id === room.hostId);
  const seated = room.members.some((m) => m.id === you);

  return (
    <div className="lobby">
      <h1 className="logo">GRAVITAS</h1>
      <div className="subtitle">a stone stacking game</div>
      <div className="legend">
        {SHAPES.map((s) => (
          <div key={s} className="legend-item" title={SHAPE_NAMES[s]}>
            <StoneIcon shape={s} size={36} />
            <span>{VALUE[s]}</span>
          </div>
        ))}
      </div>
      <div className="panel">
        <div className="panel-title">
          {isInDiscord() ? 'Table' : <>Room <code>{room.id}</code></>} - {room.members.length} player{room.members.length === 1 ? '' : 's'}
        </div>
        <ul className="members">
          {room.members.map((m) => (
            <li key={m.id}>
              <span className={`member-name${m.connected ? '' : ' muted'}`} title={m.name}>
                {m.name}
              </span>
              {!m.connected && <span className="tag offline">reconnecting</span>}
              {m.id === you && <span className="tag you">you</span>}
              {m.isBot && <span className="tag">bot</span>}
              {m.id === room.hostId && <span className="tag host">host</span>}
              {isHost && m.id !== you && (
                <button className="btn tiny ghost" onClick={() => send({ type: 'kick', playerId: m.id })}>
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>

        <div className="options">
          <label>
            Stones
            <select value={room.sets} disabled={!isHost} onChange={(e) => send({ type: 'setOptions', sets: Number(e.target.value) })}>
              <option value={1}>One of each shape (6 each)</option>
              <option value={2}>Tournament: two of each (12 each)</option>
            </select>
          </label>
          <label>
            Turn timer
            <select value={room.turnSeconds} disabled={!isHost} onChange={(e) => send({ type: 'setOptions', turnSeconds: Number(e.target.value) })}>
              {TURN_TIMER_CHOICES.map((s) => (
                <option key={s} value={s}>
                  {s ? `${s} seconds` : 'Off'}
                </option>
              ))}
            </select>
            {room.turnSeconds > 0 && <span className="muted small">(out of time: a bot moves for you)</span>}
          </label>
        </div>

        <details className="rules">
          <summary>How to play</summary>
          <ul>
            <li>Roll the die, then place stones adding up to the roll: the matching stone, or any combination.</li>
            <li>Place them one at a time, anywhere on the base or the tower. If you can place, you must.</li>
            <li>Can't make the roll? Take any stone from the tower. Anything that falls while you do is yours too.</li>
            <li>If stones fall while you place, you take every fallen stone and your turn ends.</li>
            <li>First to place their last stone without anything falling wins.</li>
          </ul>
        </details>

        {!seated && (
          <div className="row notice">
            <span>You are not seated at this table.</span>
            <button className="btn primary" onClick={() => send({ type: 'sit' })}>
              Sit down
            </button>
          </div>
        )}

        {isHost ? (
          <div className="row">
            <button className="btn" disabled={room.members.length >= MAX_PLAYERS} onClick={() => send({ type: 'addBot' })}>
              Add bot
            </button>
            <button className="btn primary" disabled={room.members.length < 2} onClick={() => send({ type: 'start' })}>
              Start game
            </button>
          </div>
        ) : (
          <div className="muted">Waiting for {host?.name ?? 'the host'} to start...</div>
        )}
      </div>
      {isInDiscord() ? (
        <div className="muted small">Friends join by launching the activity in this voice channel.</div>
      ) : (
        <div className="muted small">
          Friends join by opening this page with <code>?room={room.id}</code>.
        </div>
      )}
    </div>
  );
}
