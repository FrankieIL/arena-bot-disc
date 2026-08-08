# Arena Sweats Discord Bot

A Discord bot that turns [arenasweats.lol](https://arenasweats.lol) — an undocumented, community-run stats tracker for League of Legends' [Arena mode](https://www.leagueoflegends.com/en-us/news/game-updates/arena-2-0/) — into a live, self-maintaining leaderboard for any Discord server, alongside a second leaderboard for ranked Solo/Duo sourced directly from Riot's official API. Register once with `/setign`; the bot creates `#arena-leaderboard` and `#soloq-leaderboard` channels that track everyone who's registered, refresh on demand, and quietly repair themselves if anything gets deleted. Run `/stats` any time for a personal Arena stat card — win rate, top placement rate, recent matches, most-played champions — posted to a dedicated `#arena-stats` channel that tidies itself up automatically.

Built for a friend group's private server; the invite link below is genuinely running 24/7, not a demo screenshot.

**[Add the bot to your server](https://discord.com/oauth2/authorize?client_id=1532425088194969701&permissions=26640&scope=bot%20applications.commands)**

## What it does

- **`/setign riot_id region`** links a Riot ID to a Discord account — the same registration feeds both leaderboards below, since it's the same League account either way.
- A **`#arena-leaderboard`** channel is created automatically, ranking everyone registered in that server by Arena rating, medals for the top 3, and each player's tier shown with its own icon (uploaded once as free application emojis — see Setup).
- A **`#soloq-leaderboard`** channel does the same for ranked Solo/Duo, pulled straight from Riot's own API instead of arenasweats.lol — same layout, same Update button and progress log, sorted by tier → division → LP instead of a flat rating number (see Usage for why).
- An **Update** button on each leaderboard live-refreshes every registered player at once, with a running ✅ / ❌ / ⏳ progress display (plus how stale each player's underlying data actually is) so a single failed lookup is visible without derailing the rest. The same refresh also runs automatically every hour, on the hour, for both boards.
- All of it is **self-healing** — delete a leaderboard message, its progress message, or the whole channel, and the next interaction quietly rebuilds whatever's missing.
- **`/stats [user]`** posts an Arena stat card — rank, win rate, top placement rate, average placing/KDA, streaks, most-played champions, and recent match history — to an auto-created **`#arena-stats`** channel. The whole channel (cards and any chat alongside them) is swept back to empty every hour, on the same schedule as the leaderboard auto-updates, keeping it tidy without banning conversation.

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

Riot's API (`src/riotApi.js`) is the opposite situation — documented, authenticated, officially rate-limited — but that brought its own set of decisions:

- **A Riot ID resolves to a PUUID once, permanently.** `GET /riot/account/v1/accounts/by-riot-id` and `GET /lol/league/v4/entries/by-puuid` are two separate calls on two separate routing hosts (regional vs. platform), but a PUUID never changes for a given Riot ID — so it's resolved once and cached on the player's own row, cutting Riot API traffic roughly in half on every subsequent refresh.
- **Sorting isn't a flat number compare.** Arena's rating is a single MMR-like value, always comparable. Solo Queue rank is tier + division + LP, and LP resets at every promotion — Diamond III with 5 LP still outranks Diamond IV with 90 LP — so the leaderboard sorts on a composite (tier, division, LP) score instead.
- **The tier icons are reused, not re-uploaded.** Arena and Solo Queue share the exact same tier names (Iron through Challenger) since they're the same underlying ranked system — the icons already uploaded for the Arena leaderboard (see Setup) work here too.

None of this needs to be bulletproof — it's a bot for one Discord server — but building it to *behave* politely and recover gracefully was more interesting than the alternative.

## Tech stack

Node.js · [discord.js](https://discord.js.org/) v14 · SQLite via Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) (no native/compiled dependencies) · Docker · deployed on [Railway](https://railway.app)

## Requirements

- [Node.js](https://nodejs.org/) 22.5 or later (built-in `fetch` and `node:sqlite`)
- A Discord application/bot — create one at the [Discord Developer Portal](https://discord.com/developers/applications)
- A Riot Games **Personal API key** — create one at the [Riot Developer Portal](https://developer.riotgames.com) (see Setup step 4 for why it has to be this specific key type)

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
   - `RIOT_API_KEY` — from the [Riot Developer Portal](https://developer.riotgames.com), register an app and generate a **Personal API key** (free, no approval process, and it never expires). Don't use the "development key" shown on the portal homepage instead — that one expires every 24 hours and would silently break `#soloq-leaderboard` daily.
   - `RIOT_REQUEST_DELAY_MS` — tune Riot API rate-limiting behavior if needed; the default is sensible.

5. **Register slash commands**
   ```
   npm run deploy-commands
   ```
   Re-run this any time the command definitions change.

6. **Run the bot**
   ```
   npm start
   ```

7. **(Optional) Upload rank tier icons**
   ```
   npm run upload-rank-emojis
   ```
   One-time step that uploads the icons in `assets/rank-icons/` as [application emojis](https://discord.com/developers/docs/resources/emoji) — owned by the bot itself, usable in every server it's in, free, and outside any single guild's emoji cap. Safe to re-run (skips tiers that already exist). Until this has been run once, the leaderboard just shows tier names with no icon.

8. **(Optional) Upload placement tile icons**
   ```
   npm run upload-placement-emojis
   ```
   Same application-emoji pattern as the rank icons, for the colored placement tiles (1st-8th, in "top-half" and "bottom-half" colors) used in `/stats`'s recent-games grid. The tiles themselves already exist in `assets/placement-icons/` — regenerate them with `npm run generate-placement-icons` (pure-JS PNG rendering via `pngjs`, no canvas/native dependency) if you ever want to tweak the colors or size. Until upload has been run once, the recent-games grid falls back to plain numbers with no color.

The SQLite database is created automatically at `data/bot.sqlite3` on first run.

## Usage

**`/setign riot_id:<Name#Tag> region:<region>`**
Registers your Riot ID for future lookups.
```
/setign riot_id:PlayerOne#EUW1 region:EUW
```
Supported regions: `OCE, NA, EUW, ME, EUNE, KR, JP, BR, LAS, LAN, RU, TR, SEA, TW, VN`. These are arenasweats.lol's own region names, mapped internally (`src/config.js`'s `REGION_TO_RIOT`) to Riot's platform/regional routing for the Solo Queue lookups — every value maps 1:1 except `SEA`, which Riot splits into three (`sg2`/`th2`/`ph2`) with no way to tell from the region name alone which one a given player is on; it defaults to `sg2` (Singapore).

**`#arena-leaderboard`**
Created automatically the first time someone runs `/setign` in a server, with three bot-managed messages:

1. **An info message** — pinned to the top of the channel (it's the first thing sent into a freshly created channel). Static: credits Arena Sweats as the data source with a link, and gives a one-line reminder of the `/setign` command.
2. **The leaderboard itself** — lists everyone who's registered *in that server*, sorted by rating, with medals for the top 3. Edited in place — redrawn (from cache, no new requests) after every `/setign` in that server, or fully live-refreshed for every player on the board via its **Update** button (or automatically, every hour). Manual Update is rate-limited to once every 5 minutes per server — click it again sooner and the bot just tells you to wait, rather than re-hitting arenasweats.lol.
3. **An update-progress message** — created the first time a refresh runs (manual or automatic), then edited in place on every run after. Shows per-player progress: ⏳ while a player's fetch is in flight, then ✅ or ❌ once it resolves alongside how old their underlying data actually is, so it's obvious if one player's update failed without affecting anyone else's. Once the run finishes, it shows "Updated ..." with a relative timestamp, plus a warning if *every* fetch in that run failed (a strong signal arenasweats.lol itself is down, not just one bad lookup).

Each message is self-healing independently — if any of them (or the whole channel) is deleted, the next `/setign` or Update click recreates whatever's missing. The one exception is ordering: the info message is only guaranteed to be *first* when the channel itself is freshly created — if it's individually deleted and recreated later, Discord has no way to move it back above messages that already exist.

The channel is created with default (not locked-down) permissions — anyone can technically post there — but the bot actively deletes any message in that channel that isn't its own (with a self-deleting notice to whoever posted it), and the Update button also sweeps recent channel history as a backstop for anything that slips through.

**`#soloq-leaderboard`**
The Solo/Duo counterpart to `#arena-leaderboard` — same three-message structure (info message, leaderboard, update-progress log), same self-healing behavior, same message-lockdown behavior, same Update button with its own independent 5-minute cooldown, folded into the same hourly auto-refresh alongside the Arena board. Everyone who's run `/setign` shows up here automatically — there's no separate registration.

The one real difference is what the columns mean: there's no Riot equivalent to arenasweats' global ladder-position number, so the Rank column is just tier + division (e.g. "💎 Diamond I", "🏆 Challenger" with no division for Master and above), and Rating shows League Points (`78 LP`) instead of a flat MMR-style number. Sorting accounts for LP resetting at each promotion (tier, then division, then LP — not LP alone).

**`/stats [user:<@member>]`**
Posts a stat card for yourself, or for another registered member if you pass `user`.
```
/stats
/stats user:@PlayerOne
```
Pulls current-season data straight from Arena Sweats (rank/rate stats from the same call `/setign`'s cache seeding uses, plus their top-champions and match-history endpoints) — there's no caching here, since each card is a one-shot snapshot rather than a persistently displayed message. If the target hasn't run `/setign`, or the live fetch fails, you get a private (only-you-can-see-it) error instead.

**`#arena-stats`**
Created automatically the first time `/stats` is run in a server, with a static info message on top (same self-healing, "only created, never edited" pattern as the leaderboard's info message) explaining the channel and how to use `/stats`. Unlike the leaderboard channel, chat isn't deleted on sight here — instead the whole channel is wiped back down to just the info message on the same wall-clock hour the leaderboards auto-update on, so cards and any chat posted alongside them stick around for up to an hour rather than being deleted individually. The sweep fetches and deletes whatever's actually in the channel each time (rather than tracking message IDs in memory), so it can't drift out of sync with reality across a restart.

## Deploying to Railway (24/7 hosting)

The bot is a stateful, always-on process (it holds a persistent Discord gateway connection and reads/writes a local SQLite file), so it needs a platform that keeps a container running continuously and gives it durable disk — a serverless/on-demand platform won't work.

1. **Connect the repo**: on [railway.app](https://railway.app), New Project → **Deploy from GitHub repo** → select this repo. Railway will build it using the included `Dockerfile`.
2. **Add a Volume**: in the service settings, add a Volume and mount it at `/data`. This is what makes `players`/`rank_cache` survive restarts and redeploys — without it, the container's filesystem resets on every deploy.
3. **Set environment variables** on the service (same names as `.env.example`, plus one addition):
   - `DISCORD_TOKEN`, `CLIENT_ID`
   - `GUILD_ID` — leave blank for a production deployment; global command registration's propagation delay doesn't matter for a service that just stays running
   - `REQUEST_DELAY_MS`, `RIOT_API_KEY`, `RIOT_REQUEST_DELAY_MS` — same as local
   - `DB_PATH=/data/bot.sqlite3` — points the app at the mounted Volume instead of the local dev path
4. **Deploy**, then check the logs for `Logged in as <botname>` to confirm it connected.
5. **Register slash commands**: this only needs to be re-run when the command *definitions* change (not on every deploy). Do it from any machine with the bot's `DISCORD_TOKEN`/`CLIENT_ID` — Railway's one-off command runner (Shell tab, or `railway run node src/deploy-commands.js`) or locally both work identically, since registration talks to Discord's API directly and doesn't depend on where the bot process itself is running. Leave `GUILD_ID` blank wherever you run it from, so commands stay global.

Only run one instance of the bot at a time — a local `npm start` and the Railway deployment sharing the same `DISCORD_TOKEN` simultaneously can cause duplicate or conflicting interaction handling.

## Project structure

```
Dockerfile                     # container build for cloud deployment (e.g. Railway)
assets/
├── rank-icons/                # rank tier icons, source images for upload-rank-emojis
└── placement-icons/           # placement tile icons, source images for upload-placement-emojis
scripts/
├── upload-rank-emojis.js      # one-time application-emoji upload (see Setup)
├── generate-placement-icons.js # renders the placement tile PNGs (pure-JS, pngjs)
└── upload-placement-emojis.js # one-time application-emoji upload for placement tiles
src/
├── index.js              # bot bootstrap, interaction routing, moderation
├── deploy-commands.js     # registers slash commands with Discord
├── config.js              # env loading and constants (incl. Riot region routing map)
├── db.js                  # SQLite schema + queries (node:sqlite)
├── arenaSweats.js         # arenasweats.lol API client, caching, request queue
├── riotApi.js             # Riot Games API client, puuid resolution, caching, request queue
├── leaderboard.js         # per-guild #arena-leaderboard channel management
├── soloqLeaderboard.js    # per-guild #soloq-leaderboard channel management
├── stats.js               # per-guild #arena-stats channel + stat card building
├── rankEmojis.js          # generated by upload-rank-emojis.js — tier -> emoji mention
├── placementEmojis.js     # generated by upload-placement-emojis.js — placement -> emoji mention
└── commands/
    ├── setign.js
    └── stats.js
```

## Possible next steps

Things that would be worth adding if this grew beyond a friend-group tool: automated tests around the caching/fallback logic, and pagination for servers with more registered players than an embed field comfortably holds.

## License

[MIT](LICENSE)
