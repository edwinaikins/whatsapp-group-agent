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

  CREATE TABLE IF NOT EXISTS titles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS activity_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    image_path TEXT,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS birthdays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    month INTEGER NOT NULL,
    day INTEGER NOT NULL,
    photo_path TEXT
  );

  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'message',
    text TEXT,
    image_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    error TEXT
  );
`);

// Migration: older databases were created before scheduled_posts could
// represent anything other than a message post — add the `type` column
// if it's missing so existing installs don't need to delete their DB.
const scheduledPostsColumns = db.prepare("PRAGMA table_info(scheduled_posts)").all().map((c) => c.name);
if (!scheduledPostsColumns.includes('type')) {
  db.exec("ALTER TABLE scheduled_posts ADD COLUMN type TEXT NOT NULL DEFAULT 'message'");
}

// ---- Member / idle tracking (unchanged) ----

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

// ---- Titles ----

function listTitles() {
  return db.prepare('SELECT * FROM titles ORDER BY sort_order ASC, id ASC').all();
}

function createTitle({ text, sortOrder = 0 }) {
  const info = db.prepare('INSERT INTO titles (text, sort_order) VALUES (?, ?)').run(text, sortOrder);
  return info.lastInsertRowid;
}

function updateTitle(id, { text, sortOrder }) {
  db.prepare('UPDATE titles SET text = COALESCE(?, text), sort_order = COALESCE(?, sort_order) WHERE id = ?')
    .run(text ?? null, sortOrder ?? null, id);
}

function deleteTitle(id) {
  db.prepare('DELETE FROM titles WHERE id = ?').run(id);
}

// ---- Activity prompts ----

function listPrompts() {
  return db.prepare('SELECT * FROM activity_prompts ORDER BY sort_order ASC, id ASC').all();
}

function getPromptById(id) {
  return db.prepare('SELECT * FROM activity_prompts WHERE id = ?').get(id);
}

function createPrompt({ text, imagePath = null, sortOrder = 0 }) {
  const info = db
    .prepare('INSERT INTO activity_prompts (text, image_path, sort_order) VALUES (?, ?, ?)')
    .run(text, imagePath, sortOrder);
  return info.lastInsertRowid;
}

function updatePrompt(id, { text, imagePath, sortOrder }) {
  db.prepare(
    'UPDATE activity_prompts SET text = COALESCE(?, text), image_path = COALESCE(?, image_path), sort_order = COALESCE(?, sort_order) WHERE id = ?'
  ).run(text ?? null, imagePath ?? null, sortOrder ?? null, id);
}

function deletePrompt(id) {
  db.prepare('DELETE FROM activity_prompts WHERE id = ?').run(id);
}

// ---- Birthdays ----

function listBirthdays() {
  return db.prepare('SELECT * FROM birthdays ORDER BY month ASC, day ASC, id ASC').all();
}

function getBirthdayById(id) {
  return db.prepare('SELECT * FROM birthdays WHERE id = ?').get(id);
}

function createBirthday({ name, phone, month, day, photoPath = null }) {
  const info = db
    .prepare('INSERT INTO birthdays (name, phone, month, day, photo_path) VALUES (?, ?, ?, ?, ?)')
    .run(name, phone, month, day, photoPath);
  return info.lastInsertRowid;
}

function updateBirthday(id, { name, phone, month, day, photoPath }) {
  db.prepare(
    `UPDATE birthdays SET
      name = COALESCE(?, name),
      phone = COALESCE(?, phone),
      month = COALESCE(?, month),
      day = COALESCE(?, day),
      photo_path = COALESCE(?, photo_path)
     WHERE id = ?`
  ).run(name ?? null, phone ?? null, month ?? null, day ?? null, photoPath ?? null, id);
}

function deleteBirthday(id) {
  db.prepare('DELETE FROM birthdays WHERE id = ?').run(id);
}

function getTodaysBirthdays(now = new Date()) {
  return db
    .prepare('SELECT * FROM birthdays WHERE month = ? AND day = ?')
    .all(now.getMonth() + 1, now.getDate());
}

// ---- Scheduled (one-off) posts ----

function listScheduledPosts() {
  return db.prepare('SELECT * FROM scheduled_posts ORDER BY run_at ASC').all();
}

function getScheduledPostById(id) {
  return db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(id);
}

function createScheduledPost({ runAt, type = 'message', text = null, imagePath = null }) {
  const info = db
    .prepare(
      'INSERT INTO scheduled_posts (run_at, type, text, image_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(runAt, type, text, imagePath, 'pending', Date.now());
  return info.lastInsertRowid;
}

function deleteScheduledPost(id) {
  db.prepare("DELETE FROM scheduled_posts WHERE id = ? AND status = 'pending'").run(id);
}

function getDuePosts(nowMs) {
  return db
    .prepare("SELECT * FROM scheduled_posts WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC")
    .all(nowMs);
}

function markPostSent(id) {
  db.prepare("UPDATE scheduled_posts SET status = 'sent', sent_at = ? WHERE id = ?").run(Date.now(), id);
}

function markPostFailed(id, errorMessage) {
  db.prepare("UPDATE scheduled_posts SET status = 'failed', error = ?, sent_at = ? WHERE id = ?")
    .run(errorMessage, Date.now(), id);
}

module.exports = {
  db,
  upsertMemberSeen,
  syncMembershipList,
  getIdleMembers,
  getKV,
  setKV,
  listTitles,
  createTitle,
  updateTitle,
  deleteTitle,
  listPrompts,
  getPromptById,
  createPrompt,
  updatePrompt,
  deletePrompt,
  listBirthdays,
  getBirthdayById,
  createBirthday,
  updateBirthday,
  deleteBirthday,
  getTodaysBirthdays,
  listScheduledPosts,
  getScheduledPostById,
  createScheduledPost,
  deleteScheduledPost,
  getDuePosts,
  markPostSent,
  markPostFailed,
};
