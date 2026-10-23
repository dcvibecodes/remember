'use strict';

const webpush = require('web-push');
const { all, run, getSetting, setSetting } = require('./db');

let publicKey = null;
let ready = false;

async function init() {
  let pub = await getSetting('vapid_public');
  let priv = await getSetting('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    await setSetting('vapid_public', pub);
    await setSetting('vapid_private', priv);
  }
  webpush.setVapidDetails(
    'mailto:' + (process.env.CONTACT_EMAIL || 'noreply@example.com'),
    pub,
    priv
  );
  publicKey = pub;
  ready = true;
  return pub;
}

function getPublicKey() {
  return publicKey;
}

async function sendToAll(payload) {
  if (!ready) return { sent: 0, failed: 0 };
  const subs = await all('SELECT id, endpoint, p256dh, auth FROM push_subscriptions');
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let sent = 0;
  let failed = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 60 * 60 * 24, urgency: 'high' }
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      if (err.statusCode === 404 || err.statusCode === 410) {
        await run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
      } else {
        console.error('Push failed:', err.statusCode || '', err.message);
      }
    }
  }
  return { sent, failed };
}

module.exports = { init, getPublicKey, sendToAll };
