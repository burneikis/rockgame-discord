import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { Identity } from './identity';

export type StateMessage = Extract<ServerMessage, { type: 'state' }>;
/** High-frequency messages (body frames, aims) go to listeners instead of React state. */
export type StreamMessage = Extract<ServerMessage, { type: 'bodies' | 'aim' }>;
export type Subscribe = (fn: (msg: StreamMessage) => void) => () => void;

/** App-level keepalive: detects half-open sockets the browser would not notice. */
const PING_MS = 15_000;
const PONG_TIMEOUT_MS = 8_000;
/** Don't flash the "connecting" banner for a quick reconnect. */
const BANNER_DELAY_MS = 2_000;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function useConnection(identity: Identity | null) {
  const [state, setState] = useState<StateMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const listeners = useRef(new Set<(msg: StreamMessage) => void>());

  useEffect(() => {
    if (!identity) return;
    let stopped = false;
    let retry: number | undefined;
    let pinger: number | undefined;
    let pongWait: number | undefined;
    const connect = () => {
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: 'join', ...identity } satisfies ClientMessage));
        pinger = window.setInterval(() => {
          ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
          window.clearTimeout(pongWait);
          pongWait = window.setTimeout(() => ws.close(), PONG_TIMEOUT_MS);
        }, PING_MS);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        window.clearTimeout(pongWait);
        if (msg.type === 'bodies' || msg.type === 'aim') listeners.current.forEach((f) => f(msg));
        else if (msg.type === 'state') setState(msg);
        else if (msg.type === 'error') setError(msg.message);
      };
      ws.onclose = () => {
        window.clearInterval(pinger);
        window.clearTimeout(pongWait);
        if (wsRef.current !== ws) return;
        setConnected(false);
        if (!stopped) retry = window.setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.clearInterval(pinger);
      window.clearTimeout(pongWait);
      wsRef.current?.close();
    };
  }, [identity]);

  useEffect(() => {
    if (connected) return setShowOffline(false);
    const t = window.setTimeout(() => setShowOffline(true), BANNER_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [connected]);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 3500);
    return () => window.clearTimeout(t);
  }, [error]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const subscribe = useCallback<Subscribe>((fn) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  return { state, error, connected, showOffline, send, subscribe };
}
