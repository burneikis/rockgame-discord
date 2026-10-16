# Rock Game - Discord Activity

A 3D stone stacking game as a Discord Activity. Rules are in [RULES.md](RULES.md).

## Quick start

```bash
npm install
npm run dev        # server :3001 (dev mode) + Vite client :5173
```

| URL | What |
|---|---|
| http://localhost:5173/dev.html | **Test harness**: several players side by side in one tab (`?players=1..6&room=x`) |
| http://localhost:5173/?room=test | Single player view. Open more tabs with the same `room` to add players |
| http://localhost:5173/?room=test&name=Bob&pid=bob | Fixed identity (handy for multiple tabs in the same browser) |

The host can **Add bot** in the lobby to play solo. In dev mode the top bar
has **DEV next roll** to force the next die roll. `BOT_DELAY_MS=300 npm run dev`
speeds bots up.

## Controls

- **Roll**: button or Space.
- **Place**: pick a stone in your tray (only stones that fit the roll are
  enabled), point at the tower and click. The green ghost shows exactly where
  it lands (it is lowered straight down onto whatever is below); red means it
  would miss the base. Q/E rotate, R tips it over (flat, on its side, on its
  end). On touch screens tap to aim, then press **Drop**.
- **Take a stone** (when you can't make the roll): click any stone on the
  tower. On touch: tap to highlight, tap again to take.
- Drag to orbit, right-drag to pan, scroll/pinch to zoom.

## How it works

- The server owns the physics (Rapier, `src/shared/physics.ts`). Placing or
  taking a stone puts the game into a *settling* step; the server simulates
  at 60 Hz and streams body positions at 20 Hz until the tower has been still
  for ~0.7 s, then resolves what fell. Clients interpolate between frames.
- A stone has fallen when its centre drops below the base top, it touches
  the table (e.g. leaning against the pedestal) or it rolls away.
- Clients keep a static copy of the tower in a local Rapier world to preview
  where the held stone will land; the server recomputes the drop itself, so
  only the x/z position and rotation are trusted from the client.
- The aiming player's ghost is relayed to everyone else (blue ghost).
- Bots (`src/shared/bot.ts`) try candidate drops in cloned physics worlds
  (`World.takeSnapshot`) and keep the one that disturbs the tower least. They
  also play for players who time out or stay disconnected for 15s.

```
src/shared/stones.ts    shapes, sizes (shared by physics + rendering), roll combinations
src/shared/physics.ts   Rapier world: base, table, stones, drop preview, fall detection
src/shared/engine.ts    turn rules, settle loop
src/shared/bot.ts       simulation-based bot
src/server/index.ts     HTTP + WebSocket rooms, physics loop, Discord auth
src/client/stage.ts     three.js scene, interpolation, ghost, picking
src/client/components/  React UI (lobby, table HUD)
```

### Rules decisions

- Stones are lowered straight down onto the tower (you can't wedge a stone in
  sideways), in three tilts and any rotation around the vertical.
- Taking a stone removes it instantly, even from the bottom of the tower;
  whatever falls as a result is yours.
- If you can't make the roll and the tower is empty, the turn passes.
- Options: one set of stones each (6) or the tournament variant (12).
- Pentagons are the strange piece: every pentagon is randomised when the game
  starts (convex, uneven corners, a mix of long and short sides, face area
  random between 0.35 and 0.575; see `randomPentagon` in `src/shared/stones.ts`). Each stone
  keeps its outline for the whole game, so a pentagon that falls or is taken
  by another player is still the same piece. The shaft is a short bar (1.5 long).

### Base rocks

Picked in the lobby, listed from easiest to hardest by the area of the top
(`BASES` in `src/shared/stones.ts`; the order is computed, so new bases slot
in automatically). The lobby shows a top view with a square stone for scale.

| Base | Shape | Top area |
|---|---|---|
| Boulder | round, r 1.7 | 9.1 |
| Millstone | round, r 1.25 | 4.9 |
| Flagstone | irregular quad | 3.8 |
| River stone | lopsided oval | 3.2 |
| Stump (default) | round, r 0.95 | 2.8 |
| Ridge | long narrow bar | 2.6 |
| Pebble | small lopsided oval | 1.5 |
| Needle | round, r 0.62 | 1.2 |

Bases must be convex (they are Rapier convex hulls); a test checks this.

### Tests

```bash
npm test           # combinations, placing, falling, taking, winning, full bot games
npm run typecheck
```

## Running it in Discord

Same setup as the Flip 7 activity: the server serves the client, `/ws` and
`/api/token` on one port, so a single URL mapping is enough.

1. https://discord.com/developers/applications -> **New Application**.
2. **OAuth2**: copy Client ID and Client Secret into `.env`
   (`cp .env.example .env`). Add redirect `https://127.0.0.1` (placeholder).
3. **Installation**: enable User Install and Guild Install.
4. **Activities -> Settings**: tick **Enable Activities**.
5. Each session: `npm run discord` and `npm run tunnel`, then set
   **Activities -> URL Mappings** `/` -> `<random>.trycloudflare.com`.

For a fixed hostname use `docker compose up -d --build` with a named
Cloudflare tunnel (`TUNNEL_TOKEN` in `.env`), and `./deploy.sh` to push to a
server (settings in `.deploy.env`, see `deploy.env.example`).

Guests (browser players without Discord) are allowed in dev mode or when
Discord credentials are not set; set `ALLOW_GUESTS=1` to allow them anyway.
