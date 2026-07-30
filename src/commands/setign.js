const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { REGIONS } = require('../config');
const { upsertPlayer } = require('../db');

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

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { data, execute };
