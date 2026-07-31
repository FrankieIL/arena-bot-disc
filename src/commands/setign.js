const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { REGIONS } = require('../config');
const { upsertPlayer, addGuildLeaderboardMember } = require('../db');
const { getPlayerRank, ArenaSweatsUnavailableError } = require('../arenaSweats');
const { refreshGuildLeaderboard } = require('../leaderboard');

const data = new SlashCommandBuilder()
  .setName('setign')
  .setDescription('Register your Riot ID and region for Arena rank lookups')
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
      ephemeral: true,
    });
    return;
  }

  const riotName = riotId.slice(0, separatorIndex).trim();
  const riotTag = riotId.slice(separatorIndex + 1).trim();

  await interaction.deferReply({ ephemeral: true });

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
    .setFooter({ text: 'Use /rank anytime to look up your current Arena rating.' });

  if (interaction.guild) {
    // Best-effort: seed the cache so the leaderboard doesn't show this entry
    // as pending. A bad/mistyped IGN (PlayerNotFoundError) isn't a site-
    // availability signal, so it's swallowed without affecting the
    // leaderboard's "last updated"/"update failed" status.
    let outcome;
    try {
      const result = await getPlayerRank(riotName, riotTag, region);
      outcome = result._live ? 'success' : 'failure';
    } catch (err) {
      outcome = err instanceof ArenaSweatsUnavailableError ? 'failure' : undefined;
    }

    addGuildLeaderboardMember(interaction.guildId, interaction.user.id);
    const warning = await refreshGuildLeaderboard(interaction.guild, outcome);
    if (warning) {
      embed.addFields({ name: 'Leaderboard', value: warning });
    }
  }

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute };
