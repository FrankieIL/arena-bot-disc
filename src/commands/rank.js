const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayer } = require('../db');
const { getPlayerRank, PlayerNotFoundError, ArenaSweatsUnavailableError } = require('../arenaSweats');
const { refreshGuildLeaderboard } = require('../leaderboard');

const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Look up an Arena mode rank from arenasweats.lol')
  .addUserOption((option) =>
    option
      .setName('user')
      .setDescription('Look up someone else\'s registered rank (defaults to you)')
      .setRequired(false),
  );

function formatRelativeTime(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function buildRankEmbed(riotName, riotTag, region, rankData) {
  const winRate = rankData.games > 0 ? ((rankData.wins / rankData.games) * 100).toFixed(1) : null;

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`${riotName}#${riotTag}`)
    .addFields(
      { name: 'Tier', value: String(rankData.league_rank ?? 'Unranked'), inline: true },
      { name: 'Rating', value: String(rankData.rating ?? 'N/A'), inline: true },
      { name: 'Leaderboard Rank', value: `#${rankData.player_rank ?? '?'} (${region})`, inline: true },
    );

  if (winRate !== null) {
    embed.addFields({ name: 'Win Rate', value: `${winRate}% (${rankData.wins}/${rankData.games})`, inline: true });
  }
  if (typeof rankData.games_played === 'number') {
    embed.addFields({ name: 'Games Played', value: String(rankData.games_played), inline: true });
  }

  const cacheNote = rankData._cached
    ? `Cached data · fetched ${formatRelativeTime(rankData._fetchedAt)}`
    : 'Freshly fetched from arenasweats.lol';
  embed.setFooter({ text: cacheNote });

  return embed;
}

async function execute(interaction) {
  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const isSelf = targetUser.id === interaction.user.id;

  const player = getPlayer(targetUser.id);
  if (!player) {
    const who = isSelf ? 'You haven\'t' : `${targetUser.username} hasn't`;
    await interaction.reply({
      content: `${who} registered a Riot ID yet. ${isSelf ? 'Run' : 'Ask them to run'} \`/setign\` first.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const rankData = await getPlayerRank(player.riotName, player.riotTag, player.region);
    const embed = buildRankEmbed(player.riotName, player.riotTag, player.region, rankData);
    await interaction.editReply({ embeds: [embed] });

    if (interaction.guild) {
      await refreshGuildLeaderboard(interaction.guild);
    }
  } catch (err) {
    if (err instanceof PlayerNotFoundError) {
      await interaction.editReply({
        content: `No Arena data found for \`${player.riotName}#${player.riotTag}\` in region **${player.region}**. ` +
          'Double-check the name, tag, and region with `/setign` — they may also not have played ranked Arena yet.',
      });
      return;
    }
    if (err instanceof ArenaSweatsUnavailableError) {
      await interaction.editReply({
        content: 'arenasweats.lol is unreachable right now. Please try again in a few minutes.',
      });
      return;
    }
    throw err;
  }
}

module.exports = { data, execute };
