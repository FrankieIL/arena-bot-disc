# Arena Sweats Discord Bot

A Discord bot for League of Legends players. Register your Riot ID and region once with `/setign`, then look up your (or a teammate's) current [Arena mode](https://www.leagueoflegends.com/en-us/news/game-updates/arena-2-0/) rank from [arenasweats.lol](https://arenasweats.lol) on demand with `/rank`.

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
   - Under **OAuth2 → URL Generator**, select scopes `bot` and `applications.commands`, and permissions `Send Messages` + `Embed Links`.
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
   - `GUILD_ID` — (recommended for development) the ID of a test server, so slash commands register instantly. Leave blank to register commands globally (can take up to an hour to appear).
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
5. **Register slash commands from the cloud instance**: run `node src/deploy-commands.js` once via Railway's one-off command runner (the service's Shell tab, or `railway run node src/deploy-commands.js` with the CLI). Re-run it any time the command definitions change.

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
└── commands/
    ├── setign.js
    └── rank.js
```
