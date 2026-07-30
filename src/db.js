const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('./config');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    discord_id TEXT PRIMARY KEY,
    riot_name  TEXT NOT NULL,
    riot_tag   TEXT NOT NULL,
    region     TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rank_cache (
    riot_name  TEXT NOT NULL,
    riot_tag   TEXT NOT NULL,
    region     TEXT NOT NULL,
    payload    TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (riot_name, riot_tag, region)
  );
`);

const upsertPlayerStmt = db.prepare(`
  INSERT INTO players (discord_id, riot_name, riot_tag, region, updated_at)
  VALUES (@discord_id, @riot_name, @riot_tag, @region, @updated_at)
  ON CONFLICT(discord_id) DO UPDATE SET
    riot_name = excluded.riot_name,
    riot_tag = excluded.riot_tag,
    region = excluded.region,
    updated_at = excluded.updated_at
`);

const getPlayerStmt = db.prepare(`
  SELECT discord_id, riot_name, riot_tag, region, updated_at
  FROM players WHERE discord_id = ?
`);

const getCacheStmt = db.prepare(`
  SELECT payload, fetched_at FROM rank_cache
  WHERE riot_name = ? AND riot_tag = ? AND region = ?
`);

const upsertCacheStmt = db.prepare(`
  INSERT INTO rank_cache (riot_name, riot_tag, region, payload, fetched_at)
  VALUES (@riot_name, @riot_tag, @region, @payload, @fetched_at)
  ON CONFLICT(riot_name, riot_tag, region) DO UPDATE SET
    payload = excluded.payload,
    fetched_at = excluded.fetched_at
`);

function upsertPlayer({ discordId, riotName, riotTag, region }) {
  upsertPlayerStmt.run({
    discord_id: discordId,
    riot_name: riotName,
    riot_tag: riotTag,
    region,
    updated_at: new Date().toISOString(),
  });
}

function getPlayer(discordId) {
  const row = getPlayerStmt.get(discordId);
  if (!row) return null;
  return {
    discordId: row.discord_id,
    riotName: row.riot_name,
    riotTag: row.riot_tag,
    region: row.region,
    updatedAt: row.updated_at,
  };
}

function getCachedRank(riotName, riotTag, region) {
  const row = getCacheStmt.get(riotName, riotTag, region);
  if (!row) return null;
  return { payload: JSON.parse(row.payload), fetchedAt: row.fetched_at };
}

function setCachedRank(riotName, riotTag, region, payload) {
  upsertCacheStmt.run({
    riot_name: riotName,
    riot_tag: riotTag,
    region,
    payload: JSON.stringify(payload),
    fetched_at: new Date().toISOString(),
  });
}

module.exports = {
  upsertPlayer,
  getPlayer,
  getCachedRank,
  setCachedRank,
};
