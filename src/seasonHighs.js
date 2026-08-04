const { EmbedBuilder, ChannelType } = require('discord.js');
const {
  getGuildLeaderboardRows,
  getGuildSeasonHighsChannelId,
  setGuildSeasonHighsChannelId,
  getGuildSeasonHighMessageId,
  setGuildSeasonHighMessageId,
  getGuildSeasonHighRows,
} = require('./db');
const { SUPPORTED_SEASONS, backfillPlayerSeasonPeaks } = require('./seasonPeaks');
const { formatServerPosition } = require('./format');

const CHANNEL_NAME = 'arena-season-highs';
const LIVE_SEASON = SUPPORTED_SEASONS.find((season) => season.slug === 'live');

/**
 * Self-healing create-or-fetch, same pattern as ensureLeaderboardChannel in
 * leaderboard.js. The one difference: on a genuine first-ever creation (no
 * channel ID stored at all yet, as opposed to a stored one that's since
 * been manually deleted) every already-registered member is backfilled
 * across every supported season — otherwise anyone who registered before
 * this feature existed would be silently absent. A recreation after manual
 * deletion skips this, since season_peak_cache already has their data.
 */
async function ensureSeasonHighsChannel(guild) {
  const existingChannelId = getGuildSeasonHighsChannelId(guild.id);
  const isFirstEverCreation = !existingChannelId;

  if (existingChannelId) {
    const existing = guild.channels.cache.get(existingChannelId)
      ?? (await guild.channels.fetch(existingChannelId).catch(() => null));
    if (existing) return existing;
  }

  const channel = await guild.channels.create({ name: CHANNEL_NAME, type: ChannelType.GuildText });
  setGuildSeasonHighsChannelId(guild.id, channel.id);

  if (isFirstEverCreation) {
    const members = getGuildLeaderboardRows(guild.id);
    for (const member of members) {
      await backfillPlayerSeasonPeaks(member.riotName, member.riotTag, member.region).catch(() => {});
    }
  }

  return channel;
}

function sortSeasonHighRows(rows) {
  return [...rows].sort(
    (a, b) => (b.payload.peak_rating ?? 0) - (a.payload.peak_rating ?? 0) || a.discordId.localeCompare(b.discordId),
  );
}

function formatPeakRegionRank(row) {
  const rank = row.payload.peak_rank;
  if (rank == null) return '—';
  return `#${rank.toLocaleString()}`;
}

/**
 * Same title/color/footer/column style as buildLeaderboardEmbed in
 * leaderboard.js — the only real difference is the values themselves
 * (peak instead of current). One deliberate deviation: the Rank column has
 * no tier text, since player-peaks doesn't return one like player_rank
 * does, and inventing a rating-to-tier mapping would risk showing a tier
 * that's actually wrong — exactly what was ruled out for this feature.
 */
function buildSeasonHighEmbed(label, rows) {
  const sorted = sortSeasonHighRows(rows);

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🏆 Arena Leaderboard — ${label}`)
    .setFooter({ text: `${sorted.length} player${sorted.length === 1 ? '' : 's'} with a recorded peak` });

  if (sorted.length === 0) {
    embed.setDescription('No one has a recorded peak for this season yet.');
    return embed;
  }

  const nameLines = sorted.map((row, i) => `${formatServerPosition(i)} ${row.riotName}`);
  const rankLines = sorted.map((row) => formatPeakRegionRank(row));
  const ratingLines = sorted.map((row) => `${row.payload.peak_rating ?? '?'}`);

  embed.addFields(
    { name: 'Players', value: nameLines.join('\n'), inline: true },
    { name: 'Rank', value: rankLines.join('\n'), inline: true },
    { name: 'Rating', value: ratingLines.join('\n'), inline: true },
  );

  return embed;
}

async function drawSeasonHighMessage(guild, channel, season, label) {
  const rows = getGuildSeasonHighRows(guild.id, season);
  const embed = buildSeasonHighEmbed(label, rows);
  const messageId = getGuildSeasonHighMessageId(guild.id, season);

  const message = messageId
    ? await channel.messages.fetch(messageId).catch(() => null)
    : null;

  if (message) {
    await message.edit({ embeds: [embed] });
  } else {
    const sent = await channel.send({ embeds: [embed] });
    setGuildSeasonHighMessageId(guild.id, season, sent.id);
  }
}

/**
 * Redraws every supported season's message from whatever's currently
 * cached — no live fetches. Used after a backfill (a new registrant, or a
 * fresh channel's initial backfill of existing members).
 */
async function refreshGuildSeasonHighs(guild) {
  try {
    const channel = await ensureSeasonHighsChannel(guild);
    for (const { slug, label } of SUPPORTED_SEASONS) {
      await drawSeasonHighMessage(guild, channel, slug, label);
    }
    return null;
  } catch (err) {
    return `Couldn't update the season-highs channel (${err.message}). I likely need the "Manage Channels" permission.`;
  }
}

/**
 * Redraws just the current-season message — called alongside the main
 * leaderboard's own hourly/manual refresh, since that's the only season
 * whose peak can still change. Archived seasons are frozen once recorded
 * and are only touched by a backfill.
 */
async function refreshCurrentSeasonHigh(guild) {
  try {
    const channel = await ensureSeasonHighsChannel(guild);
    await drawSeasonHighMessage(guild, channel, LIVE_SEASON.slug, LIVE_SEASON.label);
    return null;
  } catch (err) {
    return `Couldn't update the current season-high message (${err.message}).`;
  }
}

module.exports = {
  CHANNEL_NAME,
  ensureSeasonHighsChannel,
  refreshGuildSeasonHighs,
  refreshCurrentSeasonHigh,
};
