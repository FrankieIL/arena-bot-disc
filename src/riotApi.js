const { RIOT_API_KEY, RIOT_REQUEST_DELAY_MS, REGION_TO_RIOT } = require('./config');
const { getPlayer, setPlayerPuuid, getCachedSoloRank, setCachedSoloRank } = require('./db');

const SOLO_QUEUE_TYPE = 'RANKED_SOLO_5x5';

class RiotPlayerNotFoundError extends Error {}
class RiotApiUnavailableError extends Error {}

// Serializes all outbound requests to Riot's API, same role as arenaSweats.js's
// own queue but on a separate budget — different service, different rate limit.
let requestQueue = Promise.resolve();

function enqueue(task) {
  const result = requestQueue.then(async () => {
    const value = await task();
    await new Promise((resolve) => setTimeout(resolve, RIOT_REQUEST_DELAY_MS));
    return value;
  });
  requestQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * A 401/403 almost always means a misconfigured or expired key rather than a
 * transient issue, so it's logged loudly to stand out from ordinary fetch
 * failures. A 429 gets one retry honoring Retry-After — Riot's API returns
 * these under normal burst load, not just abuse, so a single backoff-and-
 * retry avoids treating a momentary throttle as a hard failure.
 */
async function fetchJson(url, retriedAfterRateLimit = false) {
  let response;
  try {
    response = await fetch(url, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
  } catch (err) {
    throw new RiotApiUnavailableError(`Network error contacting Riot's API: ${err.message}`);
  }

  if (response.status === 404) {
    throw new RiotPlayerNotFoundError('Player not found');
  }

  if (response.status === 401 || response.status === 403) {
    console.error(`Riot API returned HTTP ${response.status} — check that RIOT_API_KEY is a valid, current Personal API key.`);
    throw new RiotApiUnavailableError(`Riot API auth failed (HTTP ${response.status})`);
  }

  if (response.status === 429 && !retriedAfterRateLimit) {
    const retryAfterSeconds = Number(response.headers.get('retry-after')) || 1;
    await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
    return fetchJson(url, true);
  }

  if (!response.ok) {
    throw new RiotApiUnavailableError(`Riot API returned HTTP ${response.status}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new RiotApiUnavailableError(`Unexpected response from Riot's API: ${err.message}`);
  }
}

async function fetchPuuid(riotName, riotTag, regional) {
  const account = await fetchJson(
    `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riotName)}/${encodeURIComponent(riotTag)}`,
  );
  return account.puuid;
}

/**
 * A Riot ID's puuid never changes, so it's resolved once and cached on the
 * player's own row (players.puuid) rather than re-fetched on every refresh —
 * roughly halves the Riot API calls a hourly refresh makes per player.
 */
async function resolvePuuid(discordId, riotName, riotTag, regional) {
  const existing = getPlayer(discordId)?.puuid;
  if (existing) return existing;

  const puuid = await fetchPuuid(riotName, riotTag, regional);
  setPlayerPuuid(discordId, puuid);
  return puuid;
}

async function fetchLiveSoloRank(discordId, riotName, riotTag, region) {
  const { platform, regional } = REGION_TO_RIOT[region];
  const puuid = await resolvePuuid(discordId, riotName, riotTag, regional);

  const entries = await fetchJson(
    `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
  );
  const solo = entries.find((entry) => entry.queueType === SOLO_QUEUE_TYPE);

  if (!solo) {
    return { tier: null, division: null, leaguePoints: 0, wins: 0, losses: 0 };
  }

  return {
    tier: solo.tier,
    division: solo.rank,
    leaguePoints: solo.leaguePoints,
    wins: solo.wins,
    losses: solo.losses,
  };
}

/**
 * Same live-fetch-with-cache-fallback shape as arenaSweats.js's
 * getPlayerRank — always hits Riot's API live, caching the result as the
 * fallback shown only when Riot's API is unreachable. An unranked account is
 * a normal `{ tier: null }` result, not an error, so it's never masked by
 * stale cache data.
 */
async function getPlayerSoloRank(discordId, riotName, riotTag, region) {
  const cacheKey = [riotName.toLowerCase(), riotTag.toLowerCase(), region.toLowerCase()];

  try {
    const payload = await enqueue(() => fetchLiveSoloRank(discordId, riotName, riotTag, region));
    setCachedSoloRank(...cacheKey, payload);
    return { ...payload, _live: true, _fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (err instanceof RiotApiUnavailableError) {
      const cached = getCachedSoloRank(...cacheKey);
      if (cached) {
        return { ...cached.payload, _live: false, _fetchedAt: cached.fetchedAt };
      }
    }
    throw err;
  }
}

module.exports = {
  getPlayerSoloRank,
  RiotPlayerNotFoundError,
  RiotApiUnavailableError,
};
