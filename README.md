# Arena Sweats Discord Bot

A Discord bot that turns [arenasweats.lol](https://arenasweats.lol) — an undocumented, community-run stats tracker for League of Legends' [Arena mode](https://www.leagueoflegends.com/en-us/news/game-updates/arena-2-0/) — into a live, self-maintaining leaderboard for any Discord server. Register once with `/setign`; the bot creates a `#arena-leaderboard` channel that tracks everyone who's registered, refreshes on demand, and quietly repairs itself if anything gets deleted.

Built for a friend group's private server; the invite link below is genuinely running 24/7, not a demo screenshot.

**[Add the bot to your server](https://discord.com/oauth2/authorize?client_id=1532425088194969701&permissions=26640&scope=bot%20applications.commands)**

## What it does

- **`/setign riot_id region`** links a Riot ID to a Discord account.
- A **`#arena-leaderboard`** channel is created automatically, ranking everyone registered in that server by rating, medals for the top 3.
- An **Update** button on the leaderboard live-refreshes every registered player at once, with a running ✅ / ❌ / ⏳ progress display (plus how stale each player's underlying data actually is) so a single failed lookup is visible without derailing the rest. The same refresh also runs automatically every hour, on the hour.
- All of it is **self-healing** — delete the leaderboard message, the progress message, or the whole channel, and the next interaction quietly rebuilds whatever's missing.

## Why this is a bit more interesting than "wraps an API"

arenasweats.lol has no public API — it's a hobbyist's site with no rate-limit docs, no changelog, and no guarantee it'll be reachable tomorrow. A few decisions came out of designing around that:

- **Reverse-engineered, not scraped.** The site's own frontend calls internal JSON endpoints to render its search results; those were found by watching network requests in DevTools and are called directly (`src/arenaSweats.js`) — no HTML parsing, no headless browser.
- **A single serialized request queue.** Every outbound call funnels through one `enqueue()` chain with a fixed delay between requests, so the bot can never fire concurrent requests at someone else's small side project, no matter how many Discord users trigger lookups at once.
- **Cache as a fallback, not a shortcut.** Every player lookup always hits the live API — SQLite only stores the *most recent successful* response per player, used solely to keep the leaderboard showing a reasonable last-known value if arenasweats.lol is down. A genuine "player not found" is never masked by stale cached data; only actual unavailability triggers the fallback.
- **Distributed state that recovers from deletion.** The leaderboard, its update-progress log, and the channel itself are each tracked by ID in SQLite and re-created independently the next time they're needed — the bot never assumes Discord state matches its own records.
- **Designed around real Discord API constraints**, discovered the hard way while iterating on the layout:
  - Embed "inline" fields only ever render in a fixed 3-column grid — a 4th wraps to a new row instead of forming a real column.
  - A leaderboard row starting with `4. Name` gets silently parsed as Markdown's ordered-list syntax, giving that row different line spacing than everything else in the same field.
  - True ephemeral ("only you can see this") messages only exist for interaction responses (slash commands, buttons) — a plain message send has no way to reply privately, which shaped how the auto-moderation notices work.

None of this needs to be bulletproof — it's a bot for one Discord server — but building it to *behave* politely and recover gracefully was more interesting than the alternative.

## Tech stack

Node.js · [discord.js](https://discord.js.org/) v14 · SQLite via Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) (no native/compiled dependencies) · Docker · deployed on [Railway](https://railway.app)

## Requirements

- [Node.js](https://nodejs.org/) 22.5 or later (built-in `fetch` and `node:sqlite`)
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
Supported regions: `OCE, NA, EUW, ME, EUNE, KR, JP, BR, LAS, LAN, RU, TR, SEA, TW, VN`.

**`#arena-leaderboard`**
Created automatically the first time someone runs `/setign` in a server, with three bot-managed messages:

1. **An info message** — pinned to the top of the channel (it's the first thing sent into a freshly created channel). Static: credits Arena Sweats as the data source with a link, and gives a one-line reminder of the `/setign` command.
2. **The leaderboard itself** — lists everyone who's registered *in that server*, sorted by rating, with medals for the top 3. Edited in place — redrawn (from cache, no new requests) after every `/setign` in that server, or fully live-refreshed for every player on the board via its **Update** button (or automatically, every hour). Manual Update is rate-limited to once every 5 minutes per server — click it again sooner and the bot just tells you to wait, rather than re-hitting arenasweats.lol.
3. **An update-progress message** — created the first time a refresh runs (manual or automatic), then edited in place on every run after. Shows per-player progress: ⏳ while a player's fetch is in flight, then ✅ or ❌ once it resolves alongside how old their underlying data actually is, so it's obvious if one player's update failed without affecting anyone else's. Once the run finishes, it shows "Updated ..." with a relative timestamp, plus a warning if *every* fetch in that run failed (a strong signal arenasweats.lol itself is down, not just one bad lookup).

Each message is self-healing independently — if any of them (or the whole channel) is deleted, the next `/setign` or Update click recreates whatever's missing. The one exception is ordering: the info message is only guaranteed to be *first* when the channel itself is freshly created — if it's individually deleted and recreated later, Discord has no way to move it back above messages that already exist.

The channel is created with default (not locked-down) permissions — anyone can technically post there — but the bot actively deletes any message in that channel that isn't its own (with a self-deleting notice to whoever posted it), and the Update button also sweeps recent channel history as a backstop for anything that slips through.

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
├── index.js              # bot bootstrap, interaction routing, moderation
├── deploy-commands.js     # registers slash commands with Discord
├── config.js              # env loading and constants
├── db.js                  # SQLite schema + queries (node:sqlite)
├── arenaSweats.js         # arenasweats.lol API client, caching, request queue
├── leaderboard.js         # per-guild #arena-leaderboard channel management
└── commands/
    └── setign.js
```

## Possible next steps

Things that would be worth adding if this grew beyond a friend-group tool: automated tests around the caching/fallback logic, and pagination for servers with more registered players than an embed field comfortably holds.

## License

[MIT](LICENSE)
