const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'agent.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    jid TEXT PRIMARY KEY,
    name TEXT,
    last_seen_at INTEGER,
    joined_at INTEGER,
    is_admin INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

function upsertMemberSeen(jid, name, whenMs) {
  const existing = db.prepare('SELECT jid FROM members WHERE jid = ?').get(jid);
  if (existing) {
    db.prepare(
      'UPDATE members SET last_seen_at = ?, name = COALESCE(?, name) WHERE jid = ?'
    ).run(whenMs, name || null, jid);
  } else {
    db.prepare(
      'INSERT INTO members (jid, name, last_seen_at, joined_at) VALUES (?, ?, ?, ?)'
    ).run(jid, name || jid, whenMs, whenMs);
  }
}

function syncMembershipList(participants) {
  // participants: [{ jid, name, admin }]
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO members (jid, name, joined_at, is_admin)
    VALUES (@jid, @name, @now, @admin)
    ON CONFLICT(jid) DO UPDATE SET
      name = excluded.name,
      is_admin = excluded.is_admin
  `);
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      upsert.run({ jid: p.jid, name: p.name || p.jid, now, admin: p.admin ? 1 : 0 });
    }
  });
  tx(participants);

  // Remove members who left the group
  const currentJids = new Set(participants.map((p) => p.jid));
  const existing = db.prepare('SELECT jid FROM members').all();
  const del = db.prepare('DELETE FROM members WHERE jid = ?');
  for (const row of existing) {
    if (!currentJids.has(row.jid)) del.run(row.jid);
  }
}

function getIdleMembers(idleAfterDays) {
  const cutoff = Date.now() - idleAfterDays * 24 * 60 * 60 * 1000;
  return db
    .prepare(
      'SELECT jid, name, last_seen_at, joined_at FROM members WHERE is_admin = 0 AND (last_seen_at IS NULL OR last_seen_at < ?) ORDER BY COALESCE(last_seen_at, joined_at) ASC'
    )
    .all(cutoff);
}

function getKV(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setKV(key, value) {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

module.exports = {
  db,
  upsertMemberSeen,
  syncMembershipList,
  getIdleMembers,
  getKV,
  setKV,
};
