const { REQUEST_DELAY_MS } = require('./config');
const { getCachedRank, setCachedRank } = require('./db');

const SITE_URL = 'https://arenasweats.lol';
const BASE_URL = `${SITE_URL}/api`;
const SEASON = 'live';
let seasonLabelCache = null; // last known-good label, set by refreshSeasonLabel()

class PlayerNotFoundError extends Error {}
class ArenaSweatsUnavailableError extends Error {}

// Serializes all outbound requests to arenasweats.lol so we never fire
// concurrent requests, with a small delay between them as extra headroom.
let requestQueue = Promise.resolve();

function enqueue(task) {
  const result = requestQueue.then(async () => {
    const value = await task();
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
    return value;
  });
  // Keep the chain alive even if this task fails, so later requests still run.
  requestQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new ArenaSweatsUnavailableError(`Network error contacting arenasweats.lol: ${err.message}`);
  }

  if (response.status === 404) {
    throw new PlayerNotFoundError('Player not found');
  }
  if (!response.ok) {
    throw new ArenaSweatsUnavailableError(`arenasweats.lol returned HTTP ${response.status}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new ArenaSweatsUnavailableError(`Unexpected response from arenasweats.lol: ${err.message}`);
  }
}

/**
 * Neither arenasweats' JSON endpoints nor Riot's API expose a season name
 * anywhere — but arenasweats.lol's own homepage server-renders the current
 * season as plain markup (`<span class="season-year">2026</span><span
 * class="season-number">3</span>`, confirmed live), so it's scraped from
 * there instead. Arena and Solo Queue are the same real-world League ranked
 * season, so this one value is reused for both leaderboards' titles rather
 * than needing an equivalent for Riot's side too.
 */
function parseSeasonLabel(html) {
  const year = /class="season-year">(\d+)</.exec(html)?.[1];
  const number = /class="season-number">(\d+)</.exec(html)?.[1];
  return year && number ? `${year} Season ${number}` : null;
}

/**
 * Actually re-checks arenasweats.lol's homepage — called once per real
 * leaderboard update (the Update button or the hourly auto-refresh, both of
 * which funnel through refreshGuildLeaderboardLive/
 * refreshGuildSoloqLeaderboardLive), not on every redraw. Those are already
 * naturally rate-limited (5-minute button cooldown, hourly auto-tick), so no
 * extra caching layer is needed on top — a season rollover is picked up
 * automatically within one update cycle, no manual edits ever needed. A
 * scrape failure (or arenasweats changing their markup) just keeps the last
 * known-good label instead of failing the leaderboard render over it.
 */
async function refreshSeasonLabel() {
  try {
    const html = await enqueue(async () => {
      const response = await fetch(SITE_URL);
      if (!response.ok) {
        throw new ArenaSweatsUnavailableError(`arenasweats.lol homepage returned HTTP ${response.status}`);
      }
      return response.text();
    });

    const label = parseSeasonLabel(html);
    if (label) {
      seasonLabelCache = label;
    }
  } catch {
    // Keep whatever was last known-good (possibly nothing yet).
  }

  return seasonLabelCache;
}

/** Whatever refreshSeasonLabel last found, with no network cost — null before the very first successful refresh. */
function getCachedSeasonLabel() {
  return seasonLabelCache;
}

async function fetchLiveRank(riotName, riotTag, region) {
  const player = `${riotName}#${riotTag}`;
  const regionParam = encodeURIComponent(region.toLowerCase());
  const playerParam = encodeURIComponent(player);

  const rank = await fetchJson(
    `${BASE_URL}/player_rank?search_term=${playerParam}&region=${regionParam}&season=${SEASON}`,
  );

  // player-data requires the player_hash returned by player_rank, not just the name.
  const hashParam = rank.player_hash ? `&player_hash=${encodeURIComponent(rank.player_hash)}` : '';
  const stats = await fetchJson(
    `${BASE_URL}/player-data?player_name=${playerParam}&region=${regionParam}&season=${SEASON}${hashParam}`,
  );

  return { ...rank, ...stats };
}

/**
 * Always hits the live API (serialized, rate-limited) for the current
 * data, caching the result as the "most recent known good" copy. Only
 * falls back to that cache if arenasweats.lol is unreachable — a genuine
 * "player not found" is never masked by stale data. Throws if there's no
 * cache to fall back to (e.g. a brand-new lookup while the site is down).
 */
async function getPlayerRank(riotName, riotTag, region) {
  const cacheKey = [riotName.toLowerCase(), riotTag.toLowerCase(), region.toLowerCase()];

  try {
    const payload = await enqueue(() => fetchLiveRank(riotName, riotTag, region));
    setCachedRank(...cacheKey, payload);
    return { ...payload, _live: true, _fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (err instanceof ArenaSweatsUnavailableError) {
      const cached = getCachedRank(...cacheKey);
      if (cached) {
        return { ...cached.payload, _live: false, _fetchedAt: cached.fetchedAt };
      }
    }
    throw err;
  }
}

/**
 * Top 3 champions by score this season (Arena Sweats caps this endpoint at
 * 3 regardless of any limit param — confirmed live). A brand-new player
 * with no games this season just gets an empty array back, not an error.
 */
async function getPlayerTopChampions(riotName, riotTag, region) {
  const player = `${riotName}#${riotTag}`;
  const regionParam = encodeURIComponent(region.toLowerCase());
  const playerParam = encodeURIComponent(player);

  const result = await enqueue(() =>
    fetchJson(`${BASE_URL}/player-topchamps?player_name=${playerParam}&region=${regionParam}&season=${SEASON}`),
  );
  return result.champions ?? [];
}

/**
 * Most recent matches, newest first. Paginated on Arena Sweats' side but
 * this always asks for the first page only — the stats card just shows a
 * short recent-matches list, not full history.
 */
async function getPlayerMatchHistory(riotName, riotTag, region, limit = 5) {
  const player = `${riotName}#${riotTag}`;
  const regionParam = encodeURIComponent(region.toLowerCase());
  const playerParam = encodeURIComponent(player);

  const result = await enqueue(() =>
    fetchJson(
      `${BASE_URL}/player-matchhistory?player_name=${playerParam}&region=${regionParam}&season=${SEASON}&limit=${limit}&offset=0`,
    ),
  );
  return result.match_history ?? [];
}

module.exports = {
  getPlayerRank,
  getPlayerTopChampions,
  getPlayerMatchHistory,
  refreshSeasonLabel,
  getCachedSeasonLabel,
  PlayerNotFoundError,
  ArenaSweatsUnavailableError,
};
