require('dotenv').config();

const REGIONS = [
  'OCE', 'NA', 'EUW', 'ME', 'EUNE', 'KR', 'JP', 'BR',
  'LAS', 'LAN', 'RU', 'TR', 'SEA', 'TW', 'VN',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  REGIONS,
  DISCORD_TOKEN: requireEnv('DISCORD_TOKEN'),
  CLIENT_ID: requireEnv('CLIENT_ID'),
  GUILD_ID: process.env.GUILD_ID || null,
  REQUEST_DELAY_MS: Number(process.env.REQUEST_DELAY_MS) || 500,
  // Overridable so a hosting platform's mounted volume (e.g. /data/bot.sqlite3) can be used in production.
  DB_PATH: process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'bot.sqlite3'),
};
