'use strict';

// WhatsApp alerts through a linked phone (QR code), for:
//   - posting every new lead to the dispatch group, in the same format as Copy for WhatsApp;
//   - sending each person their alerts on WhatsApp, if they added a number and turned it on.
// Messages go out one at a time from a paced queue (gentle on the linked number), wait
// while the link is down, and never block the app: the in-app and phone notifications
// always go out regardless.

const path = require('node:path');
const QRCode = require('qrcode');

const GAP_MS = 1500; // between messages
const HOURLY_CAP = 200;
const QUEUE_MAX = 300;
const BACKOFF = [2000, 5000, 15000, 30000, 60000];

const digitsOf = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 10 ? `1${d}` : d; // US numbers without the country code
};

function mount(app, db, { requireUser, requireRole, wrap, awrap, HttpError, getSettings, logAudit, notifyAdmins, rateLimit, createTransport, dataDir }) {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const st = { status: 'off', qr: null, me: null, error: '', since: null, alerted: false };
  let transport = null;
  let starting = false;
  let retries = 0;
  let retryTimer = null;
  const queue = [];
  const sentTimes = [];
  const jidCache = new Map();
  let pumping = false;

  const authDir = path.join(dataDir, 'whatsapp-auth');
  const cfg = () => {
    const s = getSettings();
    return {
      enabled: s.wa_enabled === '1',
      groupId: s.wa_group_id || '',
      groupName: s.wa_group_name || '',
      newLeadGroup: s.wa_new_lead_group !== '0',
    };
  };
  const setStatus = (status, extra = {}) => { Object.assign(st, { status, since: Date.now() }, extra); };

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const wait = BACKOFF[Math.min(retries, BACKOFF.length - 1)];
    retries++;
    setStatus('reconnecting');
    retryTimer = setTimeout(() => { start(); }, wait);
    if (retryTimer.unref) retryTimer.unref();
    // Tell admins once if it stays down for a while.
    if (retries === 8 && !st.alerted) {
      st.alerted = true;
      notifyAdmins('⚠️ WhatsApp alerts can\'t connect right now. Leads still alert in the app. Check Admin → Settings → WhatsApp alerts.');
    }
  }

  async function start() {
    if (starting || !cfg().enabled) return;
    starting = true;
    try {
      if (transport) transport.stop();
      transport = createTransport({
        authDir,
        onQr: async (raw) => {
          try { st.qr = await QRCode.toDataURL(raw, { margin: 1, width: 280 }); } catch { st.qr = null; }
          setStatus('qr');
        },
        onOpen: (me) => {
          retries = 0;
          st.alerted = false;
          setStatus('connected', { qr: null, error: '', me: { number: String(me.id || '').split(/[:@]/)[0], name: me.name || '' } });
          pump();
        },
        onClose: (why) => {
          st.error = why.message || '';
          if (why.loggedOut) {
            setStatus('logged_out', { qr: null, me: null });
            transport.logout().catch(() => {});
            notifyAdmins('⚠️ WhatsApp alerts were disconnected from the phone. Scan the QR code again in Admin → Settings → WhatsApp alerts.');
          } else if (why.replaced) {
            setStatus('replaced', { qr: null });
          } else if (why.restart) {
            setImmediate(start);
          } else if (cfg().enabled) {
            scheduleRetry();
          }
        },
      });
      setStatus('starting', { qr: null });
      await transport.start();
      // If WhatsApp never answers, don't sit on "Connecting…" forever.
      const startedAt = st.since;
      const watchdog = setTimeout(() => {
        if (st.status === 'starting' && st.since === startedAt) { transport.stop(); st.error = 'No answer from WhatsApp'; scheduleRetry(); }
      }, 60000);
      if (watchdog.unref) watchdog.unref();
    } catch (e) {
      st.error = e.message;
      scheduleRetry();
    } finally {
      starting = false;
    }
  }

  // ---------- the paced queue ----------

  function enqueue(item) {
    if (!cfg().enabled) return false;
    queue.push({ ...item, tries: 0 });
    while (queue.length > QUEUE_MAX) queue.shift();
    pump();
    return true;
  }

  async function resolveJid(item) {
    if (item.jid) return item.jid;
    const hit = jidCache.get(item.digits);
    if (hit && Date.now() - hit.at < 86400000) return hit.jid;
    const jid = await transport.exists(item.digits);
    jidCache.set(item.digits, { jid, at: Date.now() });
    return jid;
  }

  async function pump() {
    if (pumping || st.status !== 'connected' || !queue.length) return;
    const now = Date.now();
    while (sentTimes.length && now - sentTimes[0] > 3600000) sentTimes.shift();
    if (sentTimes.length >= HOURLY_CAP) { setTimeout(pump, 60000).unref?.(); return; }
    pumping = true;
    const item = queue.shift();
    try {
      const jid = await resolveJid(item);
      if (jid) {
        await transport.sendText(jid, item.text);
        sentTimes.push(Date.now());
      }
    } catch (e) {
      if (++item.tries < 3) queue.push(item);
      st.error = e.message;
    } finally {
      pumping = false;
      if (queue.length) { const t = setTimeout(pump, GAP_MS); if (t.unref) t.unref(); }
    }
  }

  // ---------- what the rest of the app calls ----------

  const api = {
    start,
    stop: () => { clearTimeout(retryTimer); if (transport) transport.stop(); },
    status: () => st.status,
    // A person's alerts, if they added a WhatsApp number and switched it on.
    sendToUser(user, text) {
      const d = digitsOf(user.whatsapp);
      if (!user.whatsapp_alerts || d.length < 11) return false;
      return enqueue({ digits: d, text });
    },
    // The new-lead post to the dispatch group.
    postToGroup(text) {
      const c = cfg();
      if (!c.groupId || !c.newLeadGroup) return false;
      return enqueue({ jid: c.groupId, text });
    },
    queueLength: () => queue.length,
    // For tests: run the queue now.
    async drain() { for (let i = 0; i < 1000 && queue.length && st.status === 'connected'; i++) await pump(); },
  };

  // ---------- admin routes ----------

  const statusView = () => {
    const c = cfg();
    return {
      enabled: c.enabled, status: st.status, qr: st.status === 'qr' ? st.qr : null, me: st.me, error: st.error,
      group: c.groupId ? { id: c.groupId, name: c.groupName } : null, new_lead_group: c.newLeadGroup, queued: queue.length,
      people: db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND whatsapp_alerts = 1 AND whatsapp <> ''").get().n,
    };
  };

  app.get('/api/whatsapp/status', wrap((req) => { requireRole(req, 'admin'); return statusView(); }));

  app.post('/api/whatsapp/connect', wrap((req) => {
    requireRole(req, 'admin');
    set.run('wa_enabled', '1');
    retries = 0;
    if (!['connected', 'starting', 'qr'].includes(st.status)) start();
    logAudit(req, 'whatsapp.connect', 'settings', '', '');
    return statusView();
  }));

  app.post('/api/whatsapp/disconnect', awrap(async (req) => {
    requireRole(req, 'admin');
    set.run('wa_enabled', '0');
    clearTimeout(retryTimer);
    if (transport) await transport.logout().catch(() => {});
    setStatus('off', { qr: null, me: null, error: '' });
    queue.length = 0;
    logAudit(req, 'whatsapp.disconnect', 'settings', '', '');
    return statusView();
  }));

  app.get('/api/whatsapp/groups', awrap(async (req) => {
    requireRole(req, 'admin');
    if (st.status !== 'connected') throw new HttpError(409, 'Connect WhatsApp first.');
    const groups = await transport.listGroups();
    return groups.sort((x, y) => x.name.localeCompare(y.name));
  }));

  app.patch('/api/whatsapp/settings', wrap((req) => {
    requireRole(req, 'admin');
    const b = req.body || {};
    if (b.group_id !== undefined) {
      const id = String(b.group_id || '');
      if (id && !/^[\w.-]+@g\.us$/.test(id)) throw new HttpError(400, 'Pick a group from the list.');
      set.run('wa_group_id', id);
      set.run('wa_group_name', id ? String(b.group_name || '').slice(0, 100) : '');
    }
    if (b.new_lead_group !== undefined) set.run('wa_new_lead_group', b.new_lead_group ? '1' : '0');
    logAudit(req, 'whatsapp.settings', 'settings', '', JSON.stringify(b).slice(0, 300));
    return statusView();
  }));

  app.post('/api/whatsapp/test', wrap((req) => {
    const u = requireRole(req, 'admin');
    const target = (req.body || {}).target;
    if (st.status !== 'connected') throw new HttpError(409, 'WhatsApp isn\'t connected.');
    if (target === 'group') {
      const c = cfg();
      if (!c.groupId) throw new HttpError(400, 'Pick the dispatch group first.');
      enqueue({ jid: c.groupId, text: `✅ E&O Referrals is connected. New leads will be posted here. (Test sent by ${u.full_name})` });
    } else {
      throw new HttpError(400, 'Unknown test.');
    }
    return { ok: true };
  }));

  // Anyone can send themselves a test, once their number is saved.
  const testHits = new Map();
  app.post('/api/whatsapp/test-me', wrap((req) => {
    const u = requireUser(req);
    if (!rateLimit(testHits, `u:${u.id}`, 5, 3600000)) throw new HttpError(429, 'Try again in a little while.');
    if (st.status !== 'connected') throw new HttpError(409, 'WhatsApp alerts aren\'t connected yet. Ask your admin.');
    const row = db.prepare('SELECT whatsapp FROM users WHERE id = ?').get(u.id);
    const d = digitsOf(row.whatsapp);
    if (d.length < 11) throw new HttpError(400, 'Save your WhatsApp number first.');
    enqueue({ digits: d, text: `✅ Hi ${u.full_name.split(' ')[0]}! Your E&O Referrals alerts will come here.` });
    return { ok: true };
  }));

  return api;
}

module.exports = { mount, digitsOf };
