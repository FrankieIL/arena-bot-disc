# Arena Sweats Discord Bot

A Discord bot for League of Legends players. Register your Riot ID and region once with `/setign`, then look up your (or a teammate's) current [Arena mode](https://www.leagueoflegends.com/en-us/news/game-updates/arena-2-0/) rank from [arenasweats.lol](https://arenasweats.lol) on demand with `/rank`. Every server it's in automatically gets a self-updating `#arena-leaderboard` channel listing everyone who's registered there.

## Add this bot to your server

The hosted instance runs 24/7 and its commands are registered globally, so any server owner can add it — no self-hosting required:

**[Click here to invite the bot](https://discord.com/oauth2/authorize?client_id=1532425088194969701&permissions=26640&scope=bot%20applications.commands)**

It requests `Send Messages`, `Embed Links`, `Manage Channels`, and `Manage Messages` — no privileged intents, no message content access. `Manage Channels` creates its own `#arena-leaderboard` channel; `Manage Messages` lets it delete anything anyone else posts there, keeping it a clean, bot-only display.

> If the bot was invited before these permissions were added, re-invite it with the link above (Discord merges new permissions in — no need to kick it first), or grant `Manage Channels` + `Manage Messages` to its role manually in Server Settings.

## How it works

arenasweats.lol doesn't publish a documented public API, so this bot talks to the same internal JSON endpoints the site's own search bar uses (found by inspecting its network requests):

- `GET /api/player_rank?search_term=<name>#<tag>&region=<region>&season=live` — tier, rating, leaderboard position
- `GET /api/player-data?player_name=<name>#<tag>&region=<region>&season=live` — games played, wins, placement stats

Because this is someone's solo-run project, the bot is deliberately a polite client:

- **Always live, cache as a fallback only** — `/setign`, `/rank`, and the leaderboard's Update button all fetch live from arenasweats.lol every time. SQLite only holds a copy of each player's *most recent successful* fetch, used purely as a fallback if the site is unreachable — never as a way to skip a request.
- **No concurrency** — all outbound requests are funneled through a single serialized queue with a small fixed delay between them, so the bot never fires concurrent requests at the site, no matter how many Discord users query at once.
- **A "not found" is never cached or masked** — a mistyped Riot ID always surfaces as a real error (not stale data), so fixing a typo with `/setign` and immediately retrying works right away. Only genuine site-unavailability falls back to the last known-good data.

## Requirements

- [Node.js](https://nodejs.org/) 22.5 or later (needed for built-in `fetch` and the built-in `node:sqlite` module — no native/compiled dependencies required)
- A Discord application/bot — create one at the [Discord Developer Portal](https://discord.com/developers/applications)

## Setup

1. **Create a Discord application**
   - Go to the [Developer Portal](https://discord.com/developers/applications) → New Application.
   - Under **Bot**, create a bot user and copy its token.
   - Under **OAuth2 → General**, copy the **Client ID**.
   - No privileged intents are required — this bot only uses slash commands.

2. **Invite the bot to your server**
   - Under **OAuth2 → URL Generator**, select scopes `bot` and `applications.commands`, and permissions `Send Messages` + `Embed Links` + `Manage Channels` + `Manage Messages` (for creating and keeping its own `#arena-leaderboard` channel clean).
   - Open the generated URL and add the bot to your server.

3. **Install dependencies**
   ```
   npm install
   ```
   Storage uses Node's built-in `node:sqlite` module, so there's no native compilation step — this should always be a plain, fast install.

4. **Configure environment**
   ```
   cp .env.example .env
   ```
   Fill in:
   - `DISCORD_TOKEN` — your bot token
   - `CLIENT_ID` — your application's client ID
   - `GUILD_ID` — local development convenience only: set it to a test server's ID so slash commands you're actively changing register there instantly. Leave it blank (the production/shared default) to register commands globally, so anyone can invite the bot and use them — allow up to an hour for global registration to propagate. Don't leave stale guild-scoped commands registered alongside global ones, or they'll show up as duplicates in that one server (see `deploy-commands.js` — re-running with `GUILD_ID` blank does not remove a previous guild-scoped registration; that needs an explicit empty `PUT` to the guild commands route).
   - `REQUEST_DELAY_MS` — tune rate-limiting behavior if needed; the default is sensible.

5. **Register slash commands**
   ```
   npm run deploy-commands
   ```
   Re-run this any time the command definitions change.

6. **Run the bot**
   ```
   npm start
   ```

The SQLite database is created automatically at `data/bot.sqlite3` on first run.

## Usage

**`/setign riot_id:<Name#Tag> region:<region>`**
Registers your Riot ID for future lookups.
```
/setign riot_id:PlayerOne#EUW1 region:EUW
```

**`/rank [user]`**
Looks up your own rank, or another server member's if they've registered.
```
/rank
/rank user:@someone
```
Replies with an embed showing tier, rating, leaderboard rank, win rate, and games played. Always fetches live; the footer only mentions cache if arenasweats.lol was unreachable and it had to fall back to the last known data for that player.

Supported regions: `OCE, NA, EUW, ME, EUNE, KR, JP, BR, LAS, LAN, RU, TR, SEA, TW, VN`.

**`#arena-leaderboard`**
Created automatically the first time someone runs `/setign` in a server, with three bot-managed messages:

1. **An info message** — pinned to the top of the channel (it's the first thing sent into a freshly created channel). Static: credits Arena Sweats as the data source with a link, and gives a one-line reminder of the `/setign`/`/rank` commands and the Update button.
2. **The leaderboard itself** — lists everyone who's registered *in that server*, sorted by rating, with medals for the top 3. Edited in place — redrawn (from cache, no new requests) after every `/setign` and `/rank` in that server, or fully live-refreshed for every player on the board via its **Update** button. Update is rate-limited to once every 5 minutes per server — click it again sooner and the bot just tells you to wait, rather than re-hitting arenasweats.lol.
3. **An update-progress message** — created the first time Update is clicked, then edited in place on every click after. Shows per-player progress: ⏳ while a player's fetch is in flight, then ✅ or ❌ once it resolves, so it's obvious if one player's update failed without affecting anyone else's. Once the run finishes, it shows "Updated ..." with a relative timestamp, plus a warning if *every* fetch in that run failed (a strong signal arenasweats.lol itself is down, not just one bad lookup).

Each message is self-healing independently — if any of them (or the whole channel) is deleted, the next `/setign`, `/rank`, or Update click recreates whatever's missing. The one exception is ordering: the info message is only guaranteed to be *first* when the channel itself is freshly created — if it's individually deleted and recreated later, Discord has no way to move it back above messages that already exist.

The channel is created with default (not locked-down) permissions — anyone can technically post there — but the bot actively deletes any message in that channel that isn't its own, keeping it clean without relying on permission overwrites. (An earlier version tried a permission-overwrite lockdown instead; it's more fragile than it looks — see the commit history if curious — so this replaces it.)

## Deploying to Railway (24/7 hosting)

The bot is a stateful, always-on process (it holds a persistent Discord gateway connection and reads/writes a local SQLite file), so it needs a platform that keeps a container running continuously and gives it durable disk — a serverless/on-demand platform won't work.

1. **Connect the repo**: on [railway.app](https://railway.app), New Project → **Deploy from GitHub repo** → select this repo. Railway will build it using the included `Dockerfile`.
2. **Add a Volume**: in the service settings, add a Volume and mount it at `/data`. This is what makes `players`/`rank_cache` survive restarts and redeploys — without it, the container's filesystem resets on every deploy.
3. **Set environment variables** on the service (same names as `.env.example`, plus one addition):
   - `DISCORD_TOKEN`, `CLIENT_ID`
   - `GUILD_ID` — leave blank for a production deployment; global command registration's propagation delay doesn't matter for a service that just stays running
   - `REQUEST_DELAY_MS` — same as local
   - `DB_PATH=/data/bot.sqlite3` — points the app at the mounted Volume instead of the local dev path
4. **Deploy**, then check the logs for `Logged in as <botname>` to confirm it connected.
5. **Register slash commands**: this only needs to be re-run when the command *definitions* change (not on every deploy). Do it from any machine with the bot's `DISCORD_TOKEN`/`CLIENT_ID` — Railway's one-off command runner (Shell tab, or `railway run node src/deploy-commands.js`) or locally both work identically, since registration talks to Discord's API directly and doesn't depend on where the bot process itself is running. Leave `GUILD_ID` blank wherever you run it from, so commands stay global.

Only run one instance of the bot at a time — a local `npm start` and the Railway deployment sharing the same `DISCORD_TOKEN` simultaneously can cause duplicate or conflicting interaction handling.

## Project structure

```
Dockerfile                 # container build for cloud deployment (e.g. Railway)
src/
├── index.js              # bot bootstrap and command routing
├── deploy-commands.js     # registers slash commands with Discord
├── config.js              # env loading and constants
├── db.js                  # SQLite schema + queries (node:sqlite)
├── arenaSweats.js         # arenasweats.lol API client, caching, request queue
├── leaderboard.js         # per-guild #arena-leaderboard channel management
└── commands/
    ├── setign.js
    └── rank.js
```
