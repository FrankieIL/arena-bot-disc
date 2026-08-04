const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const { DISCORD_TOKEN } = require('./config');
const { getGuildLeaderboardMeta, getGuildSeasonHighsChannelId } = require('./db');
const setign = require('./commands/setign');
const {
  refreshGuildLeaderboardLive,
  getLiveRefreshCooldownRemainingMs,
  expandUpdateLog,
  getUpdateLogCollapseRemainingMs,
  REFRESH_BUTTON_ID,
  VIEW_UPDATE_DATA_BUTTON_ID,
} = require('./leaderboard');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const STRAY_MESSAGE_NOTICE_LIFETIME_MS = 6000;
const HOUR_MS = 60 * 60 * 1000;

client.commands = new Collection();
client.commands.set(setign.data.name, setign);

/**
 * Same live refresh the Update button triggers, just on a wall-clock-aligned
 * hourly timer instead of a click — shares the same cooldown map, sweep, and
 * log message, so an hourly tick is indistinguishable from someone pressing
 * Update on the hour. One guild's failure (e.g. missing permissions) is
 * caught so it can't stop the rest from refreshing.
 */
async function runAutoUpdate() {
  for (const guild of client.guilds.cache.values()) {
    try {
      await refreshGuildLeaderboardLive(guild);
    } catch (err) {
      console.error(`Error auto-updating leaderboard for guild ${guild.id}:`, err);
    }
  }
}

function scheduleHourlyAutoUpdate() {
  const msUntilNextHour = HOUR_MS - (Date.now() % HOUR_MS);
  setTimeout(() => {
    runAutoUpdate();
    setInterval(runAutoUpdate, HOUR_MS);
  }, msUntilNextHour);
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  scheduleHourlyAutoUpdate();
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
        await interaction.reply({
          content: '⏳ Updates have a 5 minute cooldown.',
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
    return;
  }

  if (interaction.isButton() && interaction.customId === VIEW_UPDATE_DATA_BUTTON_ID) {
    try {
      const cooldownMs = getUpdateLogCollapseRemainingMs(interaction.guildId);
      if (cooldownMs > 0) {
        await interaction.reply({
          content: '⏳ Data is currently showing.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferUpdate();
      await expandUpdateLog(interaction.guild);
    } catch (err) {
      console.error('Error handling view-update-data button:', err);
    }
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.id === client.user.id) return;

  const meta = getGuildLeaderboardMeta(message.guild.id);
  const seasonHighsChannelId = getGuildSeasonHighsChannelId(message.guild.id);
  const isManagedChannel = message.channel.id === meta?.channelId || message.channel.id === seasonHighsChannelId;
  if (!isManagedChannel) return;

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
