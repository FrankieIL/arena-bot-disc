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

  CREATE TABLE IF NOT EXISTS guild_leaderboard_members (
    guild_id   TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    added_at   TEXT NOT NULL,
    PRIMARY KEY (guild_id, discord_id)
  );

  CREATE TABLE IF NOT EXISTS guild_leaderboards (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    updated_at TEXT NOT NULL
  );
`);

// Migrate columns added after the table already existed on deployed volumes —
// CREATE TABLE IF NOT EXISTS above is a no-op once the table is present.
function ensureColumn(table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn('guild_leaderboards', 'update_log_message_id', 'TEXT');
ensureColumn('guild_leaderboards', 'info_message_id', 'TEXT');

const upsertPlayerStmt = db.prepare(`
  INSERT INTO players (discord_id, riot_name, riot_tag, region, updated_at)
  VALUES (@discord_id, @riot_name, @riot_tag, @region, @updated_at)
  ON CONFLICT(discord_id) DO UPDATE SET
    riot_name = excluded.riot_name,
    riot_tag = excluded.riot_tag,
    region = excluded.region,
    updated_at = excluded.updated_at
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

const addGuildLeaderboardMemberStmt = db.prepare(`
  INSERT INTO guild_leaderboard_members (guild_id, discord_id, added_at)
  VALUES (@guild_id, @discord_id, @added_at)
  ON CONFLICT(guild_id, discord_id) DO NOTHING
`);

const getGuildLeaderboardRowsStmt = db.prepare(`
  SELECT glm.discord_id, p.riot_name, p.riot_tag, p.region, rc.payload
  FROM guild_leaderboard_members glm
  JOIN players p ON p.discord_id = glm.discord_id
  LEFT JOIN rank_cache rc
    ON rc.riot_name = LOWER(p.riot_name)
    AND rc.riot_tag = LOWER(p.riot_tag)
    AND rc.region = LOWER(p.region)
  WHERE glm.guild_id = ?
`);

const getGuildLeaderboardMetaStmt = db.prepare(`
  SELECT channel_id, message_id, update_log_message_id, info_message_id FROM guild_leaderboards WHERE guild_id = ?
`);

const upsertGuildLeaderboardMetaStmt = db.prepare(`
  INSERT INTO guild_leaderboards (guild_id, channel_id, message_id, updated_at)
  VALUES (@guild_id, @channel_id, @message_id, @updated_at)
  ON CONFLICT(guild_id) DO UPDATE SET
    channel_id = excluded.channel_id,
    message_id = excluded.message_id,
    updated_at = excluded.updated_at
`);

const setUpdateLogMessageStmt = db.prepare(`
  UPDATE guild_leaderboards SET update_log_message_id = @message_id WHERE guild_id = @guild_id
`);

const setInfoMessageStmt = db.prepare(`
  UPDATE guild_leaderboards SET info_message_id = @message_id WHERE guild_id = @guild_id
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

function addGuildLeaderboardMember(guildId, discordId) {
  addGuildLeaderboardMemberStmt.run({
    guild_id: guildId,
    discord_id: discordId,
    added_at: new Date().toISOString(),
  });
}

function getGuildLeaderboardRows(guildId) {
  return getGuildLeaderboardRowsStmt.all(guildId).map((row) => ({
    discordId: row.discord_id,
    riotName: row.riot_name,
    riotTag: row.riot_tag,
    region: row.region,
    payload: row.payload ? JSON.parse(row.payload) : null,
  }));
}

function getGuildLeaderboardMeta(guildId) {
  const row = getGuildLeaderboardMetaStmt.get(guildId);
  if (!row) return null;
  return {
    channelId: row.channel_id,
    messageId: row.message_id,
    updateLogMessageId: row.update_log_message_id,
    infoMessageId: row.info_message_id,
  };
}

function setGuildLeaderboardMeta(guildId, channelId, messageId) {
  upsertGuildLeaderboardMetaStmt.run({
    guild_id: guildId,
    channel_id: channelId,
    message_id: messageId,
    updated_at: new Date().toISOString(),
  });
}

function setGuildUpdateLogMessage(guildId, messageId) {
  setUpdateLogMessageStmt.run({ guild_id: guildId, message_id: messageId });
}

function setGuildInfoMessage(guildId, messageId) {
  setInfoMessageStmt.run({ guild_id: guildId, message_id: messageId });
}

module.exports = {
  upsertPlayer,
  getCachedRank,
  setCachedRank,
  addGuildLeaderboardMember,
  getGuildLeaderboardRows,
  getGuildLeaderboardMeta,
  setGuildLeaderboardMeta,
  setGuildUpdateLogMessage,
  setGuildInfoMessage,
};
