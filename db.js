'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { AsyncLocalStorage } = require('node:async_hooks');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// The app was previously called "remember". Rename its database files in place
// once, so an existing install keeps all data instead of starting empty.
const DB_FILE = path.join(DATA_DIR, 'todo.db');
const LEGACY_DB_FILE = path.join(DATA_DIR, 'remember.db');
if (!fs.existsSync(DB_FILE) && fs.existsSync(LEGACY_DB_FILE)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(LEGACY_DB_FILE + suffix)) fs.renameSync(LEGACY_DB_FILE + suffix, DB_FILE + suffix);
  }
}

const db = new sqlite3.Database(DB_FILE);
db.configure('busyTimeout', 5000);

function runRaw(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

// Process-wide write mutex: EVERY database write in the process runs
// through here, in order. The app shares one sqlite3 connection, so without
// this, statements from concurrent requests (API handlers, the scheduler,
// session-store writes, token bookkeeping) could interleave inside an open
// transaction. Reads stay outside the lock.
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const next = writeChain.then(() => fn(), () => fn());
  writeChain = next.catch(() => {});
  return next;
}

function lockedRun(sql, params = []) {
  return withWriteLock(() => run(sql, params));
}

// Transaction context: while inside transaction(), run() statements execute
// directly on the holder's open transaction instead of reacquiring the
// mutex (which is non-reentrant and would deadlock). Helpers called from
// inside a transaction must use run()/get()/all() normally — never
// withWriteLock or transaction() again.
const txContext = new AsyncLocalStorage();

// Every database write routes through the mutex automatically, unless the
// caller is inside transaction() (see above). Callers never need to think
// about locking; they must only never nest transaction()/withWriteLock.
function run(sql, params = []) {
  const store = txContext.getStore();
  if (store && store.inTransaction) return runRaw(sql, params);
  return withWriteLock(() => runRaw(sql, params));
}

async function transaction(fn) {
  return withWriteLock(() => txContext.run({ inTransaction: true }, async () => {
    await run('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      await run('COMMIT');
      return result;
    } catch (err) {
      await run('ROLLBACK').catch(() => {});
      throw err;
    }
  }));
}

async function init() {
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA foreign_keys = ON');
  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');
  await run(`CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'blue',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  const listColumns = await all('PRAGMA table_info(lists)');
  if (!listColumns.some((column) => column.name === 'is_system')) {
    await run('ALTER TABLE lists ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0');
  }
  // Pinned Unlisted list: always first, cannot be renamed/deleted/reordered.
  let systemList = await get('SELECT id, is_system, sort_order FROM lists WHERE is_system = 1 LIMIT 1');
  if (!systemList) {
    const existingUnlisted = await get('SELECT id FROM lists WHERE LOWER(name) = ? LIMIT 1', ['unlisted']);
    if (existingUnlisted) {
      await run('UPDATE lists SET is_system = 1, sort_order = 0 WHERE id = ?', [existingUnlisted.id]);
      systemList = { id: existingUnlisted.id };
    } else {
      const created = await run(
        'INSERT INTO lists (name, color, sort_order, is_system, created_at) VALUES (?, ?, ?, 1, ?)',
        ['Unlisted', 'gray', 0, new Date().toISOString()]
      );
      systemList = { id: created.lastID };
    }
    await run('UPDATE lists SET sort_order = sort_order + 1 WHERE id != ?', [systemList.id]);
  } else if (systemList.sort_order !== 0) {
    await run('UPDATE lists SET sort_order = sort_order + 1 WHERE id != ?', [systemList.id]);
    await run('UPDATE lists SET sort_order = 0 WHERE id = ?', [systemList.id]);
  }
  await run(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    has_time INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    notified_at TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const reminderColumns = await all('PRAGMA table_info(reminders)');
  // Additive-only migrations: every existing reminder keeps its data and
  // behavior. New columns carry safe defaults (repeat = none, fixed instant).
  const addReminderColumn = async (name, ddl) => {
    if (!reminderColumns.some((column) => column.name === name)) {
      await run(`ALTER TABLE reminders ADD COLUMN ${ddl}`);
      reminderColumns.push({ name });
    }
  };
  await addReminderColumn('urgent', 'urgent INTEGER NOT NULL DEFAULT 0');
  await addReminderColumn('repeat_rule', "repeat_rule TEXT NOT NULL DEFAULT 'none'");
  await addReminderColumn('time_model', "time_model TEXT NOT NULL DEFAULT 'fixed'");
  await addReminderColumn('time_zone', 'time_zone TEXT');
  await addReminderColumn('snoozed_until', 'snoozed_until TEXT');
  await addReminderColumn('last_push_at', 'last_push_at TEXT');
  await addReminderColumn('push_count', 'push_count INTEGER NOT NULL DEFAULT 0');
  // Monotonic concurrency/sync primitive: every content or state mutation
  // bumps this in the same statement that applies the mutation. Scheduler
  // notification bookkeeping never touches it.
  await addReminderColumn('revision', 'revision INTEGER NOT NULL DEFAULT 0');
  // Per-occurrence history for recurring reminders. One row per
  // (reminder, scheduled occurrence): 'completed' | 'skipped' | 'exception'
  // (an occurrence-only edit waiting to fire). UNIQUE keeps history honest.
  await run(`CREATE TABLE IF NOT EXISTS reminder_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    occurrence_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    title TEXT,
    notes TEXT,
    list_id INTEGER,
    urgent INTEGER,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(reminder_id, occurrence_at)
  )`);
  // The occurrences table gained override columns after its first version.
  const occurrenceColumns = await all('PRAGMA table_info(reminder_occurrences)');
  if (!occurrenceColumns.some((column) => column.name === 'list_id')) {
    await run('ALTER TABLE reminder_occurrences ADD COLUMN list_id INTEGER');
  }
  if (!occurrenceColumns.some((column) => column.name === 'urgent')) {
    await run('ALTER TABLE reminder_occurrences ADD COLUMN urgent INTEGER');
  }
  await run('CREATE INDEX IF NOT EXISTS idx_occurrences_reminder ON reminder_occurrences(reminder_id, occurrence_at)');
  // Personal access tokens for external agents. Only the SHA-256 hash is
  // stored; the raw token is shown once at creation and never logged.
  // `profile` gates capability: 'read' (default for new tokens), 'write'
  // (opt-in), 'legacy' (one-time migration landing state for tokens that
  // predate profiles — never selectable, never a downgrade target).
  await run(`CREATE TABLE IF NOT EXISTS personal_access_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`);
  const tokenColumns = await all('PRAGMA table_info(personal_access_tokens)');
  if (!tokenColumns.some((column) => column.name === 'profile')) {
    await run(`ALTER TABLE personal_access_tokens ADD COLUMN profile TEXT NOT NULL DEFAULT 'read' CHECK (profile IN ('read','write','legacy'))`);
    // Existing tokens keep exactly the capabilities they have today.
    await run(`UPDATE personal_access_tokens SET profile = 'legacy'`);
  }
  // Client-supplied idempotency keys for duplicate-safe reminder creation.
  await run(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  )`);
  // Stored-response idempotency ledger for write-profile token mutations.
  // Namespaced per token AND per concrete route, keyed on the raw request
  // payload — never shared across principals. Deliberately NO foreign key:
  // the claim must survive reminder deletion so a replay reports the
  // recorded outcome (with deleted:true) instead of recreating the row.
  await run(`CREATE TABLE IF NOT EXISTS token_idempotency_keys (
    token_id INTEGER NOT NULL,
    route TEXT NOT NULL,
    key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    response_json TEXT,
    status INTEGER,
    reminder_id INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (token_id, route, key)
  )`);
  await run(`UPDATE lists SET color = CASE color
    WHEN '#FF3B30' THEN 'red'
    WHEN '#FF9500' THEN 'orange'
    WHEN '#FFCC00' THEN 'yellow'
    WHEN '#34C759' THEN 'green'
    WHEN '#00C7BE' THEN 'teal'
    WHEN '#30B0C7' THEN 'blue'
    WHEN '#007AFF' THEN 'blue'
    WHEN '#5856D6' THEN 'indigo'
    WHEN '#5E5CE6' THEN 'indigo'
    WHEN '#AF52DE' THEN 'purple'
    WHEN '#BF5AF2' THEN 'purple'
    WHEN '#FF2D55' THEN 'pink'
    WHEN '#5AC8FA' THEN 'cyan'
    WHEN '#64D2FF' THEN 'cyan'
    WHEN '#A2845E' THEN 'brown'
    WHEN '#8E8E93' THEN 'gray'
    ELSE 'blue' END
    WHERE color LIKE '#%'`);
  await run('CREATE INDEX IF NOT EXISTS idx_reminders_list ON reminders(list_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(completed, due_at)');
  await run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

module.exports = { db, run, get, all, init, getSetting, setSetting, withWriteLock, transaction };
