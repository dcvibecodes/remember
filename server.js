'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const push = require('./push');
const SQLiteSessionStore = require('./session-store');

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
    const listCount = await db.get('SELECT COUNT(*) AS n FROM lists');
    if (!listCount.n) {
      await db.run(
        'INSERT INTO lists (name, color, sort_order, created_at) VALUES (?, ?, ?, ?)',
        ['Reminders', DEFAULT_LIST_COLOR, 0, now]
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

  app.use('/api', (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
    next();
  });

  app.use('/api', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
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

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('remember.sid');
      res.json({ ok: true });
    });
  });

  app.get('/api/state', async (req, res) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const lists = await db.all(`
      SELECT l.id, l.name, l.color, l.sort_order, l.created_at,
        (SELECT COUNT(*) FROM reminders r WHERE r.list_id = l.id AND r.completed = 0) AS count
      FROM lists l ORDER BY l.sort_order, l.id
    `);
    const reminders = await db.all(`
      SELECT id, list_id, title, notes, due_at, has_time, completed, completed_at, urgent, sort_order, created_at
      FROM reminders
      WHERE completed = 0 OR completed_at IS NULL OR completed_at >= ?
      ORDER BY sort_order, id
    `, [cutoff]);
    res.json({ lists, reminders, now: new Date().toISOString() });
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
    const existing = await db.all('SELECT id FROM lists');
    const existingIds = new Set(existing.map((row) => row.id));
    if (ids.length !== existingIds.size || ids.some((id) => !existingIds.has(id))) {
      return res.status(400).json({ error: 'List order is out of date' });
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
    const list = await db.get('SELECT id FROM lists WHERE id = ?', [id]);
    if (!list) return res.status(404).json({ error: 'List not found' });

    const fields = [];
    const params = [];
    if (req.body.name !== undefined) {
      const name = text(req.body.name, 120);
      if (!name) return res.status(400).json({ error: 'List name is required' });
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
    const result = await db.run('DELETE FROM lists WHERE id = ?', [id]);
    if (!result.changes) return res.status(404).json({ error: 'List not found' });
    res.json({ ok: true });
  });

  app.post('/api/reminders', async (req, res) => {
    const title = text(req.body.title, 500);
    const listId = parseId(req.body.list_id);
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const list = listId ? await db.get('SELECT id FROM lists WHERE id = ?', [listId]) : null;
    if (!list) return res.status(400).json({ error: 'Choose a list' });

    const dueAt = normalizeDate(req.body.due_at);
    if (dueAt === undefined) return res.status(400).json({ error: 'Invalid date' });
    const hasTime = dueAt && req.body.has_time ? 1 : 0;
    const urgent = req.body.urgent ? 1 : 0;
    const completed = req.body.completed ? 1 : 0;
    const now = new Date().toISOString();
    const completedAt = completed ? now : null;
    const notifiedAt = !completed && dueAt && !hasTime && new Date(dueAt) <= new Date() ? now : null;
    const max = await db.get(
      'SELECT COALESCE(MAX(sort_order), -1) AS s FROM reminders WHERE list_id = ?',
      [listId]
    );

    const result = await db.run(`
      INSERT INTO reminders
        (list_id, title, notes, due_at, has_time, completed, completed_at, urgent, notified_at, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [listId, title, text(req.body.notes, 5000), dueAt, hasTime, completed, completedAt, urgent, notifiedAt, max.s + 1, now, now]);

    res.status(201).json({ id: result.lastID });
  });

  app.patch('/api/reminders/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reminder' });
    const current = await db.get('SELECT * FROM reminders WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ error: 'Reminder not found' });

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
      fields.push('notified_at = ?');
      params.push(dueAt && !hasTime && new Date(dueAt) <= new Date() ? new Date().toISOString() : null);
      dueChanged = true;
    }

    if (req.body.urgent !== undefined) {
      fields.push('urgent = ?');
      params.push(req.body.urgent ? 1 : 0);
    }

    if (req.body.completed !== undefined) {
      const completed = req.body.completed ? 1 : 0;
      fields.push('completed = ?');
      params.push(completed);
      if (completed && !current.completed) {
        fields.push('completed_at = ?');
        params.push(new Date().toISOString());
      } else if (!completed) {
        fields.push('completed_at = NULL');
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
    await db.run(
      'UPDATE reminders SET notified_at = ? WHERE completed = 0 AND notified_at IS NULL AND due_at IS NOT NULL AND due_at <= ?',
      [now, now]
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

  let checkingDue = false;
  async function checkDueReminders() {
    if (checkingDue) return;
    checkingDue = true;
    try {
      const now = new Date().toISOString();
      const due = await db.all(`
        SELECT r.id, r.title, r.notes, r.list_id, l.name AS list_name
        FROM reminders r JOIN lists l ON l.id = r.list_id
        WHERE r.completed = 0 AND r.notified_at IS NULL
          AND r.due_at IS NOT NULL AND r.due_at <= ?
        ORDER BY r.due_at LIMIT 50
      `, [now]);
      if (!due.length) return;

      const subscriptions = await db.get('SELECT COUNT(*) AS n FROM push_subscriptions');
      for (const reminder of due) {
        if (subscriptions.n) {
          await push.sendToAll({
            title: reminder.title,
            body: reminder.notes || reminder.list_name,
            url: '/#/list/' + reminder.list_id,
            tag: 'reminder-' + reminder.id,
          });
        }
        await db.run('UPDATE reminders SET notified_at = ? WHERE id = ?', [now, reminder.id]);
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
