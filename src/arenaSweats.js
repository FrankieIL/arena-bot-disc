const { REQUEST_DELAY_MS } = require('./config');
const { getCachedRank, setCachedRank } = require('./db');

const BASE_URL = 'https://arenasweats.lol/api';
const SEASON = 'live';

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

module.exports = {
  getPlayerRank,
  PlayerNotFoundError,
  ArenaSweatsUnavailableError,
};
