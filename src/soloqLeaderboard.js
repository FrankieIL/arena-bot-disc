const {
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  getGuildSoloqLeaderboardRows,
  getGuildSoloqLeaderboardMeta,
  setGuildSoloqLeaderboardMeta,
  setGuildSoloqUpdateLogMessage,
  setGuildSoloqInfoMessage,
} = require('./db');
const { getPlayerSoloRank } = require('./riotApi');
const RANK_EMOJIS = require('./rankEmojis');

const CHANNEL_NAME = 'soloq-leaderboard';
const MEDALS = ['🥇', '🥈', '🥉'];
const SOLOQ_REFRESH_BUTTON_ID = 'soloq_leaderboard_refresh';
const SOLOQ_VIEW_UPDATE_DATA_BUTTON_ID = 'soloq_leaderboard_view_update_data';
const STATUS_EMOJI = { success: '✅', failure: '❌', pending: '⏳' };
const EMBED_COLOR = 0x9b59b6;

// Ranked tiers in ascending order — same set (and the same uploaded icons,
// via RANK_EMOJIS) as Arena mode, since League's tier system is shared
// across queues. Index in this array doubles as the tier's sort weight.
const TIER_ORDER = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];
const DIVISION_ORDER = { IV: 0, III: 1, II: 2, I: 3 };
// Master+ have no real divisions — Riot's API still sets `rank` to a
// leftover placeholder value for them, which is never shown.
const APEX_TIERS = new Set(['master', 'grandmaster', 'challenger']);

const LIVE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const lastLiveRefreshAt = new Map();

const updateLogExpanded = new Map();
const updateLogExpandedUntil = new Map();
const updateLogExpandToken = new Map();
const AUTO_COLLAPSE_MS = 30 * 1000;
const updateLogRunState = new Map();

const refreshRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId(SOLOQ_REFRESH_BUTTON_ID)
    .setLabel('Update')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary),
  new ButtonBuilder()
    .setCustomId(SOLOQ_VIEW_UPDATE_DATA_BUTTON_ID)
    .setLabel('View Update Data')
    .setEmoji('📊')
    .setStyle(ButtonStyle.Secondary),
);

/**
 * Sort weight for a Solo Queue payload — tier, then division, then LP, in
 * that priority order (LP resets every promotion, so raw LP alone isn't
 * globally ordered the way Arena's flat rating number is). Division weight
 * (1,000,000) and tier weight (10,000,000) both comfortably dominate any
 * realistic LP value, so this collapses cleanly to a single sortable number.
 * A payload with no tier (unranked, or not yet fetched) scores lowest.
 */
function soloqScore(payload) {
  if (!payload?.tier) return -1;
  const tierIndex = TIER_ORDER.indexOf(payload.tier.toLowerCase());
  const divisionIndex = DIVISION_ORDER[payload.division] ?? 0;
  return tierIndex * 10_000_000 + divisionIndex * 1_000_000 + (payload.leaguePoints ?? 0);
}

/**
 * Same ranked/pending split as leaderboard.js's sortLeaderboardRows — rows
 * with a payload (fetched at least once, ranked or not) sorted by score
 * descending, rows never fetched yet listed after as pending. Ties break on
 * discordId for the same reason: a stable key independent of input order.
 */
function sortSoloqRows(rows) {
  const ranked = rows
    .filter((row) => row.payload)
    .sort((a, b) => soloqScore(b.payload) - soloqScore(a.payload) || a.discordId.localeCompare(b.discordId));
  const pending = rows.filter((row) => !row.payload);
  return { ranked, pending, all: [...ranked, ...pending] };
}

function formatServerPosition(index) {
  return MEDALS[index] ?? `${index + 1}\\.`;
}

/**
 * `{icon} Tier Division` (e.g. "💎 Diamond I"), just the tier name for
 * apex tiers (no division), or "Unranked" if the account has no Solo Queue
 * entry at all.
 */
function formatTier(payload) {
  if (!payload?.tier) return 'Unranked';
  const tierKey = payload.tier.toLowerCase();
  const tierText = payload.tier.charAt(0) + payload.tier.slice(1).toLowerCase();
  const label = APEX_TIERS.has(tierKey) ? tierText : `${tierText} ${payload.division ?? ''}`.trim();
  const icon = RANK_EMOJIS[tierKey];
  return icon ? `${icon} ${label}` : label;
}

function formatRating(payload) {
  return `${payload.leaguePoints ?? 0} LP`;
}

function buildLeaderboardEmbed(rows) {
  const { ranked, pending, all } = sortSoloqRows(rows);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('🛡️ Solo Queue Leaderboard')
    .setFooter({ text: `${rows.length} player${rows.length === 1 ? '' : 's'} registered` });

  if (all.length === 0) {
    embed.setDescription('No one has registered yet — use `/setign` to join!');
    return embed;
  }

  const nameLines = ranked.map((row, i) => `${formatServerPosition(i)} ${row.riotName}`);
  const rankLines = ranked.map((row) => formatTier(row.payload));
  const ratingLines = ranked.map((row) => formatRating(row.payload));

  pending.forEach((row, i) => {
    const position = ranked.length + i;
    nameLines.push(`${formatServerPosition(position)} ${row.riotName}`);
    rankLines.push('_pending_');
    ratingLines.push('—');
  });

  embed.addFields(
    { name: 'Players', value: nameLines.join('\n'), inline: true },
    { name: 'Rank', value: rankLines.join('\n'), inline: true },
    { name: 'Rating', value: ratingLines.join('\n'), inline: true },
  );

  return embed;
}

function buildUpdateLogEmbed(rows, statuses, {
  finished = false,
  allFailed = false,
  completedAt = null,
  durationMs = null,
  expanded = false,
} = {}) {
  if (!expanded) {
    return buildCollapsedUpdateLogEmbed(rows, statuses, { finished, allFailed, completedAt });
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(finished ? updateStatusTitle({ allFailed, completedAt }) : '🔄 Updating leaderboard…');

  const nameLines = rows.map((row) => row.riotName);
  const statusLines = rows.map((row) => STATUS_EMOJI[statuses.get(row.discordId)] ?? STATUS_EMOJI.pending);

  embed.addFields(
    { name: 'Players', value: nameLines.join('\n'), inline: true },
    { name: 'Status', value: statusLines.join('\n'), inline: true },
  );

  if (finished) {
    const footerLines = [];
    if (durationMs != null) {
      footerLines.push(`-# Last update took ${(durationMs / 1000).toFixed(1)}s`);
    }
    if (allFailed) {
      footerLines.push('-# ⚠️ Update failed — check RIOT_API_KEY, or Riot\'s API may be down?');
    }
    if (footerLines.length > 0) {
      embed.addFields({ name: '​', value: footerLines.join('\n'), inline: false });
    }
  }

  return embed;
}

function updateStatusTitle({ allFailed, completedAt }) {
  if (!completedAt) return '🔄 No update recorded yet — press Update';
  const label = allFailed ? 'Last attempted' : 'Updated';
  const warning = allFailed ? ' ⚠️' : '';
  return `🔄 ${label} <t:${Math.floor(new Date(completedAt).getTime() / 1000)}:R>${warning}`;
}

function buildCollapsedUpdateLogEmbed(rows, statuses, { finished, allFailed, completedAt }) {
  const embed = new EmbedBuilder().setColor(EMBED_COLOR);

  if (!finished) {
    embed.setTitle('🔄 Updating leaderboard…');
    const emojiLine = rows.map((row) => STATUS_EMOJI[statuses.get(row.discordId)] ?? STATUS_EMOJI.pending).join(' ');
    embed.setDescription(emojiLine || '_No players registered yet._');
    return embed;
  }

  embed.setTitle(updateStatusTitle({ allFailed, completedAt }));

  if (completedAt) {
    if (allFailed) {
      embed.setDescription('-# ⚠️ Update failed — check RIOT_API_KEY, or Riot\'s API may be down?');
    } else {
      const failedCount = rows.filter((row) => statuses.get(row.discordId) === 'failure').length;
      if (failedCount > 0) {
        embed.setDescription(`-# ${failedCount} failed`);
      }
    }
  }

  return embed;
}

function buildInfoEmbed() {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('ℹ️ Channel Info')
    .setDescription(
      [
        'Data is sourced directly from Riot Games\' official API — Solo/Duo ranked stats.',
        '',
        '**`/setign`** `riot_id` `region` — register your Riot ID to show up below.',
      ].join('\n'),
    );
}

async function ensureInfoMessage(guild, channel) {
  const meta = getGuildSoloqLeaderboardMeta(guild.id);
  const existing = meta?.infoMessageId
    ? await channel.messages.fetch(meta.infoMessageId).catch(() => null)
    : null;

  if (existing) return;

  const message = await channel.send({ embeds: [buildInfoEmbed()] });
  setGuildSoloqInfoMessage(guild.id, message.id);
}

async function ensureSoloqLeaderboardChannel(guild) {
  const meta = getGuildSoloqLeaderboardMeta(guild.id);

  if (meta) {
    const existing = guild.channels.cache.get(meta.channelId)
      ?? (await guild.channels.fetch(meta.channelId).catch(() => null));
    if (existing) {
      await ensureInfoMessage(guild, existing);
      return { channel: existing, messageId: meta.messageId };
    }
  }

  const channel = await guild.channels.create({
    name: CHANNEL_NAME,
    type: ChannelType.GuildText,
  });

  setGuildSoloqLeaderboardMeta(guild.id, channel.id, null);
  await ensureInfoMessage(guild, channel);
  return { channel, messageId: null };
}

async function drawLeaderboardMessage(guild, channel, messageId) {
  const rows = getGuildSoloqLeaderboardRows(guild.id);
  const embed = buildLeaderboardEmbed(rows);
  const components = [refreshRow];

  const message = messageId
    ? await channel.messages.fetch(messageId).catch(() => null)
    : null;

  if (message) {
    await message.edit({ embeds: [embed], components });
  } else {
    const sent = await channel.send({ embeds: [embed], components });
    setGuildSoloqLeaderboardMeta(guild.id, channel.id, sent.id);
  }
}

async function refreshGuildSoloqLeaderboard(guild, resolved) {
  try {
    const { channel, messageId } = resolved ?? (await ensureSoloqLeaderboardChannel(guild));
    await drawLeaderboardMessage(guild, channel, messageId);
    return null;
  } catch (err) {
    return `Couldn't update the Solo Queue leaderboard channel (${err.message}). I likely need the "Manage Channels" permission.`;
  }
}

function getSoloqLiveRefreshCooldownRemainingMs(guildId) {
  const last = lastLiveRefreshAt.get(guildId);
  if (!last) return 0;
  return Math.max(0, LIVE_REFRESH_COOLDOWN_MS - (Date.now() - last));
}

async function ensureUpdateLogMessage(guild, channel, rows, statuses) {
  const meta = getGuildSoloqLeaderboardMeta(guild.id);
  let message = meta?.updateLogMessageId
    ? await channel.messages.fetch(meta.updateLogMessageId).catch(() => null)
    : null;

  const embed = buildUpdateLogEmbed(rows, statuses, { expanded: isUpdateLogExpanded(guild.id) });

  if (message) {
    await message.edit({ embeds: [embed] });
  } else {
    message = await channel.send({ embeds: [embed] });
    setGuildSoloqUpdateLogMessage(guild.id, message.id);
  }

  return message;
}

function isUpdateLogExpanded(guildId) {
  return updateLogExpanded.get(guildId) ?? false;
}

function recordUpdateLogState(guildId, state) {
  updateLogRunState.set(guildId, state);
}

async function redrawUpdateLogMessage(guild, channel, messageId) {
  const state = updateLogRunState.get(guild.id)
    ?? { rows: sortSoloqRows(getGuildSoloqLeaderboardRows(guild.id)).all, statuses: new Map(), finished: true, allFailed: false, completedAt: null, durationMs: null };

  await channel.messages.edit(messageId, {
    embeds: [buildUpdateLogEmbed(state.rows, state.statuses, {
      finished: state.finished,
      allFailed: state.allFailed,
      completedAt: state.completedAt,
      durationMs: state.durationMs,
      expanded: isUpdateLogExpanded(guild.id),
    })],
  }).catch(() => {});
}

function getSoloqUpdateLogCollapseRemainingMs(guildId) {
  const until = updateLogExpandedUntil.get(guildId);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

async function expandSoloqUpdateLog(guild) {
  const meta = getGuildSoloqLeaderboardMeta(guild.id);
  if (!meta?.updateLogMessageId) return;

  const channel = guild.channels.cache.get(meta.channelId)
    ?? (await guild.channels.fetch(meta.channelId).catch(() => null));
  if (!channel) return;

  const token = (updateLogExpandToken.get(guild.id) ?? 0) + 1;
  updateLogExpandToken.set(guild.id, token);

  updateLogExpanded.set(guild.id, true);
  updateLogExpandedUntil.set(guild.id, Date.now() + AUTO_COLLAPSE_MS);

  setTimeout(() => {
    if (updateLogExpandToken.get(guild.id) !== token) return;
    updateLogExpanded.set(guild.id, false);
    updateLogExpandedUntil.delete(guild.id);
    redrawUpdateLogMessage(guild, channel, meta.updateLogMessageId).catch(() => {});
  }, AUTO_COLLAPSE_MS);

  await redrawUpdateLogMessage(guild, channel, meta.updateLogMessageId);
}

async function sweepStrayMessages(channel) {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return;

  const stray = messages.filter((msg) => msg.author.id !== channel.client.user.id);
  if (stray.size === 0) return;

  await channel.bulkDelete(stray, true).catch(() => {});
}

const activeLiveRefreshes = new Set();

async function refreshGuildSoloqLeaderboardLive(guild) {
  if (activeLiveRefreshes.has(guild.id)) {
    return 'An update is already in progress for this server — hang tight.';
  }
  activeLiveRefreshes.add(guild.id);

  try {
    const startedAt = Date.now();
    lastLiveRefreshAt.set(guild.id, startedAt);

    const resolved = await ensureSoloqLeaderboardChannel(guild);
    const { channel } = resolved;
    await sweepStrayMessages(channel);
    const rows = sortSoloqRows(getGuildSoloqLeaderboardRows(guild.id)).all;

    if (rows.length === 0) {
      return refreshGuildSoloqLeaderboard(guild, resolved);
    }

    const statuses = new Map(rows.map((row) => [row.discordId, 'pending']));
    // Latest known payload per player — not shown directly in the update log
    // (see buildUpdateLogEmbed), but still needed to sort finalRows below by
    // this run's fresh results once everyone's been fetched.
    const payloads = new Map(rows.map((row) => [row.discordId, row.payload]));
    recordUpdateLogState(guild.id, {
      rows, statuses, finished: false, allFailed: false, completedAt: null, durationMs: null,
    });
    const logMessage = await ensureUpdateLogMessage(guild, channel, rows, statuses);

    let successCount = 0;
    for (const row of rows) {
      try {
        const result = await getPlayerSoloRank(row.discordId, row.riotName, row.riotTag, row.region);
        statuses.set(row.discordId, result._live ? 'success' : 'failure');
        payloads.set(row.discordId, result);
        if (result._live) successCount += 1;
      } catch {
        statuses.set(row.discordId, 'failure');
      }
      recordUpdateLogState(guild.id, {
        rows, statuses, finished: false, allFailed: false, completedAt: null, durationMs: null,
      });
      await logMessage.edit({
        embeds: [buildUpdateLogEmbed(rows, statuses, { expanded: isUpdateLogExpanded(guild.id) })],
      }).catch(() => {});
    }

    const allFailed = successCount === 0;
    const finalRows = sortSoloqRows(
      rows.map((row) => ({ ...row, payload: payloads.get(row.discordId) })),
    ).all;
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    lastLiveRefreshAt.set(guild.id, Date.now());
    recordUpdateLogState(guild.id, { rows: finalRows, statuses, finished: true, allFailed, completedAt, durationMs });
    await logMessage.edit({
      embeds: [buildUpdateLogEmbed(finalRows, statuses, {
        finished: true,
        allFailed,
        completedAt,
        durationMs,
        expanded: isUpdateLogExpanded(guild.id),
      })],
    }).catch(() => {});

    return refreshGuildSoloqLeaderboard(guild, resolved);
  } finally {
    activeLiveRefreshes.delete(guild.id);
  }
}

module.exports = {
  ensureSoloqLeaderboardChannel,
  refreshGuildSoloqLeaderboard,
  refreshGuildSoloqLeaderboardLive,
  getSoloqLiveRefreshCooldownRemainingMs,
  expandSoloqUpdateLog,
  getSoloqUpdateLogCollapseRemainingMs,
  SOLOQ_REFRESH_BUTTON_ID,
  SOLOQ_VIEW_UPDATE_DATA_BUTTON_ID,
};
