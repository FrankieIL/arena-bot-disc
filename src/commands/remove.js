const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { removeGuildLeaderboardMember } = require('../db');
const { refreshGuildLeaderboard } = require('../leaderboard');
const { refreshGuildSoloqLeaderboard } = require('../soloqLeaderboard');
const { scheduleEphemeralDismiss } = require('../interactions');

const data = new SlashCommandBuilder()
  .setName('remove')
  .setDescription("Remove yourself (or, if you're an admin, another member) from this server's leaderboards")
  .addUserOption((option) =>
    option
      .setName('user')
      .setDescription('Who to remove (defaults to you) — only admins can remove someone else')
      .setRequired(false),
  );

async function execute(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral });
    scheduleEphemeralDismiss(interaction);
    return;
  }

  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const isSelf = targetUser.id === interaction.user.id;

  if (!isSelf && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: 'Only server admins can remove someone else — you can remove yourself with `/remove`.',
      flags: MessageFlags.Ephemeral,
    });
    scheduleEphemeralDismiss(interaction);
    return;
  }

  const removed = removeGuildLeaderboardMember(interaction.guildId, targetUser.id);
  if (!removed) {
    const content = isSelf
      ? "You're not currently on this server's leaderboards."
      : `${targetUser} isn't currently on this server's leaderboards.`;
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    scheduleEphemeralDismiss(interaction);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Removes them from the Arena and Solo Queue boards' cached display in
  // this server at once — both draw from the same guild roster this command
  // just deleted a row from. A redraw failure (e.g. missing permissions)
  // still leaves the removal itself in effect, just surfaced as a warning.
  const arenaWarning = await refreshGuildLeaderboard(interaction.guild);
  const soloqWarning = await refreshGuildSoloqLeaderboard(interaction.guild);

  const content = isSelf
    ? "You've been removed from this server's leaderboards. Run `/setign` any time to rejoin."
    : `${targetUser} has been removed from this server's leaderboards. They can run \`/setign\` any time to rejoin.`;

  await interaction.editReply({ content: [content, arenaWarning, soloqWarning].filter(Boolean).join('\n') });
  scheduleEphemeralDismiss(interaction);
}

module.exports = { data, execute };
