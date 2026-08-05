const { EmbedBuilder, ChannelType } = require('discord.js');
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

const CHANNEL_NAME = 'arena-stats';
const AUTO_DELETE_MS = 5 * 60 * 1000;
const MATCH_HISTORY_LIMIT = 5;
const PLACING_MEDALS = { '1st': '🥇', '2nd': '🥈', '3rd': '🥉' };
const RANK_MEDALS = ['🥇', '🥈', '🥉'];

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
    .setColor(0x3498db)
    .setTitle('ℹ️ About this channel')
    .setDescription(
      [
        'Run **`/stats`** anywhere to post your Arena stat card here — win rate, top placement rate, recent matches, and most-played champions.',
        '',
        'Add `user` to check someone else\'s stats instead of your own, e.g. `/stats user:@someone`.',
        '',
        `Each card auto-deletes after ${AUTO_DELETE_MS / 60000} minutes to keep this channel tidy.`,
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

function formatMatchLines(matches) {
  if (!matches || matches.length === 0) {
    return '_No recent matches found._';
  }
  return matches
    .map((match) => {
      const medal = PLACING_MEDALS[match.placing] ?? '';
      const change = match.rating_change > 0 ? `+${match.rating_change}` : `${match.rating_change}`;
      return `${medal} ${match.placing} — **${match.champion}** (${change})`.trim();
    })
    .join('\n');
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
    .setColor(0x3498db)
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
      { name: 'Recent Matches', value: formatMatchLines(matches), inline: false },
    )
    .setFooter({ text: `This card auto-deletes in ${AUTO_DELETE_MS / 60000} minutes • ${region.toUpperCase()}` });

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
  const message = await channel.send({ embeds: [embed] });

  setTimeout(() => message.delete().catch(() => {}), AUTO_DELETE_MS);

  return { jumpLink: message.url };
}

module.exports = {
  postPlayerStats,
  PlayerNotRegisteredError,
  PlayerNotFoundError,
};
