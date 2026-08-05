const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { postPlayerStats, PlayerNotRegisteredError, PlayerNotFoundError } = require('../stats');
const { ArenaSweatsUnavailableError } = require('../arenaSweats');

const data = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Post an Arena stat card to #arena-stats')
  .addUserOption((option) =>
    option
      .setName('user')
      .setDescription('Whose stats to pull (defaults to you)')
      .setRequired(false),
  );

async function execute(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: 'This command only works in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const isSelf = targetUser.id === interaction.user.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { jumpLink } = await postPlayerStats(interaction.guild, targetUser.id);
    await interaction.editReply({
      content: `Posted ${isSelf ? 'your' : `${targetUser}'s`} stats: ${jumpLink}`,
    });
  } catch (err) {
    if (err instanceof PlayerNotRegisteredError) {
      const content = isSelf
        ? "You haven't registered yet — run `/setign` first."
        : "That user hasn't registered yet — tell them to run `/setign`.";
      await interaction.editReply({ content });
      return;
    }
    if (err instanceof PlayerNotFoundError) {
      await interaction.editReply({
        content: "Arena Sweats doesn't have any data for that player yet.",
      });
      return;
    }
    if (err instanceof ArenaSweatsUnavailableError) {
      await interaction.editReply({
        content: "Couldn't fetch stats right now — Arena Sweats might be down. Try again shortly.",
      });
      return;
    }
    console.error('Error handling /stats:', err);
    await interaction.editReply({ content: 'Something went wrong fetching those stats.' });
  }
}

module.exports = { data, execute };
