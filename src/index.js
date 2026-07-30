const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const { DISCORD_TOKEN } = require('./config');
const { getGuildLeaderboardMeta } = require('./db');
const setign = require('./commands/setign');
const rank = require('./commands/rank');
const { refreshGuildLeaderboard, REFRESH_BUTTON_ID } = require('./leaderboard');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.commands = new Collection();
client.commands.set(setign.data.name, setign);
client.commands.set(rank.data.name, rank);

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
      await interaction.deferUpdate();
      const warning = await refreshGuildLeaderboard(interaction.guild);
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
});

client.login(DISCORD_TOKEN);
