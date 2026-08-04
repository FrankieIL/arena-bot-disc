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
const VIEW_UPDATE_DATA_BUTTON_ID = 'leaderboard_view_update_data';
const STATUS_EMOJI = { success: '✅', failure: '❌', pending: '⏳' };

// Update button cooldown: a click re-fetches every registered player live,
// so this is the only thing standing between the button and hammering
// arenasweats.lol on every double-click.
const LIVE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const lastLiveRefreshAt = new Map();

// Whether each guild currently has its update-log message expanded (full
// per-player table) rather than the default collapsed one-liner — purely a
// display preference, in-memory like the cooldown above, so it resets to
// collapsed on restart. View Update Data expands it for AUTO_COLLAPSE_MS and
// then it reverts on its own; updateLogExpandedUntil backs the cooldown a
// second click is rejected with while that window is still open.
const updateLogExpanded = new Map();
const updateLogExpandedUntil = new Map();
const AUTO_COLLAPSE_MS = 30 * 1000;
// Latest known rows/statuses/payloads for each guild's update-log message,
// kept live throughout a run so an expand click landing mid-update can
// redraw instantly instead of waiting for the run's own next edit.
const updateLogRunState = new Map();

const refreshRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId(REFRESH_BUTTON_ID)
    .setLabel('Update')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary),
  new ButtonBuilder()
    .setCustomId(VIEW_UPDATE_DATA_BUTTON_ID)
    .setLabel('View Update Data')
    .setEmoji('📊')
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
 *
 * `expanded` toggles between this full per-player table and a one-line
 * summary (see buildCollapsedUpdateLogEmbed) — the message defaults to
 * collapsed and is only expanded on demand via the View Update Data button,
 * so most of the time this detail is tucked away.
 */
function buildUpdateLogEmbed(rows, statuses, payloads, {
  finished = false,
  allFailed = false,
  completedAt = null,
  expanded = false,
} = {}) {
  if (!expanded) {
    return buildCollapsedUpdateLogEmbed(rows, statuses, { finished, allFailed, completedAt });
  }

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(finished ? updateStatusTitle({ allFailed, completedAt }) : '🔄 Updating leaderboard…');

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

  if (finished && allFailed) {
    embed.addFields({ name: '​', value: '-# ⚠️ Update failed — maybe Arena Sweats is down?', inline: false });
  }

  return embed;
}

/**
 * "Updated X ago" / "Last attempted X ago" — the title for a finished run,
 * in both the collapsed and expanded embeds, so the data's freshness is the
 * headline rather than a generic "Leaderboard Update" label.
 */
function updateStatusTitle({ allFailed, completedAt }) {
  if (!completedAt) return '🔄 No update recorded yet — press Update';
  const label = allFailed ? 'Last attempted' : 'Updated';
  const warning = allFailed ? ' ⚠️' : '';
  return `🔄 ${label} <t:${Math.floor(new Date(completedAt).getTime() / 1000)}:R>${warning}`;
}

/**
 * Resting-state view of the update log: while idle, a single title line
 * ("Updated X ago"); while a run is in progress, a single line of the same
 * tick/cross/hourglass emoji as the expanded table, in the same row order,
 * so progress is still visible live without the full per-player breakdown.
 */
function buildCollapsedUpdateLogEmbed(rows, statuses, { finished, allFailed, completedAt }) {
  const embed = new EmbedBuilder().setColor(0xf1c40f);

  if (!finished) {
    embed.setTitle('🔄 Updating leaderboard…');
    const emojiLine = rows.map((row) => STATUS_EMOJI[statuses.get(row.discordId)] ?? STATUS_EMOJI.pending).join(' ');
    embed.setDescription(emojiLine || '_No players registered yet._');
    return embed;
  }

  embed.setTitle(updateStatusTitle({ allFailed, completedAt }));
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
  const components = [refreshRow];

  const message = messageId
    ? await channel.messages.fetch(messageId).catch(() => null)
    : null;

  if (message) {
    await message.edit({ embeds: [embed], components });
  } else {
    const sent = await channel.send({ embeds: [embed], components });
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

  const embed = buildUpdateLogEmbed(rows, statuses, payloads, { expanded: isUpdateLogExpanded(guild.id) });

  if (message) {
    await message.edit({ embeds: [embed] });
  } else {
    message = await channel.send({ embeds: [embed] });
    setGuildUpdateLogMessage(guild.id, message.id);
  }

  return message;
}

function isUpdateLogExpanded(guildId) {
  return updateLogExpanded.get(guildId) ?? false;
}

/**
 * Records the latest rows/statuses/payloads/finished state for a guild's
 * update log as a run progresses, so a View Update Data click landing
 * mid-run (or right after one finishes) can redraw instantly from the most
 * recent known progress instead of waiting for the run's own next edit.
 */
function recordUpdateLogState(guildId, state) {
  updateLogRunState.set(guildId, state);
}

/**
 * Redraws a guild's update-log message using whatever progress is currently
 * known for it, in its current expand/collapse state. Used both by the View
 * Update Data toggle and by the 30-second auto-collapse timer it starts.
 * No-op if the message can't be found (e.g. deleted) — it'll be recreated
 * self-healingly next time a real update runs.
 */
async function redrawUpdateLogMessage(guild, channel, messageId) {
  const state = updateLogRunState.get(guild.id)
    ?? { rows: sortLeaderboardRows(getGuildLeaderboardRows(guild.id)).all, statuses: new Map(), payloads: new Map(), finished: true, allFailed: false, completedAt: null };

  // Edits by ID directly rather than fetching the message first — the
  // fetch would just be a wasted round trip since only the ID is needed.
  await channel.messages.edit(messageId, {
    embeds: [buildUpdateLogEmbed(state.rows, state.statuses, state.payloads, {
      finished: state.finished,
      allFailed: state.allFailed,
      completedAt: state.completedAt,
      expanded: isUpdateLogExpanded(guild.id),
    })],
  }).catch(() => {});
}

/**
 * Milliseconds left before a currently-expanded update log auto-collapses,
 * or 0 if it's not expanded — callers should check this before calling
 * expandUpdateLog and reject the click with a cooldown-style message if
 * it's non-zero, same as the Update button's own cooldown.
 */
function getUpdateLogCollapseRemainingMs(guildId) {
  const until = updateLogExpandedUntil.get(guildId);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

/**
 * Handles a View Update Data click: expands the guild's update-log message
 * from its collapsed one-liner into the full per-player table for
 * AUTO_COLLAPSE_MS, then reverts it on its own — a one-shot reveal, not a
 * toggle, since a second click while it's already expanded is rejected by
 * the cooldown check above rather than handled here. Works mid-update too,
 * since it just re-renders whatever progress is currently recorded via
 * recordUpdateLogState. A no-op if no update has ever run for this guild,
 * since there's nothing to reveal yet.
 */
async function expandUpdateLog(guild) {
  const meta = getGuildLeaderboardMeta(guild.id);
  if (!meta?.updateLogMessageId) return;

  const channel = guild.channels.cache.get(meta.channelId)
    ?? (await guild.channels.fetch(meta.channelId).catch(() => null));
  if (!channel) return;

  updateLogExpanded.set(guild.id, true);
  updateLogExpandedUntil.set(guild.id, Date.now() + AUTO_COLLAPSE_MS);

  // Scheduled from the same instant as the deadline above, before the
  // redraw's await — starting it after would let this timer's real fire
  // time drift past updateLogExpandedUntil by however long that edit took,
  // opening a gap where a click landing in it starts a fresh expand only
  // for this stale timer to cut it short moments later.
  setTimeout(() => {
    updateLogExpanded.set(guild.id, false);
    updateLogExpandedUntil.delete(guild.id);
    redrawUpdateLogMessage(guild, channel, meta.updateLogMessageId).catch(() => {});
  }, AUTO_COLLAPSE_MS);

  await redrawUpdateLogMessage(guild, channel, meta.updateLogMessageId);
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
  recordUpdateLogState(guild.id, { rows, statuses, payloads, finished: false, allFailed: false, completedAt: null });
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
    recordUpdateLogState(guild.id, { rows, statuses, payloads, finished: false, allFailed: false, completedAt: null });
    await logMessage.edit({
      embeds: [buildUpdateLogEmbed(rows, statuses, payloads, { expanded: isUpdateLogExpanded(guild.id) })],
    }).catch(() => {});
  }

  const allFailed = successCount === 0;
  // Re-sort using this run's fresh payloads for the final render, so the
  // finished state matches the order refreshGuildLeaderboard is about to
  // draw the Arena Leaderboard in below — the fixed pre-run order above is
  // only for the in-progress edits, where rows shouldn't jump around.
  const finalRows = sortLeaderboardRows(
    rows.map((row) => ({ ...row, payload: payloads.get(row.discordId) })),
  ).all;
  const completedAt = new Date().toISOString();
  recordUpdateLogState(guild.id, { rows: finalRows, statuses, payloads, finished: true, allFailed, completedAt });
  await logMessage.edit({
    embeds: [buildUpdateLogEmbed(finalRows, statuses, payloads, {
      finished: true,
      allFailed,
      completedAt,
      expanded: isUpdateLogExpanded(guild.id),
    })],
  }).catch(() => {});

  return refreshGuildLeaderboard(guild, resolved);
}

module.exports = {
  refreshGuildLeaderboard,
  refreshGuildLeaderboardLive,
  getLiveRefreshCooldownRemainingMs,
  expandUpdateLog,
  getUpdateLogCollapseRemainingMs,
  REFRESH_BUTTON_ID,
  VIEW_UPDATE_DATA_BUTTON_ID,
};
