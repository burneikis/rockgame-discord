import { DiscordSDK } from '@discord/embedded-app-sdk';

/**
 * Who am I and which table am I at?
 *
 * - In a browser: from the URL (?room=&name=&pid=) or localStorage.
 * - Inside Discord: from the Embedded App SDK. Player = Discord user,
 *   room = the activity instance (everyone in the same voice channel session).
 */
export interface Identity {
  playerId: string;
  name: string;
  roomId: string;
  /** Discord OAuth token; the server uses it to verify who you are. */
  accessToken?: string;
}

const PID_KEY = 'rockgame.pid';
const NAME_KEY = 'rockgame.name';

/** Discord launches activities with frame_id/instance_id query params. */
export function isInDiscord(): boolean {
  return new URLSearchParams(location.search).has('frame_id');
}

function randomId() {
  return 'p-' + Math.random().toString(36).slice(2, 10);
}

export function initialIdentity(): { playerId: string; name: string | null; roomId: string } {
  const q = new URLSearchParams(location.search);
  let playerId = q.get('pid');
  if (!playerId) {
    playerId = localStorage.getItem(PID_KEY) ?? randomId();
    localStorage.setItem(PID_KEY, playerId);
  }
  const name = q.get('name') ?? localStorage.getItem(NAME_KEY);
  return { playerId, name, roomId: q.get('room') ?? 'main' };
}

export function rememberName(name: string) {
  localStorage.setItem(NAME_KEY, name);
}

export async function discordIdentity(): Promise<Identity> {
  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID as string | undefined;
  if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID is not set. Add it to .env and rebuild.');

  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });

  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  const { access_token } = (await res.json()) as { access_token: string };

  const { user } = await sdk.commands.authenticate({ access_token });
  return {
    playerId: `discord-${user.id}`,
    name: user.global_name || user.username,
    roomId: sdk.instanceId,
    accessToken: access_token,
  };
}
