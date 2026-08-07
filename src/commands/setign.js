const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { REGIONS } = require('../config');
const { upsertPlayer, addGuildLeaderboardMember } = require('../db');
const { getPlayerRank } = require('../arenaSweats');
const { getPlayerSoloRank } = require('../riotApi');
const { refreshGuildLeaderboard } = require('../leaderboard');
const { ensureStatsChannel } = require('../stats');
const { refreshGuildSoloqLeaderboard } = require('../soloqLeaderboard');

const data = new SlashCommandBuilder()
  .setName('setign')
  .setDescription('Register your Riot ID and region for Arena and Solo Queue rank lookups')
  .addStringOption((option) =>
    option
      .setName('riot_id')
      .setDescription('Your Riot ID, e.g. PlayerOne#EUW1')
      .setRequired(true),
  )
  .addStringOption((option) => {
    option
      .setName('region')
      .setDescription('Your arenasweats.lol region')
      .setRequired(true);
    for (const region of REGIONS) {
      option.addChoices({ name: region, value: region });
    }
    return option;
  });

async function execute(interaction) {
  const riotId = interaction.options.getString('riot_id', true).trim();
  const region = interaction.options.getString('region', true);

  const separatorIndex = riotId.lastIndexOf('#');
  if (separatorIndex <= 0 || separatorIndex === riotId.length - 1) {
    await interaction.reply({
      content: 'That doesn\'t look like a valid Riot ID. Use the format `Name#Tag`, e.g. `PlayerOne#EUW1`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const riotName = riotId.slice(0, separatorIndex).trim();
  const riotTag = riotId.slice(separatorIndex + 1).trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  upsertPlayer({
    discordId: interaction.user.id,
    riotName,
    riotTag,
    region,
  });

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Riot ID registered')
    .setDescription(`\`${riotName}#${riotTag}\` (${region}) is now linked to your Discord account.`)
    .setFooter({ text: 'Check #arena-leaderboard or #soloq-leaderboard anytime to see your current rating.' });

  if (interaction.guild) {
    // Best-effort: seed the cache so the leaderboard doesn't show this entry as pending.
    await getPlayerRank(riotName, riotTag, region).catch(() => {});

    addGuildLeaderboardMember(interaction.guildId, interaction.user.id);
    const warning = await refreshGuildLeaderboard(interaction.guild);
    if (warning) {
      embed.addFields({ name: 'Leaderboard', value: warning });
    }

    try {
      await ensureStatsChannel(interaction.guild);
    } catch (err) {
      embed.addFields({ name: 'Stats channel', value: `Couldn't create #arena-stats (${err.message}).` });
    }

    // Best-effort: seed the cache so the Solo Queue leaderboard doesn't show this entry as pending.
    await getPlayerSoloRank(interaction.user.id, riotName, riotTag, region).catch(() => {});

    const soloqWarning = await refreshGuildSoloqLeaderboard(interaction.guild);
    if (soloqWarning) {
      embed.addFields({ name: 'Solo Queue leaderboard', value: soloqWarning });
    }
  }

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute };
