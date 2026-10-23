'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(DATA_DIR, 'remember.db'));
db.configure('busyTimeout', 5000);

function run(sql, params = []) {
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
  await run(`CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'blue',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
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
  if (!reminderColumns.some((column) => column.name === 'urgent')) {
    await run('ALTER TABLE reminders ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0');
  }
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

module.exports = { db, run, get, all, init, getSetting, setSetting };
