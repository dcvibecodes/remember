'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const db = require('./db');
const push = require('./push');
const SQLiteSessionStore = require('./session-store');
const recurrence = require('./recurrence');
const chrono = require('chrono-node');

const PORT = Number(process.env.PORT) || 3006;
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = require('./package.json').version;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_SECRET_KEY = 'session_secret';
const DEFAULT_LIST_COLOR = 'blue';
const LIST_COLORS = new Set(['red', 'rose', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown', 'slate', 'gray']);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  },
});

function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function validColor(value) {
  return LIST_COLORS.has(value) ? value : DEFAULT_LIST_COLOR;
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function regenerate(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

/* ---------------- Settings ---------------- */

const SETTING_DEFAULTS = {
  default_time: '09:00',
  // Floating is the everyday default: a reminder at 6pm stays at 6pm when
  // the device travels. Existing reminders keep their stored model.
  default_time_model: 'floating',
  default_time_zone: '',
  device_zone: '',
  device_zone_updated_at: '',
  repush_enabled: '0',
  repush_cadence_min: '60',
  repush_max: '3',
  quiet_start: '23:00',
  quiet_end: '07:00',
};

const TIME_MODELS = ['fixed', 'floating', 'anchored'];

function isHHMM(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

async function getSettings() {
  const rows = await db.all('SELECT key, value FROM settings');
  const out = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    if (row.key in out) out[row.key] = row.value;
  }
  return out;
}

// Only these keys may be written through the settings endpoint. Anything
// else (VAPID keys, session secret) stays server-managed.
function validateSetting(key, value) {
  switch (key) {
    case 'default_time':
    case 'quiet_start':
    case 'quiet_end':
      if (!isHHMM(value)) return 'Must look like 09:00';
      return null;
    case 'default_time_model':
      if (!TIME_MODELS.includes(value)) return 'Must be fixed, floating, or anchored';
      return null;
    case 'default_time_zone':
      if (value !== '' && !recurrence.isValidTimeZone(value)) return 'Unknown timezone';
      return null;
    case 'device_zone':
      if (value !== '' && !recurrence.isValidTimeZone(value)) {
        return 'Unknown timezone';
      }
      return null;
    case 'device_zone_updated_at':
      return null;
    case 'repush_enabled':
      if (value !== '0' && value !== '1') return 'Must be 0 or 1';
      return null;
    case 'repush_cadence_min': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 15 || n > 480) return 'Must be 15 to 480 minutes';
      return null;
    }
    case 'repush_max': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 10) return 'Must be 1 to 10';
      return null;
    }
    default:
      return 'Unknown setting';
  }
}

function effectiveZoneFor(reminder, settings) {
  // Which zone drives this reminder's schedule math. Fixed instants use UTC
  // calendar math (zone null). Floating follows the last-synced device zone;
  // anchored follows the reminder's home zone.
  if (reminder.time_model === 'anchored' && recurrence.isValidTimeZone(reminder.time_zone)) {
    return reminder.time_zone;
  }
  if (reminder.time_model === 'floating') {
    if (recurrence.isValidTimeZone(settings.device_zone)) return settings.device_zone;
    if (recurrence.isValidTimeZone(reminder.time_zone)) return reminder.time_zone;
  }
  return null;
}

/* ---------------- Personal access tokens ---------------- */

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function tokenAuth(req, res, next) {
  const raw = bearerToken(req);
  if (!raw) return next();
  try {
    const row = await db.get(
      'SELECT id, name FROM personal_access_tokens WHERE token_hash = ? AND revoked_at IS NULL',
      [hashToken(raw)]
    );
    if (!row) return res.status(401).json({ error: 'Invalid or revoked token' });
    req.token = row;
    req.tokenHash = hashToken(raw);
    db.run('UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?',
      [new Date().toISOString(), row.id]).catch(() => {});
    return next();
  } catch (err) {
    return next(err);
  }
}

function denyToken(res) {
  return res.status(403).json({ error: 'This token is not allowed to use this endpoint' });
}

// Push-action signatures: the scheduler signs (reminder, occurrence, action)
// with the server secret so the service worker can Complete/Snooze without a
// session or CSRF token. Stale occurrences are rejected by matching due_at.
let actionSecretCache = null;
async function getActionSecret() {
  if (!actionSecretCache) {
    actionSecretCache = await db.getSetting(SESSION_SECRET_KEY);
  }
  return actionSecretCache;
}

async function signPushAction(reminderId, occurrenceAt, action) {
  const secret = await getActionSecret();
  return crypto.createHmac('sha256', secret)
    .update(`${reminderId}:${occurrenceAt}:${action}`)
    .digest('hex');
}

async function verifyPushAction(reminderId, occurrenceAt, action, sig) {
  if (typeof sig !== 'string' || !sig) return false;
  const expected = await signPushAction(reminderId, occurrenceAt, action);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- Shared reminder logic ---------------- */
// Every write path (browser UI, token API, push actions) funnels through these
// helpers so behavior is identical no matter where the request came from.

async function loadReminder(id) {
  return db.get('SELECT * FROM reminders WHERE id = ?', [id]);
}

function parseRuleColumn(value) {
  try {
    return recurrence.parseRepeatRule(value);
  } catch (err) {
    err.status = 400;
    throw err;
  }
}

async function completeReminder(id) {
  const reminder = await loadReminder(id);
  if (!reminder) {
    const err = new Error('Reminder not found');
    err.status = 404;
    throw err;
  }
  const now = new Date().toISOString();
  const rule = parseRuleColumn(reminder.repeat_rule);
  if (!recurrence.isRecurringRule(rule)) {
    if (reminder.completed) return { advanced: false, reminder };
    await db.run(
      'UPDATE reminders SET completed = 1, completed_at = ?, snoozed_until = NULL, updated_at = ? WHERE id = ?',
      [now, now, id]
    );
    return { advanced: false };
  }
  // Recurring: completing records this occurrence and advances the series.
  // The series itself is never marked completed.
  if (!reminder.due_at) {
    const err = new Error('Repeating reminders need a date');
    err.status = 400;
    throw err;
  }
  const settings = await getSettings();
  const zone = effectiveZoneFor(reminder, settings);
  const next = recurrence.firstFutureOccurrence(rule, reminder.due_at, zone, now);
  const exception = await db.get(
    `SELECT title, notes, list_id, urgent FROM reminder_occurrences
     WHERE reminder_id = ? AND occurrence_at = ? AND status = 'exception'`,
    [id, reminder.due_at]
  );
  await db.run(`
    INSERT INTO reminder_occurrences
      (reminder_id, occurrence_at, status, title, notes, list_id, urgent, completed_at, created_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(reminder_id, occurrence_at) DO UPDATE SET
      status = 'completed', title = excluded.title, notes = excluded.notes,
      list_id = excluded.list_id, urgent = excluded.urgent, completed_at = excluded.completed_at
  `, [
    id, reminder.due_at,
    exception ? exception.title : reminder.title,
    exception ? exception.notes : reminder.notes,
    exception && exception.list_id !== null && exception.list_id !== undefined ? exception.list_id : reminder.list_id,
    exception && exception.urgent !== null && exception.urgent !== undefined ? exception.urgent : reminder.urgent,
    now, now,
  ]);
  await db.run(
    `UPDATE reminders SET due_at = ?, notified_at = NULL, last_push_at = NULL,
       push_count = 0, snoozed_until = NULL, updated_at = ? WHERE id = ?`,
    [next, now, id]
  );
  return { advanced: true, nextDue: next };
}

async function skipOccurrence(id) {
  const reminder = await loadReminder(id);
  if (!reminder) {
    const err = new Error('Reminder not found');
    err.status = 404;
    throw err;
  }
  const rule = parseRuleColumn(reminder.repeat_rule);
  if (!recurrence.isRecurringRule(rule) || !reminder.due_at) {
    const err = new Error('Only dated repeating reminders can skip an occurrence');
    err.status = 400;
    throw err;
  }
  const settings = await getSettings();
  const zone = effectiveZoneFor(reminder, settings);
  const now = new Date().toISOString();
  const next = recurrence.firstFutureOccurrence(rule, reminder.due_at, zone, now);
  await db.run(`
    INSERT INTO reminder_occurrences (reminder_id, occurrence_at, status, created_at)
    VALUES (?, ?, 'skipped', ?)
    ON CONFLICT(reminder_id, occurrence_at) DO UPDATE SET status = 'skipped', completed_at = NULL
  `, [id, reminder.due_at, now]);
  await db.run(
    `UPDATE reminders SET due_at = ?, notified_at = NULL, last_push_at = NULL,
       push_count = 0, snoozed_until = NULL, updated_at = ? WHERE id = ?`,
    [next, now, id]
  );
  return { nextDue: next };
}

async function snoozeReminder(id, untilISO) {
  const reminder = await loadReminder(id);
  if (!reminder) {
    const err = new Error('Reminder not found');
    err.status = 404;
    throw err;
  }
  const until = new Date(untilISO);
  if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
    const err = new Error('Snooze time must be in the future');
    err.status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  await db.run('UPDATE reminders SET snoozed_until = ?, updated_at = ? WHERE id = ?',
    [until.toISOString(), now, id]);
  return { snoozedUntil: until.toISOString() };
}

async function clearSnooze(id) {
  const reminder = await loadReminder(id);
  if (!reminder) {
    const err = new Error('Reminder not found');
    err.status = 404;
    throw err;
  }
  await db.run('UPDATE reminders SET snoozed_until = NULL, updated_at = ? WHERE id = ?',
    [new Date().toISOString(), id]);
  return { ok: true };
}

// One-tap reschedule for overdue items. Non-recurring items move their due
// date (keeping the clock time when one is set). Recurring series move the
// current occurrence AND re-anchor monthly/yearly rules to the new date, since
// an explicit move means "this is the new rhythm".
async function rescheduleReminder(id, target) {
  const reminder = await loadReminder(id);
  if (!reminder) {
    const err = new Error('Reminder not found');
    err.status = 404;
    throw err;
  }
  const settings = await getSettings();
  const zone = settings.device_zone && recurrence.isValidTimeZone(settings.device_zone)
    ? settings.device_zone
    : null;
  let dateStr = target;
  if (target === 'today' || target === 'tomorrow') {
    const base = zone
      ? recurrence.instantToWall(Date.now(), zone)
      : (() => { const d = new Date(); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }; })();
    let dd = base.d + (target === 'tomorrow' ? 1 : 0);
    const dim = new Date(Date.UTC(base.y, base.mo, 0)).getUTCDate();
    let mm = base.mo;
    let yy = base.y;
    if (dd > dim) { dd = 1; mm += 1; if (mm > 12) { mm = 1; yy += 1; } }
    dateStr = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) {
    const err = new Error('Reschedule target must be today, tomorrow, or YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  const rule = parseRuleColumn(reminder.repeat_rule);
  const effZone = effectiveZoneFor(reminder, settings);
  let dueAt;
  let hasTime = reminder.has_time ? 1 : 0;
  if (reminder.has_time && reminder.due_at) {
    // Keep the original clock time in the series' own zone.
    const w = effZone
      ? recurrence.instantToWall(new Date(reminder.due_at).getTime(), effZone)
      : (() => { const d = new Date(reminder.due_at); return { h: d.getUTCHours(), mi: d.getUTCMinutes() }; })();
    dueAt = effZone
      ? recurrence.wallToInstant(effZone, { y: yy, mo: mm, d: dd, h: w.h, mi: w.mi })
      : new Date(Date.UTC(yy, mm - 1, dd, w.h, w.mi)).toISOString();
  } else {
    const [hh, mi] = (settings.default_time || '09:00').split(':').map(Number);
    dueAt = effZone
      ? recurrence.wallToInstant(effZone, { y: yy, mo: mm, d: dd, h: hh, mi })
      : new Date(Date.UTC(yy, mm - 1, dd, hh, mi)).toISOString();
  }
  const now = new Date().toISOString();
  const fields = ['due_at = ?', 'has_time = ?', 'notified_at = NULL',
    'last_push_at = NULL', 'push_count = 0', 'snoozed_until = NULL', 'updated_at = ?'];
  const params = [dueAt, hasTime, now, id];
  if (recurrence.isRecurringRule(rule) && (rule.type === 'monthly' || rule.type === 'yearly' || (rule.type === 'custom' && rule.unit === 'months'))) {
    const anchored = recurrence.anchorRule({ ...rule, anchorDay: undefined, anchorMonth: undefined }, dueAt, effZone);
    fields.push('repeat_rule = ?');
    params.splice(params.length - 1, 0, recurrence.encodeRepeatRule(anchored));
  }
  await db.run(`UPDATE reminders SET ${fields.join(', ')} WHERE id = ?`, params);
  return { dueAt };
}

async function resolveList(ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const row = await db.get('SELECT id, name FROM lists WHERE id = ?', [Number(ref)]);
    return row || null;
  }
  const name = String(ref).trim();
  if (!name) return null;
  const rows = await db.all('SELECT id, name FROM lists WHERE LOWER(name) = LOWER(?)', [name]);
  if (rows.length > 1) {
    const err = new Error(`Multiple lists match "${name}" — use the list id instead`);
    err.status = 400;
    throw err;
  }
  return rows[0] || null;
}

async function main() {
  await db.init();
  await push.init();

  let secret = await db.getSetting(SESSION_SECRET_KEY);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await db.setSetting(SESSION_SECRET_KEY, secret);
  }

  app.use(session({
    name: 'remember.sid',
    secret,
    store: new SQLiteSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));

  app.use((req, res, next) => {
    if (req.session) req.session.cookie.secure = req.secure;
    if (req.session && !req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    next();
  });

  app.use(express.static(PUBLIC_DIR, {
    maxAge: '1d',
    setHeaders(res, filePath) {
      if (/(?:sw\.js|index\.html|manifest\.webmanifest|app\.js|styles\.css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  app.get('/api/session', async (req, res) => {
    const user = await db.get('SELECT id FROM users LIMIT 1');
    const authenticated = Boolean(req.session.userId);
    res.json({
      needsSetup: !user,
      authenticated,
      csrfToken: authenticated ? req.session.csrfToken : null,
      vapidPublicKey: authenticated ? push.getPublicKey() : null,
      version: VERSION,
    });
  });

  app.post('/api/setup', authLimiter, async (req, res) => {
    const existing = await db.get('SELECT id FROM users LIMIT 1');
    if (existing) return res.status(409).json({ error: 'This app is already set up' });

    const password = String(req.body.password || '');
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const hash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    await db.run('INSERT INTO users (password_hash, created_at) VALUES (?, ?)', [hash, now]);
    const remindersList = await db.get('SELECT id FROM lists WHERE LOWER(name) = ? LIMIT 1', ['reminders']);
    if (!remindersList) {
      const max = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS s FROM lists');
      await db.run(
        'INSERT INTO lists (name, color, sort_order, created_at) VALUES (?, ?, ?, ?)',
        ['Reminders', DEFAULT_LIST_COLOR, max.s + 1, now]
      );
    }

    await regenerate(req);
    req.session.userId = 1;
    await saveSession(req);
    res.json({ ok: true });
  });

  app.post('/api/login', authLimiter, async (req, res) => {
    const password = String(req.body.password || '');
    const user = await db.get('SELECT id, password_hash FROM users LIMIT 1');
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    await regenerate(req);
    req.session.userId = user.id;
    await saveSession(req);
    res.json({ ok: true });
  });

  // Signed push actions (Complete / Snooze 1h) from notification buttons.
  // The service worker has no session or CSRF token, so each action carries
  // an HMAC bound to (reminder, scheduled occurrence, action). Stale
  // notifications whose series already advanced are rejected.
  app.post('/api/push/action', async (req, res) => {
    const id = parseId(req.body.reminder_id);
    const action = String(req.body.action || '');
    const occurrence = typeof req.body.occurrence_at === 'string' ? req.body.occurrence_at : '';
    if (!id || (action !== 'complete' && action !== 'snooze')) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    const reminder = await loadReminder(id);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
    if (!occurrence || reminder.due_at !== occurrence) {
      return res.status(409).json({ error: 'That notification is for an old occurrence' });
    }
    if (!(await verifyPushAction(id, occurrence, action, req.body.sig))) {
      return res.status(403).json({ error: 'Bad action signature' });
    }
    try {
      if (action === 'complete') {
        const result = await completeReminder(id);
        return res.json({ ok: true, advanced: result.advanced || false, nextDue: result.nextDue || null });
      }
      const result = await snoozeReminder(id, new Date(Date.now() + 3600 * 1000).toISOString());
      return res.json({ ok: true, snoozedUntil: result.snoozedUntil });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
  });


  const tokenLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 300,
    keyGenerator: (req) => req.tokenHash || ipKeyGenerator(req.ip),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ error: 'Token rate limit reached. Slow down and try again later.' });
    },
  });

  app.use('/api', tokenAuth, (req, res, next) => {
    if (req.token) return tokenLimiter(req, res, next);
    next();
  });

  app.use('/api', (req, res, next) => {
    if (req.token || req.session.userId) return next();
    return res.status(401).json({ error: 'Not signed in' });
  });

  // Token scope enforcement: personal access tokens may only read lists,
  // reminders, and state, create reminders, and complete them. Everything
  // else (deletes, lists, password, push, settings, tokens, import/export,
  // actions) is session-only. (req.path is mount-relative here.)
  app.use('/api', (req, res, next) => {
    if (!req.token) return next();
    if (req.method === 'GET' && ['/lists', '/reminders', '/state'].includes(req.path)) return next();
    if (req.method === 'POST' && req.path === '/reminders') return next();
    if (req.method === 'PATCH' && req.path.startsWith('/reminders/')) return next();
    return denyToken(res);
  });

  app.use('/api', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    // Personal access tokens authenticate with the secret itself, so they are
    // exempt from CSRF the same way a session without one would be impossible.
    if (req.token) return next();
    const token = req.get('x-csrf-token');
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).json({ error: 'Invalid CSRF token. Please refresh and try again.' });
    }
    next();
  });

  app.post('/api/password', authLimiter, async (req, res) => {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    const confirm = String(req.body.confirm_password || '');
    if (next.length < 8 || next.length > 200) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    if (next !== confirm) {
      return res.status(400).json({ error: 'New passwords do not match' });
    }
    const user = await db.get('SELECT id, password_hash FROM users LIMIT 1');
    if (!user || !(await bcrypt.compare(current, user.password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(next, 12);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
    res.json({ ok: true });
  });

  app.get('/api/settings', async (req, res) => {
    if (req.token) return denyToken(res);
    res.json(await getSettings());
  });

  app.post('/api/settings', async (req, res) => {
    if (req.token) return denyToken(res);
    const incoming = req.body.settings;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'Send { settings: { key: value } }' });
    }
    const before = await getSettings();
    const updates = {};
    for (const [key, value] of Object.entries(incoming)) {
      const problem = validateSetting(key, value);
      if (problem) return res.status(400).json({ error: `${key}: ${problem}` });
      updates[key] = String(value);
    }
    for (const [key, value] of Object.entries(updates)) {
      await db.setSetting(key, value);
    }
    // When the device reports a new zone, floating reminders ("6pm wherever I
    // am") move with it: keep their wall-clock time, resolve it in the new
    // zone, and remember the zone the instant was computed in. Only future
    // occurrences move; past-due items stay overdue. (The PWA cannot detect
    // travel while closed, so this runs on app open/resume instead.)
    let moved = 0;
    if (updates.device_zone && updates.device_zone !== before.device_zone) {
      const fromZone = before.device_zone && recurrence.isValidTimeZone(before.device_zone)
        ? before.device_zone
        : null;
      const toZone = updates.device_zone;
      const floating = await db.all(
        "SELECT id, due_at, time_zone FROM reminders WHERE time_model = 'floating' AND completed = 0 AND due_at IS NOT NULL"
      );
      const nowMs = Date.now();
      for (const reminder of floating) {
        const oldZone = recurrence.isValidTimeZone(reminder.time_zone) ? reminder.time_zone : fromZone;
        if (!oldZone || new Date(reminder.due_at).getTime() <= nowMs) continue;
        try {
          const movedDue = recurrence.recomputeInZone(reminder.due_at, oldZone, toZone);
          await db.run('UPDATE reminders SET due_at = ?, time_zone = ?, updated_at = ? WHERE id = ?',
            [movedDue, toZone, new Date().toISOString(), reminder.id]);
          moved += 1;
        } catch {
          // Leave the reminder on its stored instant if the zone math fails.
        }
      }
      await db.setSetting('device_zone_updated_at', new Date().toISOString());
    }
    res.json({ ok: true, settings: await getSettings(), floatingMoved: moved });
  });

  app.get('/api/tokens', async (req, res) => {
    if (req.token) return denyToken(res);
    const rows = await db.all(
      'SELECT id, name, created_at, last_used_at, revoked_at FROM personal_access_tokens ORDER BY id'
    );
    res.json({ tokens: rows });
  });

  app.post('/api/tokens', async (req, res) => {
    if (req.token) return denyToken(res);
    const name = text(req.body.name, 80) || 'agent';
    // 48 random bytes, base64url: unguessable, URL-safe. Only the SHA-256
    // hash is stored — the raw value below is shown exactly once.
    const raw = crypto.randomBytes(48).toString('base64url');
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO personal_access_tokens (name, token_hash, created_at) VALUES (?, ?, ?)',
      [name, hashToken(raw), now]
    );
    res.status(201).json({ id: result.lastID, name, token: raw, created_at: now });
  });

  app.post('/api/tokens/:id/revoke', async (req, res) => {
    if (req.token) return denyToken(res);
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid token' });
    const result = await db.run(
      'UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      [new Date().toISOString(), id]
    );
    if (!result.changes) return res.status(404).json({ error: 'Token not found' });
    res.json({ ok: true });
  });

  // JSON backup in Settings. Secrets (password hash, VAPID keys, session
  // secret, API tokens) are never exported.
  app.get('/api/export', async (req, res) => {
    if (req.token) return denyToken(res);
    const settings = await getSettings();
    const lists = await db.all('SELECT id, name, color, sort_order, created_at FROM lists ORDER BY sort_order, id');
    const reminders = await db.all(`SELECT id, list_id, title, notes, due_at, has_time, completed,
      completed_at, urgent, repeat_rule, time_model, time_zone, snoozed_until,
      sort_order, created_at, updated_at FROM reminders ORDER BY id`);
    const occurrences = await db.all(
      'SELECT reminder_id, occurrence_at, status, title, notes, completed_at, created_at FROM reminder_occurrences ORDER BY id'
    );
    res.json({
      app: 'remember',
      format: 1,
      exported_at: new Date().toISOString(),
      settings: {
        default_time: settings.default_time,
        default_time_model: settings.default_time_model,
        repush_enabled: settings.repush_enabled,
        repush_cadence_min: settings.repush_cadence_min,
        repush_max: settings.repush_max,
        quiet_start: settings.quiet_start,
        quiet_end: settings.quiet_end,
      },
      lists,
      reminders,
      occurrences,
    });
  });

  // Import matches the export format. Merge-only and id-safe: rows whose id
  // already exists are skipped, never overwritten, and every reminder needs
  // an existing list (newly imported ones count). Nothing is ever deleted.
  app.post('/api/import', async (req, res) => {
    if (req.token) return denyToken(res);
    const data = req.body.data;
    if (!data || typeof data !== 'object' || data.app !== 'remember') {
      return res.status(400).json({ error: 'That is not a Remember backup file' });
    }
    const counts = { listsAdded: 0, listsSkipped: 0, remindersAdded: 0, remindersSkipped: 0, occurrencesAdded: 0, occurrencesSkipped: 0 };
    const knownLists = new Set((await db.all('SELECT id FROM lists')).map((r) => r.id));
    for (const list of Array.isArray(data.lists) ? data.lists : []) {
      if (!list || !Number.isInteger(list.id) || !String(list.name || '').trim()) {
        counts.listsSkipped += 1;
        continue;
      }
      if (knownLists.has(list.id)) { counts.listsSkipped += 1; continue; }
      try {
        await db.run(
          'INSERT INTO lists (id, name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
          [list.id, String(list.name).slice(0, 120), validColor(list.color),
            Number.isInteger(list.sort_order) ? list.sort_order : 0,
            typeof list.created_at === 'string' ? list.created_at : new Date().toISOString()]
        );
        knownLists.add(list.id);
        counts.listsAdded += 1;
      } catch { counts.listsSkipped += 1; }
    }
    const knownReminders = new Set((await db.all('SELECT id FROM reminders')).map((r) => r.id));
    for (const reminder of Array.isArray(data.reminders) ? data.reminders : []) {
      if (!reminder || !Number.isInteger(reminder.id) || !String(reminder.title || '').trim()
        || !knownLists.has(reminder.list_id)) {
        counts.remindersSkipped += 1;
        continue;
      }
      if (knownReminders.has(reminder.id)) { counts.remindersSkipped += 1; continue; }
      let rule = 'none';
      try { rule = recurrence.encodeRepeatRule(recurrence.parseRepeatRule(reminder.repeat_rule ?? 'none')); }
      catch { counts.remindersSkipped += 1; continue; }
      const model = TIME_MODELS.includes(reminder.time_model) ? reminder.time_model : 'fixed';
      const zone = typeof reminder.time_zone === 'string' && recurrence.isValidTimeZone(reminder.time_zone)
        ? reminder.time_zone : null;
      try {
        await db.run(`
          INSERT INTO reminders
            (id, list_id, title, notes, due_at, has_time, completed, completed_at, urgent,
             repeat_rule, time_model, time_zone, snoozed_until, notified_at, last_push_at, push_count,
             sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `, [
          reminder.id, reminder.list_id, String(reminder.title).slice(0, 500),
          String(reminder.notes || '').slice(0, 5000),
          typeof reminder.due_at === 'string' ? reminder.due_at : null,
          reminder.has_time ? 1 : 0, reminder.completed ? 1 : 0,
          typeof reminder.completed_at === 'string' ? reminder.completed_at : null,
          reminder.urgent ? 1 : 0, rule, model, zone,
          typeof reminder.snoozed_until === 'string' ? reminder.snoozed_until : null,
          typeof reminder.notified_at === 'string' ? reminder.notified_at : null,
          null, 0,
          Number.isInteger(reminder.sort_order) ? reminder.sort_order : 0,
          typeof reminder.created_at === 'string' ? reminder.created_at : new Date().toISOString(),
          typeof reminder.updated_at === 'string' ? reminder.updated_at : new Date().toISOString(),
        ]);
        knownReminders.add(reminder.id);
        counts.remindersAdded += 1;
      } catch { counts.remindersSkipped += 1; }
    }
    for (const occurrence of Array.isArray(data.occurrences) ? data.occurrences : []) {
      if (!occurrence || !knownReminders.has(occurrence.reminder_id)
        || typeof occurrence.occurrence_at !== 'string'
        || !['completed', 'skipped', 'exception'].includes(occurrence.status)) {
        counts.occurrencesSkipped += 1;
        continue;
      }
      try {
        await db.run(`
          INSERT INTO reminder_occurrences
            (reminder_id, occurrence_at, status, title, notes, completed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(reminder_id, occurrence_at) DO NOTHING
        `, [
          occurrence.reminder_id, occurrence.occurrence_at, occurrence.status,
          typeof occurrence.title === 'string' ? occurrence.title.slice(0, 500) : null,
          typeof occurrence.notes === 'string' ? occurrence.notes.slice(0, 5000) : null,
          typeof occurrence.completed_at === 'string' ? occurrence.completed_at : null,
          typeof occurrence.created_at === 'string' ? occurrence.created_at : new Date().toISOString(),
        ]);
        counts.occurrencesAdded += 1;
      } catch { counts.occurrencesSkipped += 1; }
    }
    res.json({ ok: true, ...counts });
  });

  // Per-occurrence history for one recurring reminder (newest first).
  app.get('/api/reminders/:id/occurrences', async (req, res) => {
    if (req.token) return denyToken(res);
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reminder' });
    const rows = await db.all(
      `SELECT occurrence_at, status, title, notes, completed_at, created_at
       FROM reminder_occurrences WHERE reminder_id = ? ORDER BY occurrence_at DESC LIMIT 25`,
      [id]
    );
    res.json({ occurrences: rows });
  });

  app.post('/api/reminders/:id/skip', async (req, res) => {
    if (req.token) return denyToken(res);
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reminder' });
    try {
      const result = await skipOccurrence(id);
      res.json({ ok: true, nextDue: result.nextDue });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
  });

  app.post('/api/reminders/:id/snooze', async (req, res) => {
    if (req.token) return denyToken(res);
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reminder' });
    try {
      if (req.body.clear) {
        await clearSnooze(id);
        return res.json({ ok: true, snoozedUntil: null });
      }
      const hours = req.body.hours === undefined ? 1 : Number(req.body.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 72) {
        return res.status(400).json({ error: 'Snooze hours must be between 0 and 72' });
      }
      const result = await snoozeReminder(id, new Date(Date.now() + hours * 3600 * 1000).toISOString());
      res.json({ ok: true, snoozedUntil: result.snoozedUntil });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
  });

  app.post('/api/reminders/:id/reschedule', async (req, res) => {
    if (req.token) return denyToken(res);
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reminder' });
    const reminder = await loadReminder(id);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
    if (!reminder.due_at) return res.status(400).json({ error: 'Only dated reminders can be rescheduled' });
    try {
      const result = await rescheduleReminder(id, req.body.date);
      res.json({ ok: true, dueAt: result.dueAt });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
  });

  // Natural-language quick add: "call mom tomorrow 6pm" -> title + date +
  // time (+ repeat rule). The editor calls this as you type and pre-checks
  // the Date/Time/Repeat controls so you see exactly what will be saved.
  app.post('/api/parse', async (req, res) => {
    if (req.token) return denyToken(res);
    const input = text(req.body.text, 500);
    if (!input) return res.status(400).json({ error: 'Nothing to parse' });
    const settings = await getSettings();
    let zone = typeof req.body.timeZone === 'string' ? req.body.timeZone : '';
    if (!recurrence.isValidTimeZone(zone)) {
      zone = recurrence.isValidTimeZone(settings.device_zone) ? settings.device_zone : 'UTC';
    }
    const { rule, cleaned } = recurrence.detectRepeat(input);
    // chrono skips bare ordinals ("on the 31st"), so pull those out first and
    // parse the remainder for anything else.
    const monthday = recurrence.detectMonthDay(cleaned);
    const chronoText = monthday ? monthday.cleaned : cleaned;
    // chrono reads the process timezone, so pin it to the device zone for the
    // synchronous parse call only, then restore it. No await in between, so
    // concurrent requests cannot observe the switch.
    const previousTZ = process.env.TZ;
    let results = [];
    try {
      if (zone) process.env.TZ = zone;
      results = chrono.parse(chronoText, new Date(), { forwardDate: true });
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    }
    if (!results.length) {
      if (monthday) {
        return res.json({
          title: monthday.cleaned || input,
          date: recurrence.upcomingMonthDay(monthday.day, zone, Date.now()),
          time: null,
          hasTime: false,
          repeat: recurrence.isRecurringRule(rule) ? rule : 'none',
          summary: '',
        });
      }
      // No date found, but a repeat rule may still have been detected
      // ("water plants every 3 days"): return it so the editor pre-checks
      // Repeat; the date validation on save asks for the missing date.
      return res.json({
        title: cleaned || input,
        date: null,
        time: null,
        hasTime: false,
        repeat: recurrence.isRecurringRule(rule) ? rule : 'none',
        summary: '',
      });
    }
    const start = results[0].start;
    const ms = start.date().getTime();
    const wall = recurrence.instantToWall(ms, zone);
    const date = `${wall.y}-${String(wall.mo).padStart(2, '0')}-${String(wall.d).padStart(2, '0')}`;
    const hasTime = start.isCertain('hour');
    const time = hasTime
      ? `${String(wall.h).padStart(2, '0')}:${String(wall.mi).padStart(2, '0')}`
      : null;
    let title = chronoText.replace(results[0].text, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
      .trim() || input;
    res.json({
      title,
      date,
      time,
      hasTime,
      repeat: recurrence.isRecurringRule(rule) ? rule : 'none',
      summary: '',
    });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('remember.sid');
      res.json({ ok: true });
    });
  });

  const REMINDER_COLUMNS = `id, list_id, title, notes, due_at, has_time, completed,
    completed_at, urgent, repeat_rule, time_model, time_zone, snoozed_until,
    last_push_at, push_count, sort_order, created_at`;

  app.get('/api/state', async (req, res) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const lists = await db.all(`
      SELECT l.id, l.name, l.color, l.sort_order, l.created_at, l.is_system,
        (SELECT COUNT(*) FROM reminders r WHERE r.list_id = l.id AND r.completed = 0) AS count
      FROM lists l ORDER BY l.sort_order, l.id
    `);
    const reminders = await db.all(`
      SELECT ${REMINDER_COLUMNS} FROM reminders
      WHERE completed = 0 OR completed_at IS NULL OR completed_at >= ?
      ORDER BY sort_order, id
    `, [cutoff]);
    // Merge pending occurrence-only edits: an 'exception' row for the current
    // scheduled occurrence overrides the series values for display.
    if (reminders.length) {
      const ids = reminders.filter((r) => r.due_at && r.repeat_rule !== 'none').map((r) => r.id);
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        const exceptions = await db.all(
          `SELECT reminder_id, occurrence_at, title, notes, list_id, urgent
           FROM reminder_occurrences WHERE status = 'exception' AND reminder_id IN (${placeholders})`,
          ids
        );
        const byKey = new Map(exceptions.map((e) => [`${e.reminder_id}|${e.occurrence_at}`, e]));
        for (const reminder of reminders) {
          const exception = byKey.get(`${reminder.id}|${reminder.due_at}`);
          if (!exception) continue;
          if (exception.title !== null && exception.title !== undefined) reminder.title = exception.title;
          if (exception.notes !== null && exception.notes !== undefined) reminder.notes = exception.notes;
          if (exception.list_id) reminder.list_id = exception.list_id;
          if (exception.urgent !== null && exception.urgent !== undefined) reminder.urgent = exception.urgent;
          reminder.occurrence_edited = true;
        }
      }
    }
    res.json({ lists, reminders, settings: await getSettings(), now: new Date().toISOString() });
  });

  // Agent + UI reads. Tokens may use these; full rows for UI convenience.
  app.get('/api/lists', async (req, res) => {
    const lists = await db.all(`
      SELECT l.id, l.name, l.color, l.sort_order, l.created_at, l.is_system,
        (SELECT COUNT(*) FROM reminders r WHERE r.list_id = l.id AND r.completed = 0) AS count
      FROM lists l ORDER BY l.sort_order, l.id
    `);
    res.json({ lists });
  });

  app.get('/api/reminders', async (req, res) => {
    const conditions = [];
    const params = [];
    if (req.query.list_id !== undefined) {
      const listId = parseId(req.query.list_id);
      if (!listId) return res.status(400).json({ error: 'Invalid list_id' });
      conditions.push('list_id = ?');
      params.push(listId);
    }
    if (req.query.completed !== undefined) {
      if (req.query.completed !== '0' && req.query.completed !== '1') {
        return res.status(400).json({ error: 'completed must be 0 or 1' });
      }
      conditions.push('completed = ?');
      params.push(Number(req.query.completed));
    }
    if (req.query.q !== undefined && String(req.query.q).trim() !== '') {
      conditions.push('(title LIKE ? OR notes LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    let limit = 100;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return res.status(400).json({ error: 'limit must be 1 to 500' });
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const reminders = await db.all(
      `SELECT ${REMINDER_COLUMNS} FROM reminders ${where} ORDER BY sort_order, id LIMIT ?`,
      [...params, limit]
    );
    res.json({ reminders });
  });

  app.post('/api/lists', async (req, res) => {
    const name = text(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const max = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS s FROM lists');
    const result = await db.run(
      'INSERT INTO lists (name, color, sort_order, created_at) VALUES (?, ?, ?, ?)',
      [name, validColor(req.body.color), max.s + 1, new Date().toISOString()]
    );
    res.status(201).json({ id: result.lastID });
  });

  app.put('/api/lists/order', async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((value) => Number(value)) : [];
    if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Invalid list order' });
    }
    const existing = await db.all('SELECT id, is_system FROM lists');
    const existingIds = new Set(existing.map((row) => row.id));
    if (ids.length !== existingIds.size || ids.some((id) => !existingIds.has(id))) {
      return res.status(400).json({ error: 'List order is out of date' });
    }
    const systemList = existing.find((row) => row.is_system);
    if (systemList && ids[0] !== systemList.id) {
      return res.status(400).json({ error: 'Unlisted must stay first' });
    }
    const cases = ids.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ');
    try {
      await db.run(`UPDATE lists SET sort_order = CASE id ${cases} END WHERE id IN (${ids.join(', ')})`);
      res.json({ ok: true });
    } catch (err) {
      console.error('List reorder failed:', err.message);
      res.status(500).json({ error: 'Could not save list order' });
    }
  });

  app.patch('/api/lists/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid list' });
    const list = await db.get('SELECT id, name, is_system FROM lists WHERE id = ?', [id]);
    if (!list) return res.status(404).json({ error: 'List not found' });

    const fields = [];
    const params = [];
    if (req.body.name !== undefined) {
      const name = text(req.body.name, 120);
      if (!name) return res.status(400).json({ error: 'List name is required' });
      if (list.is_system && name !== list.name) {
        return res.status(400).json({ error: 'Unlisted cannot be renamed' });
      }
      fields.push('name = ?');
      params.push(name);
    }
    if (req.body.color !== undefined) {
      fields.push('color = ?');
      params.push(validColor(req.body.color));
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    await db.run(`UPDATE lists SET ${fields.join(', ')} WHERE id = ?`, params);
    res.json({ ok: true });
  });

  app.delete('/api/lists/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid list' });
    const list = await db.get('SELECT id, is_system FROM lists WHERE id = ?', [id]);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.is_system) return res.status(400).json({ error: 'Unlisted cannot be deleted' });
    await db.run('DELETE FROM lists WHERE id = ?', [id]);
    res.json({ ok: true });
  });

  app.post('/api/reminders', async (req, res) => {
    const title = text(req.body.title, 500);
    if (!title) return res.status(400).json({ error: 'Title is required' });
    // Lists can be referenced by id or by name (agents pass names).
    const listRef = req.body.list_id !== undefined ? req.body.list_id : req.body.list;
    const hasListRef = listRef !== undefined && listRef !== null && listRef !== '';
    let list = null;
    try {
      list = await resolveList(listRef);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
    if (!list && !hasListRef) {
      list = await db.get('SELECT id, name FROM lists WHERE is_system = 1 LIMIT 1');
    }
    if (!list) return res.status(400).json({ error: 'Choose a list' });
    const listId = list.id;

    if (req.token && req.body.completed) return denyToken(res);

    const dueAtRaw = normalizeDate(req.body.due_at);
    if (dueAtRaw === undefined) return res.status(400).json({ error: 'Invalid date' });
    const hasTime = dueAtRaw && req.body.has_time ? 1 : 0;
    const urgent = req.body.urgent ? 1 : 0;
    const completed = !req.token && req.body.completed ? 1 : 0;

    let rule;
    try {
      rule = recurrence.parseRepeatRule(req.body.repeat_rule ?? req.body.repeat ?? 'none');
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
    if (recurrence.isRecurringRule(rule) && !dueAtRaw) {
      return res.status(400).json({ error: 'Repeating reminders need a date' });
    }

    const timeModel = req.body.time_model === undefined ? 'fixed' : String(req.body.time_model);
    if (!TIME_MODELS.includes(timeModel)) {
      return res.status(400).json({ error: 'time_model must be fixed, floating, or anchored' });
    }
    let timeZone = req.body.time_zone === undefined || req.body.time_zone === null
      ? null
      : String(req.body.time_zone);
    if (timeZone === '') timeZone = null;
    if (timeZone && !recurrence.isValidTimeZone(timeZone)) {
      return res.status(400).json({ error: 'Unknown time_zone' });
    }
    if (timeModel === 'anchored' && !timeZone) {
      return res.status(400).json({ error: 'Zone-anchored reminders need a time_zone' });
    }
    if (timeModel === 'floating' && !timeZone) {
      // Start from the creating device's zone when the client reports one.
      const deviceZone = typeof req.body.device_zone === 'string' ? req.body.device_zone : '';
      if (recurrence.isValidTimeZone(deviceZone)) timeZone = deviceZone;
    }

    const settings = await getSettings();
    let dueAt = dueAtRaw;
    if (dueAt && recurrence.isRecurringRule(rule)) {
      const anchored = recurrence.anchorRule(rule, dueAt, effectiveZoneFor({ time_model: timeModel, time_zone: timeZone }, settings));
      rule = anchored;
      // A series that already started in the past begins at its first FUTURE
      // occurrence instead of firing immediately with no history.
      if (new Date(dueAt).getTime() <= Date.now()) {
        dueAt = recurrence.firstFutureOccurrence(rule, dueAt,
          effectiveZoneFor({ time_model: timeModel, time_zone: timeZone }, settings), new Date().toISOString());
      }
    }

    // Duplicate-safe creation: a retried request carrying the same
    // idempotency key returns the original reminder instead of a copy.
    const idempotencyKey = req.get('Idempotency-Key') || req.body.idempotency_key;
    if (idempotencyKey) {
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) {
        return res.status(400).json({ error: 'Invalid idempotency key' });
      }
      const seen = await db.get('SELECT reminder_id FROM idempotency_keys WHERE key = ?', [idempotencyKey]);
      if (seen) {
        const existing = await loadReminder(seen.reminder_id);
        if (existing) return res.json({ id: existing.id, deduplicated: true });
      }
    }

    const now = new Date().toISOString();
    const completedAt = completed ? now : null;
    const notifiedAt = !completed && dueAt && !hasTime && new Date(dueAt) <= new Date() ? now : null;
    const max = await db.get(
      'SELECT COALESCE(MAX(sort_order), -1) AS s FROM reminders WHERE list_id = ?',
      [listId]
    );

    const result = await db.run(`
      INSERT INTO reminders
        (list_id, title, notes, due_at, has_time, completed, completed_at, urgent,
         repeat_rule, time_model, time_zone, notified_at, last_push_at, push_count,
         sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)
    `, [listId, title, text(req.body.notes, 5000), dueAt, hasTime, completed, completedAt,
      urgent, recurrence.encodeRepeatRule(rule), timeModel, timeZone, notifiedAt,
      max.s + 1, now, now]);

    if (idempotencyKey) {
      await db.run('INSERT OR IGNORE INTO idempotency_keys (key, reminder_id, created_at) VALUES (?, ?, ?)',
        [idempotencyKey, result.lastID, now]);
      const winner = await db.get('SELECT reminder_id FROM idempotency_keys WHERE key = ?', [idempotencyKey]);
      if (winner && winner.reminder_id !== result.lastID) {
        // Lost a race with an identical retry: drop our duplicate.
        await db.run('DELETE FROM reminders WHERE id = ?', [result.lastID]);
        return res.json({ id: winner.reminder_id, deduplicated: true });
      }
    }

    res.status(201).json({ id: result.lastID });
  });

  app.patch('/api/reminders/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reminder' });
    const current = await loadReminder(id);
    if (!current) return res.status(404).json({ error: 'Reminder not found' });

    // Token scope: agents may only complete reminders through this endpoint.
    if (req.token) {
      const keys = Object.keys(req.body);
      if (req.body.completed !== true || keys.some((key) => key !== 'completed')) {
        return denyToken(res);
      }
    }

    // Completing flows through the shared helper so the browser, the token
    // API, and push actions all advance recurring series identically.
    if (req.body.completed === true && !current.completed) {
      try {
        const result = await completeReminder(id);
        return res.json({ ok: true, advanced: result.advanced || false, nextDue: result.nextDue || null });
      } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || 'Server error' });
      }
    }

    const scope = req.body.scope === undefined ? 'series' : String(req.body.scope);
    if (scope !== 'series' && scope !== 'occurrence') {
      return res.status(400).json({ error: 'scope must be series or occurrence' });
    }
    if (req.token && scope !== 'series') return denyToken(res);
    const currentRule = parseRuleColumn(current.repeat_rule);
    const recurring = recurrence.isRecurringRule(currentRule);

    if (scope === 'occurrence') {
      // "This occurrence only": store an exception for the current scheduled
      // occurrence. The series itself is untouched and keeps its rhythm.
      // Date changes always apply to the whole series (see hint in the UI).
      if (!recurring || !current.due_at) {
        return res.status(400).json({ error: 'Only dated repeating reminders have occurrences to edit' });
      }
      const allowed = ['title', 'notes', 'list_id', 'urgent'];
      const provided = Object.keys(req.body).filter((key) => key !== 'scope');
      if (provided.some((key) => !allowed.includes(key))) {
        return res.status(400).json({ error: 'Date changes apply to the whole series — edit those with scope "series"' });
      }
      if (!provided.length) return res.status(400).json({ error: 'Nothing to update' });
      const overrides = { title: null, notes: null, list_id: null, urgent: null };
      if (req.body.title !== undefined) {
        const title = text(req.body.title, 500);
        if (!title) return res.status(400).json({ error: 'Title is required' });
        overrides.title = title;
      }
      if (req.body.notes !== undefined) overrides.notes = text(req.body.notes, 5000);
      if (req.body.list_id !== undefined) {
        const listId = parseId(req.body.list_id);
        const list = listId ? await db.get('SELECT id FROM lists WHERE id = ?', [listId]) : null;
        if (!list) return res.status(400).json({ error: 'Choose a valid list' });
        overrides.list_id = listId;
      }
      if (req.body.urgent !== undefined) overrides.urgent = req.body.urgent ? 1 : 0;
      const now = new Date().toISOString();
      await db.run(`
        INSERT INTO reminder_occurrences (reminder_id, occurrence_at, status, title, notes, list_id, urgent, created_at)
        VALUES (?, ?, 'exception', ?, ?, ?, ?, ?)
        ON CONFLICT(reminder_id, occurrence_at) DO UPDATE SET
          status = 'exception', title = excluded.title, notes = excluded.notes,
          list_id = excluded.list_id, urgent = excluded.urgent
      `, [id, current.due_at, overrides.title, overrides.notes, overrides.list_id, overrides.urgent, now]);
      return res.json({ ok: true, occurrenceEdited: true });
    }

    const fields = [];
    const params = [];
    let dueChanged = false;

    if (req.body.title !== undefined) {
      const title = text(req.body.title, 500);
      if (!title) return res.status(400).json({ error: 'Title is required' });
      fields.push('title = ?');
      params.push(title);
    }

    if (req.body.notes !== undefined) {
      fields.push('notes = ?');
      params.push(text(req.body.notes, 5000));
    }

    if (req.body.list_id !== undefined) {
      const listId = parseId(req.body.list_id);
      const list = listId ? await db.get('SELECT id FROM lists WHERE id = ?', [listId]) : null;
      if (!list) return res.status(400).json({ error: 'Choose a valid list' });
      fields.push('list_id = ?');
      params.push(listId);
    }

    if (req.body.due_at !== undefined) {
      const dueAt = normalizeDate(req.body.due_at);
      if (dueAt === undefined) return res.status(400).json({ error: 'Invalid date' });
      const hasTime = dueAt && req.body.has_time ? 1 : 0;
      fields.push('due_at = ?');
      params.push(dueAt);
      fields.push('has_time = ?');
      params.push(hasTime);
      // Re-arm the reminder so the new date can notify again.
      fields.push('notified_at = NULL');
      fields.push('last_push_at = NULL');
      fields.push('push_count = 0');
      fields.push('snoozed_until = NULL');
      dueChanged = true;
    }

    if (req.body.urgent !== undefined) {
      fields.push('urgent = ?');
      params.push(req.body.urgent ? 1 : 0);
    }

    if (req.body.repeat_rule !== undefined || req.body.repeat !== undefined) {
      let rule;
      try {
        rule = recurrence.parseRepeatRule(req.body.repeat_rule ?? req.body.repeat ?? 'none');
      } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || 'Server error' });
      }
      const settings = await getSettings();
      const zone = effectiveZoneFor({
        time_model: req.body.time_model !== undefined ? req.body.time_model : current.time_model,
        time_zone: req.body.time_zone !== undefined ? req.body.time_zone : current.time_zone,
      }, settings);
      const dueForAnchor = req.body.due_at !== undefined
        ? normalizeDate(req.body.due_at)
        : current.due_at;
      if (recurrence.isRecurringRule(rule)) {
        if (!dueForAnchor) return res.status(400).json({ error: 'Repeating reminders need a date' });
        rule = recurrence.anchorRule(rule, dueForAnchor, zone);
      }
      fields.push('repeat_rule = ?');
      params.push(recurrence.encodeRepeatRule(rule));
    }

    if (req.body.time_model !== undefined) {
      const model = String(req.body.time_model);
      if (!TIME_MODELS.includes(model)) return res.status(400).json({ error: 'time_model must be fixed, floating, or anchored' });
      const zone = req.body.time_zone !== undefined ? req.body.time_zone : current.time_zone;
      if (model === 'anchored' && !(typeof zone === 'string' && recurrence.isValidTimeZone(zone))) {
        return res.status(400).json({ error: 'Zone-anchored reminders need a valid time_zone' });
      }
      fields.push('time_model = ?');
      params.push(model);
    }

    if (req.body.time_zone !== undefined) {
      const zone = req.body.time_zone === null || req.body.time_zone === '' ? null : String(req.body.time_zone);
      if (zone && !recurrence.isValidTimeZone(zone)) {
        return res.status(400).json({ error: 'Unknown time_zone' });
      }
      fields.push('time_zone = ?');
      params.push(zone);
    }

    if (req.body.completed !== undefined) {
      const completed = req.body.completed ? 1 : 0;
      if (recurring && !completed) {
        return res.status(400).json({ error: 'Recurring reminders stay open — use Skip for an occurrence' });
      }
      fields.push('completed = ?');
      params.push(completed);
      if (completed && !current.completed) {
        fields.push('completed_at = ?');
        params.push(new Date().toISOString());
      } else if (!completed) {
        fields.push('completed_at = NULL');
      }
    }

    if (req.body.snoozed_until !== undefined) {
      if (req.body.snoozed_until === null || req.body.snoozed_until === '') {
        fields.push('snoozed_until = NULL');
      } else {
        const until = new Date(req.body.snoozed_until);
        if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
          return res.status(400).json({ error: 'Snooze time must be in the future' });
        }
        fields.push('snoozed_until = ?');
        params.push(until.toISOString());
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    await db.run(`UPDATE reminders SET ${fields.join(', ')} WHERE id = ?`, params);
    res.json({ ok: true, dueChanged });
  });

  app.delete('/api/reminders/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reminder' });
    const result = await db.run('DELETE FROM reminders WHERE id = ?', [id]);
    if (!result.changes) return res.status(404).json({ error: 'Reminder not found' });
    res.json({ ok: true });
  });

  app.post('/api/push/subscribe', async (req, res) => {
    const sub = req.body.subscription || {};
    if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const now = new Date().toISOString();
    await db.run(`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
    `, [sub.endpoint, sub.keys.p256dh, sub.keys.auth, now]);
    // Items due within the last day stay un-notified so they still fire now
    // that a device exists; older backlog is stamped to avoid a flood.
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await db.run(
      `UPDATE reminders SET notified_at = ? WHERE completed = 0 AND notified_at IS NULL
       AND due_at IS NOT NULL AND due_at <= ? AND due_at < ?`,
      [now, now, dayAgo]
    );
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', async (req, res) => {
    const endpoint = text(req.body.endpoint, 2000);
    if (!endpoint) return res.status(400).json({ error: 'Endpoint is required' });
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    res.json({ ok: true });
  });

  app.post('/api/push/test', async (req, res) => {
    const result = await push.sendToAll({
      title: 'Remember',
      body: 'Notifications are working.',
      url: '/#/today',
      tag: 'remember-test',
    });
    res.json(result);
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

  app.listen(PORT, HOST, () => {
    console.log(`Remember ${VERSION} listening on http://${HOST}:${PORT}`);
  });

  function inQuietHours(nowMs, zone, start, end) {
    // Quiet hours are wall-clock hours in the device zone (or UTC without
    // one). Ranges may wrap midnight, e.g. 23:00-07:00.
    let h;
    let mi;
    if (zone && recurrence.isValidTimeZone(zone)) {
      const w = recurrence.instantToWall(nowMs, zone);
      h = w.h;
      mi = w.mi;
    } else {
      const d = new Date(nowMs);
      h = d.getUTCHours();
      mi = d.getUTCMinutes();
    }
    const toMin = (s) => {
      const [hh, mm] = s.split(':').map(Number);
      return hh * 60 + mm;
    };
    const cur = h * 60 + mi;
    const from = toMin(start);
    const to = toMin(end);
    if (from === to) return false;
    return from < to ? cur >= from && cur < to : cur >= from || cur < to;
  }

  // Reminders more than this overdue never fire on their own: with no
  // subscriptions we leave them un-stamped instead of burying them, and this
  // cap keeps a later subscribe from replaying ancient history.
  const BACKLOG_CAP_DAYS = 7;

  let checkingDue = false;
  async function checkDueReminders() {
    if (checkingDue) return;
    checkingDue = true;
    try {
      const settings = await getSettings();
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const floor = new Date(nowMs - BACKLOG_CAP_DAYS * 24 * 3600 * 1000).toISOString();
      const due = await db.all(`
        SELECT r.id, r.title, r.notes, r.list_id, r.due_at, r.notified_at,
               r.last_push_at, r.push_count, l.name AS list_name
        FROM reminders r JOIN lists l ON l.id = r.list_id
        WHERE r.completed = 0 AND r.due_at IS NOT NULL AND r.due_at <= ?
          AND r.due_at >= ? AND (r.snoozed_until IS NULL OR r.snoozed_until <= ?)
        ORDER BY r.due_at LIMIT 50
      `, [now, floor, now]);
      if (!due.length) return;

      const subscriptions = await db.get('SELECT COUNT(*) AS n FROM push_subscriptions');
      if (!subscriptions.n) {
        // No device to push to: do NOT stamp notified_at, so enabling
        // notifications later still delivers recently-due items.
        return;
      }
      const repushOn = settings.repush_enabled === '1';
      const cadenceMs = Number(settings.repush_cadence_min) * 60 * 1000;
      const repushMax = Number(settings.repush_max);
      const quiet = inQuietHours(nowMs,
        recurrence.isValidTimeZone(settings.device_zone) ? settings.device_zone : null,
        settings.quiet_start, settings.quiet_end);

      for (const reminder of due) {
        const firstFire = !reminder.notified_at;
        let repush = false;
        if (!firstFire && repushOn && (reminder.push_count || 0) < repushMax && !quiet) {
          const last = reminder.last_push_at ? new Date(reminder.last_push_at).getTime() : 0;
          repush = nowMs - last >= cadenceMs;
        }
        if (!firstFire && !repush) continue;
        if (firstFire && quiet) {
          // First fire during quiet hours still notifies once (missing a
          // deadline is worse than a buzz); only re-pushes stay silent.
        }
        await push.sendToAll({
          title: reminder.title,
          body: reminder.notes || reminder.list_name,
          url: '/#/list/' + reminder.list_id,
          tag: 'reminder-' + reminder.id,
          reminderId: reminder.id,
          occurrence: reminder.due_at,
          sigComplete: await signPushAction(reminder.id, reminder.due_at, 'complete'),
          sigSnooze: await signPushAction(reminder.id, reminder.due_at, 'snooze'),
        });
        await db.run(
          `UPDATE reminders SET notified_at = COALESCE(notified_at, ?),
             last_push_at = ?, push_count = COALESCE(push_count, 0) + 1 WHERE id = ?`,
          [now, now, reminder.id]
        );
      }
    } catch (err) {
      console.error('Due check failed:', err.message);
    } finally {
      checkingDue = false;
    }
  }

  checkDueReminders();
  setInterval(checkDueReminders, 15 * 1000);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
