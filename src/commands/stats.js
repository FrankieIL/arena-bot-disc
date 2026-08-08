const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { postPlayerStats, PlayerNotRegisteredError, PlayerNotFoundError } = require('../stats');
const { ArenaSweatsUnavailableError } = require('../arenaSweats');
const { getGuildStatsChannel } = require('../db');
const { scheduleEphemeralDismiss } = require('../interactions');

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
    scheduleEphemeralDismiss(interaction);
    return;
  }

  const statsChannelMeta = getGuildStatsChannel(interaction.guildId);
  const statsChannel = statsChannelMeta
    ? interaction.guild.channels.cache.get(statsChannelMeta.channelId)
      ?? (await interaction.guild.channels.fetch(statsChannelMeta.channelId).catch(() => null))
    : null;

  if (!statsChannel) {
    await interaction.reply({
      content: "The stats channel hasn't been set up yet — ask someone to run `/setign` first.",
      flags: MessageFlags.Ephemeral,
    });
    scheduleEphemeralDismiss(interaction);
    return;
  }

  if (interaction.channelId !== statsChannel.id) {
    await interaction.reply({
      content: `Please use this command in ${statsChannel}.`,
      flags: MessageFlags.Ephemeral,
    });
    scheduleEphemeralDismiss(interaction);
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
      scheduleEphemeralDismiss(interaction);
      return;
    }
    if (err instanceof PlayerNotFoundError) {
      await interaction.editReply({
        content: "Arena Sweats doesn't have any data for that player yet.",
      });
      scheduleEphemeralDismiss(interaction);
      return;
    }
    if (err instanceof ArenaSweatsUnavailableError) {
      await interaction.editReply({
        content: "Couldn't fetch stats right now — Arena Sweats might be down. Try again shortly.",
      });
      scheduleEphemeralDismiss(interaction);
      return;
    }
    console.error('Error handling /stats:', err);
    await interaction.editReply({ content: 'Something went wrong fetching those stats.' });
    scheduleEphemeralDismiss(interaction);
    return;
  }
  scheduleEphemeralDismiss(interaction);
}

module.exports = { data, execute };
