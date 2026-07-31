const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const { DISCORD_TOKEN } = require('./config');
const { getGuildLeaderboardMeta } = require('./db');
const setign = require('./commands/setign');
const {
  refreshGuildLeaderboardLive,
  getLiveRefreshCooldownRemainingMs,
  REFRESH_BUTTON_ID,
} = require('./leaderboard');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const STRAY_MESSAGE_NOTICE_LIFETIME_MS = 6000;

client.commands = new Collection();
client.commands.set(setign.data.name, setign);

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Error executing /${interaction.commandName}:`, err);
      const content = 'Something went wrong running that command.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content }).catch(() => {});
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === REFRESH_BUTTON_ID) {
    try {
      const cooldownMs = getLiveRefreshCooldownRemainingMs(interaction.guildId);
      if (cooldownMs > 0) {
        const seconds = Math.ceil(cooldownMs / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainder = seconds % 60;
        const wait = minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
        await interaction.reply({
          content: `⏳ The leaderboard was just refreshed — try again in ${wait}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferUpdate();
      const warning = await refreshGuildLeaderboardLive(interaction.guild);
      if (warning) {
        await interaction.followUp({ content: warning, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch (err) {
      console.error('Error handling leaderboard refresh button:', err);
    }
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.id === client.user.id) return;

  const meta = getGuildLeaderboardMeta(message.guild.id);
  if (!meta || message.channel.id !== meta.channelId) return;

  await message.delete().catch(() => {});

  const notice = await message.channel.send({
    content: `⚠️ ${message.author}, this channel is for the leaderboard only — your message was removed.`,
    allowedMentions: { users: [message.author.id] },
  }).catch(() => null);

  if (notice) {
    setTimeout(() => notice.delete().catch(() => {}), STRAY_MESSAGE_NOTICE_LIFETIME_MS);
  }
});

client.login(DISCORD_TOKEN);
