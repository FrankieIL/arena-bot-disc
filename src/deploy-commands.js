const { REST, Routes } = require('discord.js');
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = require('./config');
const setign = require('./commands/setign');
const stats = require('./commands/stats');

const commands = [setign.data.toJSON(), stats.data.toJSON()];
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);

    const scope = GUILD_ID ? `guild ${GUILD_ID}` : 'globally';
    console.log(`Registering ${commands.length} slash command(s) ${scope}...`);

    await rest.put(route, { body: commands });

    console.log('Slash commands registered successfully.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
    process.exitCode = 1;
  }
})();
