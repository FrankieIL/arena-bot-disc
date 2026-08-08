const { EmbedBuilder, ChannelType, MessageFlags } = require('discord.js');
const {
  getPlayer,
  getGuildStatsChannel,
  setGuildStatsChannel,
  setGuildStatsInfoMessage,
} = require('./db');
const {
  getPlayerRank,
  getPlayerTopChampions,
  getPlayerMatchHistory,
  PlayerNotFoundError,
} = require('./arenaSweats');
const RANK_EMOJIS = require('./rankEmojis');
const PLACEMENT_EMOJIS = require('./placementEmojis');

const CHANNEL_NAME = 'arena-stats';
const AUTO_DELETE_MS = 5 * 60 * 1000;
const MATCH_HISTORY_LIMIT = 20;
const GAMES_PER_ROW = 10;
const RANK_MEDALS = ['🥇', '🥈', '🥉'];
const EMBED_COLOR = 0x95a5a6;

class PlayerNotRegisteredError extends Error {}

/**
 * Same tier-icon-prefixing rule as the main leaderboard
 * (`formatTier`/`formatRegionRank` in leaderboard.js) — kept as a local copy
 * since these are one-liners and a stats card has no other reason to import
 * from leaderboard.js.
 */
function formatTier(payload) {
  const tier = (payload.league_rank ?? 'Unranked').trim();
  const key = tier.split(' ')[0].toLowerCase();
  const icon = RANK_EMOJIS[key];
  return icon ? `${icon} ${tier}` : tier;
}

function formatRegionRank(payload) {
  const rank = payload.player_rank;
  if (rank == null) return '—';
  return `#${rank.toLocaleString()}`;
}

/**
 * How stale the underlying Arena Sweats data is — not when we fetched it,
 * but when arenasweats.lol itself last had something to sync (ratings only
 * move when a game finishes), same signal and same local-copy rationale as
 * leaderboard.js's own formatDataAge.
 */
function formatDataAge(payload) {
  const timestamp = payload?.last_game_timestamp ? Date.parse(payload.last_game_timestamp) : NaN;
  if (Number.isNaN(timestamp)) return null;
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

function formatWinRate(payload) {
  const games = payload.games ?? 0;
  if (games === 0) return '—';
  const wins = payload.wins ?? 0;
  const pct = ((wins / games) * 100).toFixed(1);
  return `${wins}/${games} (${pct}%)`;
}

function formatTopHalfRate(payload) {
  const games = payload.games ?? 0;
  if (games === 0) return '—';
  return `${payload.tophalf_percent ?? '?'}%`;
}

function buildInfoEmbed() {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('ℹ️ Channel Information')
    .setDescription(
      [
        'Run **`/stats`** in this channel to post your Arena stat card — win rate, top placement rate, recent matches, and most-played champions.',
        '',
        'Add `user` to check someone else\'s stats instead of your own, e.g. `/stats user`.',
      ].join('\n'),
    );
}

/**
 * Self-healing, static info message — same one-shot "only created, never
 * edited" pattern as the leaderboard channel's `ensureInfoMessage`.
 */
async function ensureInfoMessage(guild, channel) {
  const meta = getGuildStatsChannel(guild.id);
  const existing = meta?.infoMessageId
    ? await channel.messages.fetch(meta.infoMessageId).catch(() => null)
    : null;

  if (existing) return;

  const message = await channel.send({ embeds: [buildInfoEmbed()] });
  setGuildStatsInfoMessage(guild.id, message.id);
}

/**
 * Same self-healing create-or-fetch pattern as `ensureLeaderboardChannel` —
 * a plain channel with default permissions (see that function's comment for
 * why a two-step lockdown overwrite isn't worth the self-lockout risk).
 */
async function ensureStatsChannel(guild) {
  const meta = getGuildStatsChannel(guild.id);

  if (meta) {
    const existing = guild.channels.cache.get(meta.channelId)
      ?? (await guild.channels.fetch(meta.channelId).catch(() => null));
    if (existing) {
      await ensureInfoMessage(guild, existing);
      return existing;
    }
  }

  const channel = await guild.channels.create({
    name: CHANNEL_NAME,
    type: ChannelType.GuildText,
  });

  setGuildStatsChannel(guild.id, channel.id);
  await ensureInfoMessage(guild, channel);
  return channel;
}

/**
 * The stats channel allows free chat (unlike the leaderboard channel, which
 * deletes stray messages on sight) but still needs to stay tidy. Instead of
 * each card tracking its own separate delete timer, every message posted to
 * the channel — cards and stray chat alike — is queued here and swept
 * together AUTO_DELETE_MS after the *most recently posted* card, so a new
 * card resets the clock for everything still pending. Once the timer fires
 * with nothing new queued behind it, the channel is empty again.
 */
const pendingCleanup = new Map(); // channelId -> { messageIds: Set<string>, timer: NodeJS.Timeout|null }

function getCleanupState(channelId) {
  let state = pendingCleanup.get(channelId);
  if (!state) {
    state = { messageIds: new Set(), timer: null };
    pendingCleanup.set(channelId, state);
  }
  return state;
}

async function sweepChannel(channel) {
  const state = pendingCleanup.get(channel.id);
  if (!state) return;
  pendingCleanup.delete(channel.id);

  const ids = [...state.messageIds];
  if (ids.length > 0) {
    await channel.bulkDelete(ids, true).catch(() => {});
  }
}

function scheduleChannelCleanup(channel, messageId) {
  const state = getCleanupState(channel.id);
  state.messageIds.add(messageId);
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => sweepChannel(channel), AUTO_DELETE_MS);
}

/** Queues a non-card message (stray chat) to be swept alongside the next card cleanup, without starting/resetting the timer itself. */
function trackStrayMessage(channel, messageId) {
  getCleanupState(channel.id).messageIds.add(messageId);
}

function formatChampionLines(champions) {
  if (!champions || champions.length === 0) {
    return '_No games played this season yet._';
  }
  return champions
    .map((champ, i) => {
      const medal = RANK_MEDALS[i] ?? `${i + 1}.`;
      const winRate = champ.games ? `${((champ.wins / champ.games) * 100).toFixed(0)}%` : '—';
      return `${medal} **${champ.champion}** — ${champ.games} games, ${champ.wins}W (${winRate}), avg placing ${champ.avg_placing ?? '?'}`;
    })
    .join('\n');
}

/**
 * `tophalf_label` is "Top 3" for the 3x6 team-size format (6 possible
 * placements) or "Top 4" for 2x8 (8 possible placements) — the number in it
 * doubles as the good/bad cutoff for a placement number, so no separate
 * format lookup is needed.
 */
function topHalfCutoff(topHalfLabel) {
  const match = /\d+/.exec(topHalfLabel || '');
  return match ? Number(match[0]) : 4;
}

/**
 * Placement history as a grid of colored tiles (green = top-half finish,
 * red = bottom-half), styled after arenasweats.lol's own recent-games
 * display — see scripts/generate-placement-icons.js for how the tiles
 * themselves were made. Falls back to a plain number for any placement
 * outside 1-8 (shouldn't happen, but better than a broken emoji mention).
 */
function buildRecentGamesGrid(matches, topHalfLabel) {
  if (!matches || matches.length === 0) {
    return '_No recent matches found._';
  }

  const cutoff = topHalfCutoff(topHalfLabel);
  const tiles = matches
    .map((match) => parseInt(match.placing, 10))
    .filter((placement) => !Number.isNaN(placement))
    .map((placement) => {
      const variant = placement <= cutoff ? 'good' : 'bad';
      return PLACEMENT_EMOJIS[placement]?.[variant] ?? `${placement}`;
    });

  const rows = [];
  for (let i = 0; i < tiles.length; i += GAMES_PER_ROW) {
    rows.push(tiles.slice(i, i + GAMES_PER_ROW).join(' '));
  }

  return `${rows.join('\n')}\n-# Last ${tiles.length} game${tiles.length === 1 ? '' : 's'}`;
}

/**
 * Builds the stat card embed. `topChamps`/`matches` are best-effort — a
 * failed or empty fetch for either just renders as "no data yet" rather
 * than failing the whole card, since the core rank/rate stats from
 * `rankPayload` are the only load-bearing piece.
 */
function buildStatsEmbed(riotName, riotTag, region, rankPayload, topChamps, matches) {
  const topHalfLabel = rankPayload.tophalf_label || 'Top 3';

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`📊 ${riotName}#${riotTag}`)
    .addFields(
      { name: 'Rank', value: formatTier(rankPayload), inline: true },
      { name: 'Rating', value: `${rankPayload.rating ?? '?'}`, inline: true },
      { name: 'Region Rank', value: formatRegionRank(rankPayload), inline: true },
      { name: 'Win Rate', value: formatWinRate(rankPayload), inline: true },
      { name: `${topHalfLabel} Rate`, value: formatTopHalfRate(rankPayload), inline: true },
      { name: 'Avg Placing', value: `${rankPayload.avg_placing ?? '—'}`, inline: true },
      { name: 'Best Win Streak', value: `${rankPayload.best_win_streak ?? '—'}`, inline: true },
      { name: `Best ${topHalfLabel} Streak`, value: `${rankPayload.best_tophalf_streak ?? '—'}`, inline: true },
      { name: 'Avg KDA', value: `${rankPayload.avg_kda ?? '—'}`, inline: true },
      { name: 'Most Played Champions', value: formatChampionLines(topChamps), inline: false },
      { name: 'Recent Matches', value: buildRecentGamesGrid(matches, topHalfLabel), inline: false },
    )
    .setFooter({ text: region.toUpperCase() });

  const dataAge = formatDataAge(rankPayload);
  if (dataAge) {
    // Zero-width-space field name so this reads as a footer-style caption
    // rather than a labeled stat — same trick leaderboard.js's update log
    // uses for its own "-# Last update took Xs" line. A footer can't be used
    // instead since Discord doesn't parse markdown (including timestamp
    // tags) inside embed footers.
    embed.addFields({ name: '​', value: `-# Synced ${dataAge}`, inline: false });
  }

  return embed;
}

/**
 * Resolves a Discord ID to their registered Riot ID, fetches their current
 * stats (rank/rate stats are load-bearing — a failure there fails the whole
 * command; champions/match-history are best-effort), posts the card to the
 * guild's stats channel, and schedules its auto-delete. Throws
 * `PlayerNotRegisteredError` if the target hasn't run `/setign`, or
 * whatever `getPlayerRank` throws (PlayerNotFoundError /
 * ArenaSweatsUnavailableError) if the live fetch fails.
 */
async function postPlayerStats(guild, targetDiscordId) {
  const player = getPlayer(targetDiscordId);
  if (!player) {
    throw new PlayerNotRegisteredError();
  }

  const { riotName, riotTag, region } = player;
  const rankPayload = await getPlayerRank(riotName, riotTag, region);
  const [topChamps, matches] = await Promise.all([
    getPlayerTopChampions(riotName, riotTag, region).catch(() => []),
    getPlayerMatchHistory(riotName, riotTag, region, MATCH_HISTORY_LIMIT).catch(() => []),
  ]);

  const channel = await ensureStatsChannel(guild);
  const embed = buildStatsEmbed(riotName, riotTag, region, rankPayload, topChamps, matches);
  // Suppresses push/desktop notifications for this card (Discord's "@silent")
  // — someone checking their own stats shouldn't buzz everyone else's phone.
  // The message still posts and still shows as unread, just without the ping.
  const message = await channel.send({ embeds: [embed], flags: MessageFlags.SuppressNotifications });
  scheduleChannelCleanup(channel, message.id);

  return { jumpLink: message.url };
}

module.exports = {
  postPlayerStats,
  ensureStatsChannel,
  trackStrayMessage,
  PlayerNotRegisteredError,
  PlayerNotFoundError,
};
