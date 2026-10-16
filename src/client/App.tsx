import { useEffect, useMemo, useState } from 'react';
import { discordIdentity, initialIdentity, isInDiscord, rememberName, type Identity } from './identity';
import { useConnection } from './useConnection';
import { Lobby } from './components/Lobby';
import { Table } from './components/Table';

export function App() {
  return isInDiscord() ? <DiscordApp /> : <BrowserApp />;
}

function DiscordApp() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    discordIdentity().then(setIdentity, (e: Error) => {
      console.error(e);
      setFailure(e.message);
    });
  }, []);
  if (failure) return <div className="center">Could not sign in with Discord: {failure}</div>;
  if (!identity) return <div className="center muted">Signing in with Discord...</div>;
  return <Game identity={identity} />;
}

function BrowserApp() {
  const initial = useMemo(initialIdentity, []);
  const [name, setName] = useState(initial.name);
  const identity = useMemo<Identity | null>(
    () => (name ? { playerId: initial.playerId, roomId: initial.roomId, name } : null),
    [initial, name],
  );
  if (!identity) return <NameScreen onSubmit={(n) => (rememberName(n), setName(n))} />;
  return <Game identity={identity} />;
}

function Game({ identity }: { identity: Identity }) {
  const { state, error, showOffline, send, subscribe } = useConnection(identity);

  return (
    <div className="app">
      {showOffline && <div className="banner">Connection lost, reconnecting...</div>}
      {error && <div className="toast">{error}</div>}
      {!state ? (
        <div className="center muted">Joining table...</div>
      ) : state.game ? (
        <Table state={state} game={state.game} send={send} subscribe={subscribe} />
      ) : (
        <Lobby state={state} send={send} />
      )}
    </div>
  );
}

function NameScreen({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="center name-screen"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <h1 className="logo">GRAVITAS</h1>
      <input autoFocus placeholder="Your name" maxLength={24} value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="btn primary" disabled={!value.trim()}>
        Join
      </button>
    </form>
  );
}
