import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Game } from '../shared/engine';
import { botAction } from '../shared/bot';
import { DT, initPhysics } from '../shared/physics';
import { DEFAULT_BASE, SHAPES, isBaseId, type BaseId, type Pose } from '../shared/stones';
import { MAX_PLAYERS, ROLL_MS, TURN_TIMER_CHOICES, type BodyFrame, type ClientMessage, type GameView, type RoomView, type ServerMessage } from '../shared/protocol';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch {
  // no .env: fine for browser-only testing
}

const PORT = Number(process.env.PORT ?? 3001);
const DISCORD_CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DEV = process.env.DEV === '1';
/**
 * Guests are browser players without a Discord login (ids/names from the URL).
 * Allowed in dev mode, when Discord isn't configured, or with ALLOW_GUESTS=1.
 * Otherwise every join must carry a verified Discord token.
 */
const ALLOW_GUESTS = DEV || process.env.ALLOW_GUESTS === '1' || !DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET;
/** REQUIRE_DISCORD=1 refuses to start without Discord credentials instead of falling back to guests. */
if (process.env.REQUIRE_DISCORD === '1' && (ALLOW_GUESTS || !DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET)) {
  console.error('REQUIRE_DISCORD=1 but Discord credentials are missing or guests/dev mode are enabled');
  process.exit(1);
}
/** Optional comma-separated Discord user ids allowed to play (empty = any Discord user of this app). */
const ALLOWED_DISCORD_IDS = new Set(
  (process.env.ALLOWED_DISCORD_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 30);
/** Ids the server hands out itself; guests may not claim them. */
const RESERVED_ID = /^(discord|bot)-/;
const MAX_BODY_BYTES = 4096;
const MAX_WS_PAYLOAD = 16 * 1024;
const TOKEN_CACHE_MS = 60 * 60_000;
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS ?? 900);
/** How long a disconnected player's turn waits before a bot plays for them. */
const OFFLINE_GRACE_MS = Number(process.env.OFFLINE_GRACE_MS ?? 15_000);
/** Lobby seats and host status survive short disconnects (Discord/tunnel hiccups). */
const LOBBY_GRACE_MS = Number(process.env.LOBBY_GRACE_MS ?? 45_000);
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS ?? 30_000);
/** Rooms nobody is connected to are dropped after this long. */
const EMPTY_ROOM_MS = 10 * 60_000;
const HEARTBEAT_MS = 20_000;
/** Send body positions every this many physics ticks while the tower moves (60 ticks/s). */
const FRAME_EVERY = 3;
const DIST = path.resolve(import.meta.dirname, '../../dist');
const BOT_NAMES = ['Ada', 'Bix', 'Cog', 'Dot', 'Echo', 'Fizz', 'Gizmo', 'Hex', 'Ion', 'Jinx', 'Kilo', 'Lux'];

interface Member { id: string; name: string; isBot: boolean }

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const poseNumbers = (pose: Pose) => [...pose.p, ...pose.q].map(round4);

class Room {
  members: Member[] = [];
  hostId: string | null = null;
  sets = 1;
  base: BaseId = DEFAULT_BASE;
  turnSeconds = 0;
  game: Game | null = null;
  sockets = new Map<WebSocket, string>();
  /** Last name each player joined with, so a removed player can sit down again. */
  names = new Map<string, string>();
  offlineSince = new Map<string, number>();
  emptySince: number | null = null;
  timer: NodeJS.Timeout | null = null;
  private physics: NodeJS.Timeout | null = null;
  /** Turn timer: which decision it applies to and when it runs out. */
  private deadline: { key: string; at: number } | null = null;

  constructor(readonly id: string) {}

  isConnected(pid: string) {
    for (const id of this.sockets.values()) if (id === pid) return true;
    return false;
  }

  private offlineFor(pid: string, now = Date.now()) {
    if (this.isConnected(pid)) return 0;
    return now - (this.offlineSince.get(pid) ?? now);
  }

  /** Keep the host through short disconnects; hand over only after HOST_GRACE_MS. */
  ensureHost(): boolean {
    const prev = this.hostId;
    const host = this.members.find((m) => m.id === this.hostId);
    if (host && this.offlineFor(host.id) < HOST_GRACE_MS) return false;
    const next = this.members.find((m) => !m.isBot && this.isConnected(m.id));
    this.hostId = next?.id ?? (host ? host.id : null);
    return this.hostId !== prev;
  }

  /** Periodic cleanup. Returns true when something visible changed. */
  sweep(now: number): boolean {
    let changed = false;
    if (!this.game) {
      const before = this.members.length;
      this.members = this.members.filter((m) => m.isBot || this.offlineFor(m.id, now) < LOBBY_GRACE_MS);
      changed = this.members.length !== before;
    }
    return this.ensureHost() || changed;
  }

  setGame(game: Game | null) {
    this.game?.dispose();
    this.game = game;
    this.deadline = null;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.stopPhysics();
    this.setGame(null);
  }

  roomView(): RoomView {
    return {
      id: this.id,
      hostId: this.hostId,
      sets: this.sets,
      base: this.base,
      turnSeconds: this.turnSeconds,
      members: this.members.map((m) => ({ ...m, connected: m.isBot || this.isConnected(m.id) })),
    };
  }

  gameView(): GameView | null {
    const g = this.game;
    if (!g) return null;
    return {
      step: g.step,
      turnId: g.currentTurnId,
      roll: g.roll,
      remaining: g.remaining,
      allowed: g.allowed().map((s) => s.id),
      players: g.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        connected: p.isBot || this.isConnected(p.id),
        supply: p.supply,
      })),
      tick: g.tick,
      tower: g.sim.poses().map((s) => ({ id: s.id, shape: s.shape, pose: { p: s.pose.p.map(round4), q: s.pose.q.map(round4) } as Pose })),
      lastPlaced: g.lastPlaced,
      log: g.log.slice(-60),
      events: g.events.slice(-30),
      timeLeftMs: this.deadline && this.deadline.key === this.decisionKey() ? Math.max(0, this.deadline.at - Date.now()) : null,
      winner: g.winner,
      options: g.options,
    };
  }

  broadcast() {
    this.updateDeadline();
    const room = this.roomView();
    const game = this.gameView();
    for (const [ws, pid] of this.sockets) send(ws, { type: 'state', you: pid, devMode: DEV, room, game });
    if (this.game?.step === 'settling') this.startPhysics();
    this.scheduleAutomation();
  }

  sendAll(msg: ServerMessage, except?: WebSocket) {
    const raw = JSON.stringify(msg);
    for (const ws of this.sockets.keys()) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(raw);
  }

  /** Run the simulation in real time while the tower moves, streaming body positions. */
  private startPhysics() {
    if (this.physics) return;
    const g = this.game!;
    let last = performance.now();
    let acc = 0;
    let lastFrame = g.tick;
    this.physics = setInterval(() => {
      if (this.game !== g || g.step !== 'settling') return this.stopPhysics();
      const now = performance.now();
      acc += now - last;
      last = now;
      let steps = 0;
      while (acc >= DT * 1000 && steps < 4) {
        acc -= DT * 1000;
        steps++;
        if (g.update()) {
          this.stopPhysics();
          this.broadcast();
          return;
        }
      }
      if (steps === 4) acc = 0; // falling behind: slow down rather than spiral
      if (g.tick - lastFrame >= FRAME_EVERY) {
        lastFrame = g.tick;
        const bodies: BodyFrame[] = g.sim.poses().map((s) => [s.id, SHAPES.indexOf(s.shape), ...poseNumbers(s.pose)]);
        this.sendAll({ type: 'bodies', tick: g.tick, bodies });
      }
    }, DT * 1000);
  }

  private stopPhysics() {
    if (this.physics) clearInterval(this.physics);
    this.physics = null;
  }

  /** Identifies the decision the current player is facing (for the turn timer). */
  private decisionKey(): string {
    const g = this.game;
    return g ? `${g.turn}|${g.step}|${g.remaining}|${g.tick}|${g.events.at(-1)?.seq}` : '';
  }

  private needsDecision(): boolean {
    const g = this.game;
    return !!g && (g.step === 'roll' || g.step === 'place' || g.step === 'pickup');
  }

  /** Start the turn timer whenever a human faces a new decision. */
  private updateDeadline() {
    const g = this.game;
    if (!g || !this.needsDecision() || !this.turnSeconds || g.current.isBot) {
      this.deadline = null;
      return;
    }
    const key = this.decisionKey();
    if (this.deadline?.key !== key) this.deadline = { key, at: Date.now() + (g.step === 'roll' ? 0 : ROLL_MS) + this.turnSeconds * 1000 };
  }

  /** Bots act after a short delay; offline or timed-out humans get a bot move. */
  scheduleAutomation() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const g = this.game;
    if (!g || !this.needsDecision()) return;
    const key = this.decisionKey();
    const pid = g.current.id;
    const now = Date.now();
    // After a roll, wait for the die animation before acting.
    const settle = g.step === 'roll' ? 0 : ROLL_MS;
    let delay = Infinity;
    if (g.current.isBot) delay = settle + BOT_DELAY_MS;
    else if (!this.isConnected(pid)) delay = Math.max(BOT_DELAY_MS, OFFLINE_GRACE_MS - this.offlineFor(pid, now));
    if (this.deadline?.key === key) delay = Math.min(delay, Math.max(0, this.deadline.at - now));
    if (delay === Infinity) return;
    this.timer = setTimeout(() => {
      if (this.game !== g || this.decisionKey() !== key) return;
      const err = g.act(pid, botAction(g));
      if (err) console.error(`[${this.id}] automatic move rejected: ${err}`);
      this.broadcast();
    }, delay);
  }
}

const rooms = new Map<string, Room>();

// ------------------------------------------------------------------ discord

/** Exchange the OAuth code from the Embedded App SDK for an access token. */
async function exchangeCode(code: string): Promise<{ status: number; body: unknown }> {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return { status: 500, body: { error: 'Server is missing VITE_DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET in .env' } };
  }
  const res = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = (await res.json()) as { access_token?: string };
  if (!res.ok || !data.access_token) {
    console.error('Discord token exchange failed', res.status, data);
    return { status: 502, body: { error: 'Discord token exchange failed' } };
  }
  return { status: 200, body: { access_token: data.access_token } };
}

const verifiedTokens = new Map<string, { id: string; name: string; at: number }>();

/**
 * Ask Discord who owns this token, so players can't pretend to be each other.
 * Also checks the token was issued for this app (not some other app's token)
 * and, if configured, that the user is on the allowlist.
 */
async function verifyDiscordUser(token: string): Promise<{ id: string; name: string } | null> {
  if (typeof token !== 'string' || token.length > 256) return null;
  const cached = verifiedTokens.get(token);
  if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached;
  const res = await fetch('https://discord.com/api/v10/oauth2/@me', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const info = (await res.json()) as {
    application?: { id?: string };
    user?: { id: string; username: string; global_name?: string | null };
  };
  const u = info.user;
  if (!u || info.application?.id !== DISCORD_CLIENT_ID) return null;
  if (ALLOWED_DISCORD_IDS.size && !ALLOWED_DISCORD_IDS.has(u.id)) {
    console.warn(`Rejected Discord user ${u.id} (${u.username}): not in ALLOWED_DISCORD_IDS`);
    return null;
  }
  const user = { id: `discord-${u.id}`, name: u.global_name || u.username, at: Date.now() };
  verifiedTokens.set(token, user);
  return user;
}

function pruneTokenCache(now: number) {
  for (const [token, user] of verifiedTokens) if (now - user.at >= TOKEN_CACHE_MS) verifiedTokens.delete(token);
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(ws: WebSocket, msg: ClientMessage, ctx: { room: Room | null }): string | null {
  if (msg.type === 'join') {
    const roomId = String(msg.roomId || 'main').slice(0, 64);
    const pid = String(msg.playerId).slice(0, 64);
    const name = String(msg.name || 'Player').trim().slice(0, 24) || 'Player';
    let room = rooms.get(roomId);
    if (!room) {
      if (rooms.size >= MAX_ROOMS) return 'Server is full, try again later';
      rooms.set(roomId, (room = new Room(roomId)));
    }
    ctx.room?.sockets.delete(ws);
    ctx.room = room;
    room.sockets.set(ws, pid);
    room.offlineSince.delete(pid);
    room.emptySince = null;
    room.names.set(pid, name);
    const existing = room.members.find((m) => m.id === pid);
    if (existing) existing.name = room.game?.players.some((p) => p.id === pid) ? existing.name : name;
    else if (room.members.length < MAX_PLAYERS || room.game) room.members.push({ id: pid, name, isBot: false });
    room.ensureHost();
    return null;
  }

  const room = ctx.room;
  if (!room) return 'Join a room first';
  const pid = room.sockets.get(ws)!;
  const isHost = room.hostId === pid;
  const inLobby = !room.game;

  switch (msg.type) {
    case 'addBot': {
      if (!isHost || !inLobby) return 'Only the host can add bots in the lobby';
      if (room.members.length >= MAX_PLAYERS) return 'Table is full';
      const used = new Set(room.members.map((m) => m.name));
      const name = `Bot ${BOT_NAMES.find((n) => !used.has(`Bot ${n}`)) ?? room.members.length}`;
      room.members.push({ id: `bot-${Math.random().toString(36).slice(2, 8)}`, name, isBot: true });
      return null;
    }
    case 'kick': {
      if (!isHost || !inLobby) return 'Only the host can remove players in the lobby';
      room.members = room.members.filter((m) => m.id !== msg.playerId);
      for (const [sock, id] of room.sockets) {
        if (id === msg.playerId) send(sock, { type: 'error', message: 'The host removed you from the table. You can sit down again.' });
      }
      return null;
    }
    case 'sit': {
      if (!inLobby) return 'Wait for the current game to end';
      if (room.members.some((m) => m.id === pid)) return null;
      if (room.members.length >= MAX_PLAYERS) return 'Table is full';
      room.members.push({ id: pid, name: room.names.get(pid) ?? 'Player', isBot: false });
      room.ensureHost();
      return null;
    }
    case 'setOptions': {
      if (!isHost || !inLobby) return 'Only the host can change options';
      if (msg.sets === 1 || msg.sets === 2) room.sets = msg.sets;
      if (isBaseId(msg.base)) room.base = msg.base;
      if (typeof msg.turnSeconds === 'number' && TURN_TIMER_CHOICES.includes(msg.turnSeconds)) room.turnSeconds = msg.turnSeconds;
      return null;
    }
    case 'start': {
      if (!isHost) return 'Only the host can start';
      if (room.game && room.game.step !== 'over') return 'A game is already running';
      const seated = room.members.slice(0, MAX_PLAYERS);
      if (seated.length < 2) return 'Need at least 2 players (add a bot?)';
      if (seated.some((m) => !m.isBot && !room.isConnected(m.id))) return 'Someone is reconnecting; wait a moment';
      room.setGame(new Game(seated, { sets: room.sets, base: room.base }));
      return null;
    }
    case 'act': {
      if (!room.game) return 'No game running';
      const a = msg.action;
      if (!a || typeof a !== 'object') return 'Bad action';
      return room.game.act(pid, a);
    }
    case 'aim': {
      const g = room.game;
      if (!g || g.step !== 'place' || g.current.id !== pid) return null;
      if (!msg.shape || !SHAPES.includes(msg.shape)) return null;
      const pose = msg.pose && Array.isArray(msg.pose.p) && msg.pose.p.length === 3 && Array.isArray(msg.pose.q) && msg.pose.q.length === 4 && [...msg.pose.p, ...msg.pose.q].every((n) => typeof n === 'number' && Number.isFinite(n))
        ? { p: msg.pose.p.map(round4), q: msg.pose.q.map(round4) } as Pose
        : null;
      room.sendAll({ type: 'aim', aim: { playerId: pid, shape: msg.shape, pose } }, ws);
      return 'quiet';
    }
    case 'endGame': {
      if (!isHost) return 'Only the host can end the game';
      room.setGame(null);
      // Offline players keep their seat for the lobby grace period (see sweep).
      for (const m of room.members) if (!m.isBot && !room.isConnected(m.id) && !room.offlineSince.has(m.id)) room.offlineSince.set(m.id, Date.now());
      return null;
    }
    case 'rigRoll': {
      if (!DEV) return 'Rigging is only available in dev mode';
      if (!room.game) return 'No game running';
      if (!Number.isInteger(msg.value) || msg.value < 1 || msg.value > 6) return 'Pick 1-6';
      room.game.rigRoll(msg.value);
      return 'quiet';
    }
    default:
      return 'Unknown message';
  }
}

// ------------------------------------------------------------------ http

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (url.pathname === '/api/token' && req.method === 'POST') {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooBig = true;
        res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Body too large' }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let result: { status: number; body: unknown };
      try {
        const { code } = JSON.parse(raw) as { code?: string };
        result = code ? await exchangeCode(code) : { status: 400, body: { error: 'Missing code' } };
      } catch (e) {
        console.error(e);
        result = { status: 500, body: { error: 'Token exchange error' } };
      }
      res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
    });
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return void res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
  }
  let file = path.join(DIST, path.normalize(pathname).replace(/^([/\\])+/, ''));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return void res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Client not built. Run `npm run build`, or use `npm run dev`.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_PAYLOAD });

const alive = new WeakSet<WebSocket>();

wss.on('connection', (ws) => {
  const ctx: { room: Room | null } = { room: null };
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
  ws.on('message', (raw) => {
    onMessage(raw).catch((e) => {
      console.error(e);
      send(ws, { type: 'error', message: 'Server error' });
    });
  });
  async function onMessage(raw: unknown) {
    alive.add(ws);
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { type: 'error', message: 'Bad message' });
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return send(ws, { type: 'error', message: 'Bad message' });
    }
    if (msg.type === 'ping') return send(ws, { type: 'pong' });
    if (msg.type === 'join' && msg.accessToken) {
      const user = await verifyDiscordUser(msg.accessToken).catch(() => null);
      if (!user) return send(ws, { type: 'error', message: 'Could not verify your Discord account' });
      msg = { ...msg, playerId: user.id, name: user.name };
    } else if (msg.type === 'join') {
      if (!ALLOW_GUESTS) return send(ws, { type: 'error', message: 'Open this from Discord to play' });
      if (RESERVED_ID.test(String(msg.playerId))) return send(ws, { type: 'error', message: 'Invalid player id' });
    }
    let err: string | null;
    try {
      err = handle(ws, msg, ctx);
    } catch (e) {
      console.error(e);
      err = 'Server error';
    }
    // 'quiet' = handled, nothing for everyone to see (aim relays and the like).
    if (err === 'quiet') return;
    if (err) send(ws, { type: 'error', message: err });
    ctx.room?.broadcast();
  }
  ws.on('close', () => {
    const room = ctx.room;
    if (!room) return;
    const pid = room.sockets.get(ws);
    room.sockets.delete(ws);
    // Seats and host status are kept for a grace period (see Room.sweep).
    if (pid && !room.isConnected(pid)) room.offlineSince.set(pid, Date.now());
    if (room.sockets.size === 0) room.emptySince = Date.now();
    room.broadcast();
  });
});

// Keep idle connections open through proxies (Discord, cloudflared drop idle
// websockets) and drop sockets that stopped answering.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, HEARTBEAT_MS);

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.sockets.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_MS) {
      room.dispose();
      rooms.delete(room.id);
      continue;
    }
    if (room.sweep(now)) room.broadcast();
  }
  pruneTokenCache(now);
}, 2_000);

await initPhysics();
server.listen(PORT, () => {
  console.log(`Rock Game server on http://localhost:${PORT}${DEV ? ' (dev mode: roll rigging enabled)' : ''}`);
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) console.log('Discord credentials not set in .env (browser play still works)');
  else console.log(ALLOW_GUESTS ? 'Guest (non-Discord) players allowed' : 'Discord login required (set ALLOW_GUESTS=1 to allow browser guests)');
});
