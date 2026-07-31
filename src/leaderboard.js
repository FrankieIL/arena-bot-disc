const {
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getGuildLeaderboardRows, getGuildLeaderboardMeta, setGuildLeaderboardMeta } = require('./db');

const CHANNEL_NAME = 'arena-leaderboard';
const MEDALS = ['🥇', '🥈', '🥉'];
const REFRESH_BUTTON_ID = 'leaderboard_refresh';

const refreshRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId(REFRESH_BUTTON_ID)
    .setLabel('Update')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary),
);

function buildLeaderboardEmbed(rows) {
  const ranked = rows
    .filter((row) => row.payload)
    .sort((a, b) => (b.payload.rating ?? 0) - (a.payload.rating ?? 0));
  const pending = rows.filter((row) => !row.payload);
  const all = [...ranked, ...pending];

  let body;
  if (all.length === 0) {
    body = 'No one has registered yet — use `/setign` to join!';
  } else {
    const prefixWidth = 4;
    const nameWidth = Math.max('Players'.length, ...all.map((row) => row.riotName.length)) + 2;
    const header = `${' '.repeat(prefixWidth)}${'Players'.padEnd(nameWidth)}Rank`;
    const separator = '─'.repeat(header.length);

    const rankLines = ranked.map((row, i) => {
      const prefix = (MEDALS[i] ?? `${i + 1}.`).padEnd(prefixWidth);
      const name = row.riotName.padEnd(nameWidth);
      const tier = row.payload.league_rank ?? 'Unranked';
      const rating = row.payload.rating ?? '?';
      return `${prefix}${name}${tier} · ${rating} RATING`;
    });

    const pendingLines = pending.map((row) => {
      const prefix = '•'.padEnd(prefixWidth);
      return `${prefix}${row.riotName.padEnd(nameWidth)}pending — run /rank`;
    });

    body = '```\n' + [header, separator, ...rankLines, ...pendingLines].join('\n') + '\n```';
  }
  const updatedLine = `\n\n-# Updated <t:${Math.floor(Date.now() / 1000)}:R>`;

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 Arena Leaderboard')
    .setDescription(body + updatedLine)
    .setFooter({ text: `${rows.length} player${rows.length === 1 ? '' : 's'} registered` });

  return embed;
}

async function ensureLeaderboardChannel(guild) {
  const meta = getGuildLeaderboardMeta(guild.id);

  if (meta) {
    const existing = guild.channels.cache.get(meta.channelId)
      ?? (await guild.channels.fetch(meta.channelId).catch(() => null));
    if (existing) return { channel: existing, messageId: meta.messageId };
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
  return { channel, messageId: null };
}

/**
 * Recreates the guild's leaderboard message from cached rank data only —
 * never calls arenasweats.lol. Non-fatal: failures (most likely missing
 * Manage Channels permission) are caught and returned as a warning string,
 * never thrown, so callers' own command replies are unaffected.
 */
async function refreshGuildLeaderboard(guild) {
  try {
    const { channel, messageId } = await ensureLeaderboardChannel(guild);
    const rows = getGuildLeaderboardRows(guild.id);
    const embed = buildLeaderboardEmbed(rows);

    let message = messageId
      ? await channel.messages.fetch(messageId).catch(() => null)
      : null;

    if (message) {
      await message.edit({ embeds: [embed], components: [refreshRow] });
    } else {
      message = await channel.send({ embeds: [embed], components: [refreshRow] });
      setGuildLeaderboardMeta(guild.id, channel.id, message.id);
    }

    return null;
  } catch (err) {
    return `Couldn't update the leaderboard channel (${err.message}). I likely need the "Manage Channels" permission.`;
  }
}

module.exports = { refreshGuildLeaderboard, REFRESH_BUTTON_ID };
