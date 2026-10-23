'use strict';

const session = require('express-session');
const db = require('./db');

const DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL = 60 * 60 * 1000;

function expiryOf(sess) {
  if (sess && sess.cookie && sess.cookie.expires) {
    const time = new Date(sess.cookie.expires).getTime();
    if (Number.isFinite(time)) return time;
  }
  if (sess && sess.cookie && Number.isFinite(sess.cookie.maxAge)) {
    return Date.now() + sess.cookie.maxAge;
  }
  return Date.now() + DEFAULT_TTL;
}

class SQLiteSessionStore extends session.Store {
  constructor() {
    super();
    this.cleanup = setInterval(() => {
      db.run('DELETE FROM sessions WHERE expires <= ?', [Date.now()]).catch(() => {});
    }, CLEANUP_INTERVAL);
    if (typeof this.cleanup.unref === 'function') this.cleanup.unref();
  }

  get(sid, callback) {
    db.get('SELECT sess, expires FROM sessions WHERE sid = ?', [sid])
      .then((row) => {
        if (!row) return callback(null, null);
        if (row.expires <= Date.now()) {
          db.run('DELETE FROM sessions WHERE sid = ?', [sid]).catch(() => {});
          return callback(null, null);
        }
        try {
          return callback(null, JSON.parse(row.sess));
        } catch {
          db.run('DELETE FROM sessions WHERE sid = ?', [sid]).catch(() => {});
          return callback(null, null);
        }
      })
      .catch(callback);
  }

  set(sid, sess, callback) {
    db.run(
      `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
      [sid, JSON.stringify(sess), expiryOf(sess)]
    ).then(() => callback(null)).catch(callback);
  }

  touch(sid, sess, callback) {
    db.run('UPDATE sessions SET expires = ? WHERE sid = ?', [expiryOf(sess), sid])
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback) {
    db.run('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => callback(null))
      .catch(callback);
  }
}

module.exports = SQLiteSessionStore;
