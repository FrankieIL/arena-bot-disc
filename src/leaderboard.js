const {
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  getGuildLeaderboardRows,
  getGuildLeaderboardMeta,
  setGuildLeaderboardMeta,
  setGuildUpdateLogMessage,
  setGuildInfoMessage,
} = require('./db');
const { getPlayerRank } = require('./arenaSweats');
const RANK_EMOJIS = require('./rankEmojis');

const CHANNEL_NAME = 'arena-leaderboard';
const MEDALS = ['🥇', '🥈', '🥉'];
const REFRESH_BUTTON_ID = 'leaderboard_refresh';
const STATUS_EMOJI = { success: '✅', failure: '❌', pending: '⏳' };

// Update button cooldown: a click re-fetches every registered player live,
// so this is the only thing standing between the button and hammering
// arenasweats.lol on every double-click.
const LIVE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const lastLiveRefreshAt = new Map();

const refreshRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId(REFRESH_BUTTON_ID)
    .setLabel('Update')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary),
);

/**
 * The single ranking rule used everywhere a player list is shown — ranked
 * (has cached data) sorted by rating descending, then pending (never
 * fetched) after. Shared by the leaderboard and the update log so the two
 * always list players in the same order. Ties break on discordId, a stable
 * key independent of input array order, so a tie can never resolve
 * differently between the two messages depending on which order their rows
 * happened to be in going into the sort.
 */
function sortLeaderboardRows(rows) {
  const ranked = rows
    .filter((row) => row.payload)
    .sort((a, b) => (b.payload.rating ?? 0) - (a.payload.rating ?? 0) || a.discordId.localeCompare(b.discordId));
  const pending = rows.filter((row) => !row.payload);
  return { ranked, pending, all: [...ranked, ...pending] };
}

function buildLeaderboardEmbed(rows) {
  const { ranked, pending, all } = sortLeaderboardRows(rows);

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 Arena Leaderboard')
    .setFooter({ text: `${rows.length} player${rows.length === 1 ? '' : 's'} registered` });

  if (all.length === 0) {
    embed.setDescription('No one has registered yet — use `/setign` to join!');
    return embed;
  }

  const nameLines = ranked.map((row, i) => `${formatServerPosition(i)} ${row.riotName}`);
  const rankLines = ranked.map((row) => `${formatTier(row.payload)} (${formatRegionRank(row)})`);
  const ratingLines = ranked.map((row) => `${row.payload.rating ?? '?'}`);

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

/**
 * Medal for the top 3, otherwise "N." for the rest — the period is
 * backslash-escaped so Discord doesn't silently parse a row starting with
 * "4. Name" as Markdown ordered-list syntax (see README's Discord quirks
 * section), which would give that row different line spacing than the rest.
 */
function formatServerPosition(index) {
  return MEDALS[index] ?? `${index + 1}\\.`;
}

/**
 * Position on the player's own region's leaderboard (Arena Sweats'
 * `player_rank` field). Not comparable across players registered under
 * different regions, but shown unlabeled for brevity.
 */
function formatRegionRank(row) {
  const rank = row.payload.player_rank;
  if (rank == null) return '—';
  return `#${rank.toLocaleString()}`;
}

/**
 * league_rank includes trailing "NN LP" for divisional tiers (e.g.
 * "Diamond I 45 LP") — kept as-is. Prefixed with that tier's icon (see
 * rankEmojis.js) when one's been uploaded; the first word of the tier text
 * (e.g. "Diamond" out of "Diamond I 45 LP") is the lookup key.
 */
function formatTier(payload) {
  const tier = (payload.league_rank ?? 'Unranked').trim();
  const key = tier.split(' ')[0].toLowerCase();
  const icon = RANK_EMOJIS[key];
  return icon ? `${icon} ${tier}` : tier;
}

/**
 * How stale a player's underlying Arena Sweats data is — not when we last
 * polled it, but when arenasweats.lol itself last had something to sync
 * (ratings only move when a game finishes, so last_game_timestamp is the
 * same signal behind the "synced X ago" hover on their own leaderboard).
 * Rendered as a Discord relative timestamp so it keeps counting up live
 * without needing another message edit.
 */
function formatDataAge(payload) {
  const timestamp = payload?.last_game_timestamp ? Date.parse(payload.last_game_timestamp) : NaN;
  if (Number.isNaN(timestamp)) return '—';
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

/**
 * The Update button's progress/result display: one row per registered
 * player (in the same order as the leaderboard, via sortLeaderboardRows)
 * with a tick/cross/hourglass showing whether their live fetch succeeded,
 * failed, or hasn't run yet this pass. Persistent and edited in place
 * across clicks/hourly ticks, same self-healing pattern as the leaderboard
 * message itself.
 *
 * `payloads` holds each player's latest known data (freshly fetched where
 * available this run, falling back to whatever was cached before it
 * started) — used for the per-player "how old is this data" text, which is
 * only shown once the run has finished; while it's in flight the number
 * would just be describing stale pre-run data, so it's hidden until then.
 */
function buildUpdateLogEmbed(rows, statuses, payloads, { finished = false, allFailed = false, completedAt } = {}) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(finished ? '🔄 Leaderboard Update' : '🔄 Updating leaderboard…');

  const nameLines = rows.map((row) => row.riotName);
  const statusLines = rows.map((row) => {
    const emoji = STATUS_EMOJI[statuses.get(row.discordId)] ?? STATUS_EMOJI.pending;
    if (!finished) return emoji;
    return `${emoji} ${formatDataAge(payloads.get(row.discordId))}`;
  });

  embed.addFields(
    { name: 'Players', value: nameLines.join('\n'), inline: true },
    { name: 'Status', value: statusLines.join('\n'), inline: true },
  );

  if (finished) {
    const label = allFailed ? 'Last attempted' : 'Updated';
    const statusLine = [`-# ${label} <t:${Math.floor(new Date(completedAt).getTime() / 1000)}:R>`];
    if (allFailed) {
      statusLine.push('-# ⚠️ Update failed — maybe Arena Sweats is down?');
    }
    embed.addFields({ name: '​', value: statusLine.join('\n'), inline: false });
  }

  return embed;
}

function buildInfoEmbed() {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('ℹ️ About this leaderboard')
    .setDescription(
      [
        'Data is sourced from Arena Sweats: https://arenasweats.lol',
        '',
        '**`/setign`** `riot_id` `region` — register your Riot ID to show up below.',
      ].join('\n'),
    );
}

/**
 * Self-healing, static info message. Only ever created (never edited) since
 * its content doesn't change. Sent as the very first message whenever the
 * channel itself is freshly created, so it naturally ends up on top; if it's
 * deleted later on an existing channel, it's recreated but lands wherever
 * that happens to be chronologically — Discord has no way to reorder
 * messages after the fact.
 */
async function ensureInfoMessage(guild, channel) {
  const meta = getGuildLeaderboardMeta(guild.id);
  const existing = meta?.infoMessageId
    ? await channel.messages.fetch(meta.infoMessageId).catch(() => null)
    : null;

  if (existing) return;

  const message = await channel.send({ embeds: [buildInfoEmbed()] });
  setGuildInfoMessage(guild.id, message.id);
}

async function ensureLeaderboardChannel(guild) {
  const meta = getGuildLeaderboardMeta(guild.id);

  if (meta) {
    const existing = guild.channels.cache.get(meta.channelId)
      ?? (await guild.channels.fetch(meta.channelId).catch(() => null));
    if (existing) {
      await ensureInfoMessage(guild, existing);
      return { channel: existing, messageId: meta.messageId };
    }
  }

  // Plain channel, default permissions. An earlier version tried to lock
  // this read-only via permission overwrites, but a two-step overwrite
  // (deny @everyone, then allow the bot) is inherently unsafe: if the
  // second step fails for any reason, the bot locks itself out too, since
  // bots are members of @everyone like anyone else. Not worth the risk for
  // cosmetic polish — anyone who wants it read-only can set that manually.
  const channel = await guild.channels.create({
    name: CHANNEL_NAME,
    type: ChannelType.GuildText,
  });

  setGuildLeaderboardMeta(guild.id, channel.id, null);
  // Sent immediately into the brand-new, empty channel so it's the first message.
  await ensureInfoMessage(guild, channel);
  return { channel, messageId: null };
}

async function drawLeaderboardMessage(guild, channel, messageId) {
  const rows = getGuildLeaderboardRows(guild.id);
  const embed = buildLeaderboardEmbed(rows);

  const message = messageId
    ? await channel.messages.fetch(messageId).catch(() => null)
    : null;

  if (message) {
    await message.edit({ embeds: [embed], components: [refreshRow] });
  } else {
    const sent = await channel.send({ embeds: [embed], components: [refreshRow] });
    setGuildLeaderboardMeta(guild.id, channel.id, sent.id);
  }
}

/**
 * Redraws the guild's leaderboard message from cached rank data only —
 * never calls arenasweats.lol itself. Accepts an already-resolved
 * `{ channel, messageId }` via `resolved` to skip re-fetching the channel
 * when the caller has just done so (e.g. refreshGuildLeaderboardLive).
 * Non-fatal: failures (most likely missing Manage Channels permission) are
 * caught and returned as a warning string, never thrown, so callers' own
 * command replies are unaffected.
 */
async function refreshGuildLeaderboard(guild, resolved) {
  try {
    const { channel, messageId } = resolved ?? (await ensureLeaderboardChannel(guild));
    await drawLeaderboardMessage(guild, channel, messageId);
    return null;
  } catch (err) {
    return `Couldn't update the leaderboard channel (${err.message}). I likely need the "Manage Channels" permission.`;
  }
}

function getLiveRefreshCooldownRemainingMs(guildId) {
  const last = lastLiveRefreshAt.get(guildId);
  if (!last) return 0;
  return Math.max(0, LIVE_REFRESH_COOLDOWN_MS - (Date.now() - last));
}

async function ensureUpdateLogMessage(guild, channel, rows, statuses, payloads) {
  const meta = getGuildLeaderboardMeta(guild.id);
  let message = meta?.updateLogMessageId
    ? await channel.messages.fetch(meta.updateLogMessageId).catch(() => null)
    : null;

  const embed = buildUpdateLogEmbed(rows, statuses, payloads);

  if (message) {
    await message.edit({ embeds: [embed] });
  } else {
    message = await channel.send({ embeds: [embed] });
    setGuildUpdateLogMessage(guild.id, message.id);
  }

  return message;
}

/**
 * Non-bot messages are auto-deleted on sight (see messageCreate in
 * index.js), but occasionally one slips past — so an Update click also
 * sweeps recent channel history for anything that isn't ours as a backstop.
 */
async function sweepStrayMessages(channel) {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return;

  const stray = messages.filter((msg) => msg.author.id !== channel.client.user.id);
  if (stray.size === 0) return;

  await channel.bulkDelete(stray, true).catch(() => {});
}

/**
 * Re-fetches every registered player's rank live, updating a dedicated
 * progress message (created/edited in place, same channel as the
 * leaderboard) as each one completes, then redraws the leaderboard itself.
 * Gated by a per-guild cooldown — callers should check
 * getLiveRefreshCooldownRemainingMs first. A single player's fetch failing
 * doesn't stop the rest; the log message shows exactly which ones did.
 */
async function refreshGuildLeaderboardLive(guild) {
  lastLiveRefreshAt.set(guild.id, Date.now());

  const resolved = await ensureLeaderboardChannel(guild);
  const { channel } = resolved;
  await sweepStrayMessages(channel);
  // Fixed for the whole run — the same order the leaderboard itself uses,
  // computed once up front so rows don't jump around mid-update as fresher
  // data comes in.
  const rows = sortLeaderboardRows(getGuildLeaderboardRows(guild.id)).all;

  if (rows.length === 0) {
    return refreshGuildLeaderboard(guild, resolved);
  }

  const statuses = new Map(rows.map((row) => [row.discordId, 'pending']));
  const payloads = new Map(rows.map((row) => [row.discordId, row.payload]));
  const logMessage = await ensureUpdateLogMessage(guild, channel, rows, statuses, payloads);

  let successCount = 0;
  for (const row of rows) {
    try {
      const result = await getPlayerRank(row.riotName, row.riotTag, row.region);
      statuses.set(row.discordId, result._live ? 'success' : 'failure');
      payloads.set(row.discordId, result);
      if (result._live) successCount += 1;
    } catch {
      statuses.set(row.discordId, 'failure');
    }
    await logMessage.edit({ embeds: [buildUpdateLogEmbed(rows, statuses, payloads)] }).catch(() => {});
  }

  const allFailed = successCount === 0;
  // Re-sort using this run's fresh payloads for the final render, so the
  // finished state matches the order refreshGuildLeaderboard is about to
  // draw the Arena Leaderboard in below — the fixed pre-run order above is
  // only for the in-progress edits, where rows shouldn't jump around.
  const finalRows = sortLeaderboardRows(
    rows.map((row) => ({ ...row, payload: payloads.get(row.discordId) })),
  ).all;
  await logMessage.edit({
    embeds: [buildUpdateLogEmbed(finalRows, statuses, payloads, {
      finished: true,
      allFailed,
      completedAt: new Date().toISOString(),
    })],
  }).catch(() => {});

  return refreshGuildLeaderboard(guild, resolved);
}

module.exports = {
  refreshGuildLeaderboard,
  refreshGuildLeaderboardLive,
  getLiveRefreshCooldownRemainingMs,
  REFRESH_BUTTON_ID,
};
