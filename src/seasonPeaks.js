const { enqueue, fetchJson, BASE_URL, getPlayerRank } = require('./arenaSweats');
const { getCachedRank, setCachedSeasonPeak } = require('./db');

// Seasons Arena Sweats tracks true peak data for (GET /api/player-peaks) —
// verified directly against their live API. Older 2025-split-* seasons
// return 400 "Player peaks are not available for this season", so they're
// deliberately excluded rather than falling back to a season-end rank as an
// approximation of "peak". New splits/patches need a manual addition here,
// same as Arena Sweats' own hardcoded season dropdown (no discovery
// endpoint exists to enumerate seasons automatically).
const SUPPORTED_SEASONS = [
  { slug: 'live', label: 'Current Season' },
  { slug: '2026-split-2-patch-1', label: '2026 Season 2 Patch 1' },
  { slug: '2026-split-2', label: '2026 Season 2' },
  { slug: '2026-split-1', label: '2026 Season 1' },
];

/**
 * A player's peak rank/rating for one season, straight from Arena Sweats'
 * own /api/player-peaks — they compute this server-side from every game
 * played, so there's no need to approximate a peak ourselves from periodic
 * snapshots. Cached per (name, tag, region, season) like rank_cache, since
 * an already-fetched season's peak never needs re-fetching outside of a
 * fresh backfill. Throws PlayerNotFoundError if they have no record for
 * this season at all (never played it) or peaks aren't tracked for it.
 */
async function getSeasonPeak(riotName, riotTag, region, season, playerHash) {
  const cacheKey = [riotName.toLowerCase(), riotTag.toLowerCase(), region.toLowerCase(), season];

  const payload = await enqueue(() => fetchJson(
    `${BASE_URL}/player-peaks?player_hash=${encodeURIComponent(playerHash)}`
    + `&region=${encodeURIComponent(region.toLowerCase())}&season=${encodeURIComponent(season)}`,
  ));
  setCachedSeasonPeak(...cacheKey, payload);
  return payload;
}

/**
 * player-peaks needs a player_hash, which normally comes along for free
 * with a rank lookup. Prefers whatever's already cached in rank_cache
 * (from a previous /rank or leaderboard refresh) over a fresh live fetch,
 * since backfilling several existing members at once shouldn't force that
 * many extra live requests just to obtain a hash it probably already has.
 */
async function resolvePlayerHash(riotName, riotTag, region) {
  const cached = getCachedRank(riotName.toLowerCase(), riotTag.toLowerCase(), region.toLowerCase());
  if (cached?.payload?.player_hash) return cached.payload.player_hash;

  const live = await getPlayerRank(riotName, riotTag, region);
  return live.player_hash;
}

/**
 * Fetches and caches one player's peak across every supported season —
 * used both to backfill a brand-new registrant and to backfill everyone
 * already registered the first time a guild's season-highs channel is
 * created. Best-effort per season: a player having no record in an older
 * season (or the whole lookup failing) just means they're absent from
 * that season's leaderboard, not a hard failure.
 */
async function backfillPlayerSeasonPeaks(riotName, riotTag, region) {
  let hash;
  try {
    hash = await resolvePlayerHash(riotName, riotTag, region);
  } catch {
    return;
  }
  if (!hash) return;

  for (const { slug } of SUPPORTED_SEASONS) {
    try {
      await getSeasonPeak(riotName, riotTag, region, slug, hash);
    } catch {
      // No record for this season, or arenasweats.lol hiccuped — that
      // season's leaderboard simply won't include this player this time.
    }
  }
}

module.exports = {
  SUPPORTED_SEASONS,
  getSeasonPeak,
  backfillPlayerSeasonPeaks,
};
