require('dotenv').config();

const REGIONS = [
  'OCE', 'NA', 'EUW', 'ME', 'EUNE', 'KR', 'JP', 'BR',
  'LAS', 'LAN', 'RU', 'TR', 'SEA', 'TW', 'VN',
];

/**
 * Maps arenasweats.lol's region enum (above) to Riot's own routing values —
 * `platform` for platform-routed APIs (league-v4, summoner-v4), `regional`
 * for regional-routed ones (account-v1, match-v5). Every value maps 1:1
 * except SEA: Riot splits that cluster into sg2/th2/ph2 and arenasweats'
 * "SEA" doesn't say which, so it defaults to sg2 (Singapore) — TW and VN are
 * already broken out separately in the enum above, so SEA only ever covers
 * the remainder. Wrong for a specific player only if they're actually on
 * th2/ph2, and a one-line fix here if so.
 */
const REGION_TO_RIOT = {
  OCE: { platform: 'oc1', regional: 'sea' },
  NA: { platform: 'na1', regional: 'americas' },
  EUW: { platform: 'euw1', regional: 'europe' },
  ME: { platform: 'me1', regional: 'europe' },
  EUNE: { platform: 'eun1', regional: 'europe' },
  KR: { platform: 'kr', regional: 'asia' },
  JP: { platform: 'jp1', regional: 'asia' },
  BR: { platform: 'br1', regional: 'americas' },
  LAS: { platform: 'la2', regional: 'americas' },
  LAN: { platform: 'la1', regional: 'americas' },
  RU: { platform: 'ru', regional: 'europe' },
  TR: { platform: 'tr1', regional: 'europe' },
  SEA: { platform: 'sg2', regional: 'sea' },
  TW: { platform: 'tw2', regional: 'sea' },
  VN: { platform: 'vn2', regional: 'sea' },
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  REGIONS,
  REGION_TO_RIOT,
  DISCORD_TOKEN: requireEnv('DISCORD_TOKEN'),
  CLIENT_ID: requireEnv('CLIENT_ID'),
  GUILD_ID: process.env.GUILD_ID || null,
  REQUEST_DELAY_MS: Number(process.env.REQUEST_DELAY_MS) || 100,
  RIOT_API_KEY: requireEnv('RIOT_API_KEY'),
  // Sized to stay comfortably under a personal Riot API key's 100-req/2min
  // bucket per routing cluster, same throttling role as REQUEST_DELAY_MS.
  RIOT_REQUEST_DELAY_MS: Number(process.env.RIOT_REQUEST_DELAY_MS) || 1300,
  // Overridable so a hosting platform's mounted volume (e.g. /data/bot.sqlite3) can be used in production.
  DB_PATH: process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'bot.sqlite3'),
};
