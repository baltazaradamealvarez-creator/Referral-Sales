'use strict';

// Phone and desktop push notifications (Web Push). Each device that turns them on
// stores a subscription; every in-app notification is also pushed to the user's devices.
// VAPID keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or are generated once and
// kept in the settings table.

const webpush = require('web-push');
const mail = require('./email');

function mount(app, db, { requireUser, wrap, HttpError }) {
  const getSetting = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value;
  let keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    keys = { publicKey: getSetting('vapid_public'), privateKey: getSetting('vapid_private') };
    if (!keys.publicKey || !keys.privateKey) {
      keys = webpush.generateVAPIDKeys();
      const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      set.run('vapid_public', keys.publicKey);
      set.run('vapid_private', keys.privateKey);
    }
  }
  const cfg = mail.emailConfig();
  const subject = cfg.appUrl && cfg.appUrl.startsWith('https://') ? cfg.appUrl : `mailto:${cfg.address}`;
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

  // Returns how many devices it reached. Dead subscriptions (404/410) are removed.
  async function sendPush(userId, { title, body, url, tag }) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    let sent = 0;
    const payload = JSON.stringify({ title: title || 'E&O Referrals', body: String(body || '').slice(0, 300), url: url || '/', tag });
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: 'high' });
        db.prepare("UPDATE push_subscriptions SET last_ok_at = datetime('now') WHERE id = ?").run(s.id);
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        else console.error(`Push to user ${userId} failed: ${e.statusCode || ''} ${e.message}`);
      }
    }));
    return sent;
  }

  app.get('/api/push/key', wrap((req) => {
    const u = requireUser(req);
    const devices = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(u.id).n;
    return { key: keys.publicKey, devices };
  }));

  app.post('/api/push/subscribe', wrap((req) => {
    const u = requireUser(req);
    const sub = (req.body || {}).subscription || {};
    const endpoint = String(sub.endpoint || '');
    const k = sub.keys || {};
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !k.p256dh || !k.auth) throw new HttpError(400, 'That device subscription isn’t valid.');
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`)
      .run(u.id, endpoint, String(k.p256dh).slice(0, 200), String(k.auth).slice(0, 100), String(req.get('user-agent') || '').slice(0, 200));
    return { ok: true };
  }));

  app.post('/api/push/unsubscribe', wrap((req) => {
    const u = requireUser(req);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(u.id, String((req.body || {}).endpoint || ''));
    return { ok: true };
  }));

  app.post('/api/push/test', async (req, res, next) => {
    try {
      const u = requireUser(req);
      const sent = await sendPush(u.id, { title: 'E&O Referrals', body: '🔔 Notifications are working on this device.', url: '/#/account' });
      if (!sent) throw new HttpError(400, 'No device got it. Turn notifications on again on this phone.');
      res.json({ sent });
    } catch (e) { next(e); }
  });

  return { sendPush, publicKey: keys.publicKey };
}

module.exports = { mount };
