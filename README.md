# Arena Sweats Discord Bot

A Discord bot for League of Legends players. Register your Riot ID and region once with `/setign`, then look up your (or a teammate's) current [Arena mode](https://www.leagueoflegends.com/en-us/news/game-updates/arena-2-0/) rank from [arenasweats.lol](https://arenasweats.lol) on demand with `/rank`. Every server it's in automatically gets a self-updating `#arena-leaderboard` channel listing everyone who's registered there.

## Add this bot to your server

The hosted instance runs 24/7 and its commands are registered globally, so any server owner can add it — no self-hosting required:

**[Click here to invite the bot](https://discord.com/oauth2/authorize?client_id=1532425088194969701&permissions=18448&scope=bot%20applications.commands)**

It requests `Send Messages`, `Embed Links`, and `Manage Channels` — no privileged intents, no message content access. `Manage Channels` is only used to create and configure its own `#arena-leaderboard` channel (read-only for members).

> If the bot was invited before this permission was added, re-invite it with the link above (Discord merges the new permission in — no need to kick it first), or grant `Manage Channels` to its role manually in Server Settings.

## How it works

arenasweats.lol doesn't publish a documented public API, so this bot talks to the same internal JSON endpoints the site's own search bar uses (found by inspecting its network requests):

- `GET /api/player_rank?search_term=<name>#<tag>&region=<region>&season=live` — tier, rating, leaderboard position
- `GET /api/player-data?player_name=<name>#<tag>&region=<region>&season=live` — games played, wins, placement stats

Because this is someone's solo-run project, the bot is deliberately a polite client:

- **Caching** — every lookup is cached in SQLite for `CACHE_TTL_MINUTES` (default 3 hours), matching roughly how often the leaderboard itself refreshes. Repeated `/rank` calls within that window never hit arenasweats.lol at all.
- **No concurrency** — all outbound requests are funneled through a single serialized queue with a small fixed delay between them, so the bot never fires concurrent requests at the site, no matter how many Discord users query at once.
- **No caching of failures** — a "not found" or network error isn't cached, so fixing a typo with `/setign` and immediately retrying works right away.

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
   - Under **OAuth2 → URL Generator**, select scopes `bot` and `applications.commands`, and permissions `Send Messages` + `Embed Links` + `Manage Channels` (the last one lets it create/manage its own `#arena-leaderboard` channel).
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
   - `CACHE_TTL_MINUTES` / `REQUEST_DELAY_MS` — tune caching/rate-limiting behavior if needed; the defaults are sensible.

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
Replies with an embed showing tier, rating, leaderboard rank, win rate, and games played, plus whether the data came from cache or a fresh lookup.

Supported regions: `OCE, NA, EUW, ME, EUNE, KR, JP, BR, LAS, LAN, RU, TR, SEA, TW, VN`.

**`#arena-leaderboard`**
Created automatically the first time someone runs `/setign` in a server (read-only for members — the bot is the only one posting). Lists everyone who's registered *in that server*, sorted by rating, with medals for the top 3. It's a single message the bot edits in place — refreshed after every `/setign` and `/rank` in that server, always from already-cached data (see below), never a fresh request of its own. If it's ever deleted, or the channel itself is deleted, the next `/setign` or `/rank` recreates it.

## Deploying to Railway (24/7 hosting)

The bot is a stateful, always-on process (it holds a persistent Discord gateway connection and reads/writes a local SQLite file), so it needs a platform that keeps a container running continuously and gives it durable disk — a serverless/on-demand platform won't work.

1. **Connect the repo**: on [railway.app](https://railway.app), New Project → **Deploy from GitHub repo** → select this repo. Railway will build it using the included `Dockerfile`.
2. **Add a Volume**: in the service settings, add a Volume and mount it at `/data`. This is what makes `players`/`rank_cache` survive restarts and redeploys — without it, the container's filesystem resets on every deploy.
3. **Set environment variables** on the service (same names as `.env.example`, plus one addition):
   - `DISCORD_TOKEN`, `CLIENT_ID`
   - `GUILD_ID` — leave blank for a production deployment; global command registration's propagation delay doesn't matter for a service that just stays running
   - `CACHE_TTL_MINUTES`, `REQUEST_DELAY_MS` — same as local
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
