'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const express = require('express');
const { tx, STATUSES, ROLES, SERVICES } = require('./db');
const auth = require('./auth');
const mail = require('./email');
const crypto = require('node:crypto');
const { buildDashboard, WIDGETS } = require('./dashboard');
const { historyMatch } = require('./history');
const { scoreLead } = require('../public/leadscore');
const waFormat = require('../public/waformat');
const notificationPrefs = require('./notification-preferences');
const { normalizeEmail, normalizePhone, formatPhone, formatWhatsapp, addressKey, parseLeadText, parseDob, parseAddressLocation, normalizeState, normalizeZip } = require('./normalize');

const DUPLICATE_MESSAGE = 'This lead is a duplicate and cannot be entered.';
const OPEN_STATUSES = ['New', 'Working', 'Passed'];

const DEFAULT_SETTINGS = {
  auto_assign: '0',
  email_from_name: '',
  email_reply_to: '',
  entry_template: 'Name: \nPhone: \nEmail: \nAddress: \nDate of birth: \nServices: \nNotes: ',
  // The message reps paste into WhatsApp for dispatch. {placeholders} are filled from the lead.
  whatsapp_template: require('../public/waformat').DEFAULT_TEMPLATE,
  whatsapp_number: '',
  // Alert every active dispatcher the moment a new lead comes in.
  new_lead_alert: '1',
  // WhatsApp dispatch group: replies become notes / status changes; what "approved" means;
  // and whether the AI helper (Claude Haiku, needs ANTHROPIC_API_KEY) reads replies.
  wa_two_way: '1',
  wa_approved_status: 'Ordered',
  ai_enabled: '1',
  // The assistant: what it should know about the business (admins edit it), and when it
  // posts the morning briefing / evening recap to the dispatch group ('' = off).
  ai_brief: require('./agent').DEFAULT_BRIEF,
  ai_briefing_time: '09:00',
  ai_recap_time: '19:00',
  affiliate_enabled: '0',
  affiliate_levels: '15,5',
  affiliate_commission: '0',
  affiliate_approval: '1',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// opts.whatsappTransport: replaces the real WhatsApp connection (tests use a fake).
function createApp(db, opts = {}) {
  const app = express();
  let affiliates = null; // set once the affiliate routes are mounted, below
  let speed = null; // speed-to-lead watcher, mounted below
  let push = null; // phone push notifications, mounted below
  let whatsapp = null; // WhatsApp alerts through a linked phone, mounted below
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Spreadsheet uploads (sent as base64 in JSON) get a bigger limit than everything else.
  const smallJson = express.json({ limit: '100kb' });
  const uploadJson = express.json({ limit: '15mb' });
  app.use((req, res, next) => (req.path === '/api/history/import' ? uploadJson : smallJson)(req, res, next));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Used by the host (e.g. Render) to check the app is up.
  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  // ---------- helpers ----------

  const wrap = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      next(e);
    }
  };

  const awrap = (fn) => (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((out) => { if (out !== undefined && !res.headersSent) res.json(out); })
      .catch(next);
  };

  // Mutating requests must be JSON: blocks classic cross-site form posts (CSRF).
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Expected JSON' });
    }
    next();
  });

  app.use('/api', (req, res, next) => {
    req.user = auth.loadUser(db, req);
    // Until a temporary password is changed, only allow changing it (or signing out).
    const allowed = ['/me', '/me/password', '/logout', '/login', '/password/forgot', '/password/reset'];
    if (req.user && req.user.must_change_password && !allowed.includes(req.path)) {
      return res.status(403).json({ error: 'Please set a new password first.', must_change_password: true });
    }
    if (req.user) {
      db.prepare(`UPDATE users SET last_seen_at = datetime('now')
        WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-5 minutes'))`).run(req.user.id);
    }
    next();
  });

  function requireUser(req) {
    if (!req.user) throw new HttpError(401, 'Please sign in.');
    return req.user;
  }

  function requireRole(req, ...roles) {
    const u = requireUser(req);
    if (!roles.includes(u.role)) throw new HttpError(403, 'Not allowed.');
    return u;
  }

  const isAdmin = (u) => u.role === 'admin';
  const isManager = (u) => u.role === 'manager';
  // Admins and dispatch work every lead from every team.
  const seesAll = (u) => u.role === 'admin' || u.role === 'dispatch';

  function canViewReferral(u, ref) {
    if (seesAll(u)) return true;
    if (ref.created_by === u.id || ref.assigned_to === u.id) return true;
    return isManager(u) && u.team_id != null && ref.team_id === u.team_id;
  }

  function canManageReferral(u, ref) {
    if (seesAll(u)) return true;
    return isManager(u) && u.team_id != null && ref.team_id === u.team_id;
  }

  function canManageUser(actor, target) {
    if (isAdmin(actor)) return true;
    return isManager(actor) && target.role === 'rep' && actor.team_id != null && target.team_id === actor.team_id;
  }

  const leadLabel = (ref) => ref.customer_name || `lead #${ref.id}`;

  const REFERRAL_SELECT = `
    SELECT r.*, u.full_name AS created_by_name, u.username AS created_by_username, t.name AS team_name,
      a.full_name AS assigned_name, e.full_name AS entered_by_name
    FROM referrals r
    JOIN users u ON u.id = r.created_by
    LEFT JOIN teams t ON t.id = r.team_id
    LEFT JOIN users a ON a.id = r.assigned_to
    LEFT JOIN users e ON e.id = r.entered_by`;

  function getReferral(id) {
    const ref = db.prepare(`${REFERRAL_SELECT} WHERE r.id = ?`).get(Number(id));
    if (!ref) throw new HttpError(404, 'Referral not found.');
    return { ...ref, state_name: normalizeState(ref.state)?.name || '' };
  }

  function publicReferral(r) {
    const { phone_key, email_key, address_key, address_zip, lead_flags, ...rest } = r;
    let tips = [];
    try { tips = JSON.parse(lead_flags || '[]'); } catch { tips = []; }
    return { ...rest, state_name: normalizeState(r.state)?.name || '', lead_tips: tips };
  }

  // Leads entered before scoring existed get a score once, at startup.
  {
    const rows = db.prepare('SELECT id, customer_name, phone, email, address, city, zip, services FROM referrals WHERE lead_score IS NULL').all();
    const upd = db.prepare('UPDATE referrals SET lead_score = ?, lead_flags = ? WHERE id = ?');
    for (const r of rows) {
      const q = scoreLead({ name: r.customer_name, phone: r.phone, email: r.email, address: r.address, city: r.city, zip: r.zip, services: r.services ? r.services.split(', ') : [] });
      upd.run(q.score, JSON.stringify(q.fakes.map((f) => f.msg).concat(q.tips)), r.id);
    }
  }

  function cleanServices(list) {
    const arr = Array.isArray(list) ? list : String(list || '').split(',');
    return SERVICES.filter((s) => arr.some((x) => String(x).trim().toLowerCase() === s.toLowerCase())).join(', ');
  }

  // opts.requireName: new leads (and edits that change the name) must have one.
  // opts.changed: on edits, the fields being changed; only those are checked for fake details.
  function cleanLead(input, opts = {}) {
    const parsed = input.text ? parseLeadText(input.text) : {};
    const pick = (k) => String(input[k] != null && input[k] !== '' ? input[k] : parsed[k] || '').trim();
    const lead = {
      name: pick('name').slice(0, 200),
      company: pick('company').slice(0, 200),
      phone: pick('phone').slice(0, 50),
      alt_phone: pick('alt_phone').slice(0, 50),
      email: pick('email').slice(0, 200),
      address: pick('address').slice(0, 300),
      city: pick('city').slice(0, 100),
      state: pick('state').slice(0, 40),
      zip: pick('zip').slice(0, 20),
      notes: pick('notes').slice(0, 4000),
      services: cleanServices(input.services !== undefined ? input.services : parsed.services),
      contact_pref: ['Anytime', 'Morning', 'Afternoon', 'Evening', 'Weekend'].includes(input.contact_pref) ? input.contact_pref : 'Anytime',
      package_details: pick('package_details').slice(0, 500),
      lead_priority: ['Low', 'Standard', 'High', 'Urgent'].includes(input.lead_priority) ? input.lead_priority : 'Standard',
      est_monthly_value: Math.max(0, Number(input.est_monthly_value) || 0),
      dob: '',
    };
    const location = parseAddressLocation(lead.address);
    const sourceStreet = addressKey(parsed.address).street;
    const sameSource = !input.address || (sourceStreet && addressKey(input.address).street === sourceStreet);
    for (const field of ['city','state','zip']) {
      const explicit = input[field] != null && String(input[field]).trim() !== '';
      if (!explicit) lead[field] = (!input.address && parsed[field]) || location[field] || (sameSource ? parsed[field] : '') || '';
    }
    if (lead.state) {
      const state = normalizeState(lead.state);
      if (!state && (!opts.changed || opts.changed.has('state'))) throw new HttpError(400,'Enter a valid state or territory, such as TX or Texas.');
      if (state) lead.state = state.code;
    }
    if (lead.zip) {
      const zip = normalizeZip(lead.zip);
      if (!zip && (!opts.changed || opts.changed.has('zip'))) throw new HttpError(400,'ZIP code must have five digits or ZIP+4, such as 75211 or 75211-1234.');
      if (zip) lead.zip = zip;
    }
    const dobRaw = input.dob != null && input.dob !== '' ? String(input.dob).trim() : '';
    if (dobRaw) {
      lead.dob = parseDob(dobRaw);
      if (!lead.dob) throw new HttpError(400, 'Date of birth should be a real date, like 01/31/1980 (the customer must be at least 16).');
    } else lead.dob = parsed.dob || '';
    if (opts.requireName !== false && !lead.name) throw new HttpError(400, 'Add the customer\'s name.');
    if (!lead.phone && !lead.email && !lead.address) {
      throw new HttpError(400, 'Add a phone number, email or address so we can check it isn\'t a duplicate.');
    }
    const quality = scoreLead({ ...lead, services: lead.services ? lead.services.split(', ') : [] });
    const fake = quality.fakes.find((x) => !opts.changed || opts.changed.has(x.field));
    if (fake) throw new HttpError(400, fake.msg);
    lead.score = quality.score;
    lead.flags = JSON.stringify(quality.tips);
    if (lead.phone && !normalizePhone(lead.phone)) throw new HttpError(400, 'That phone number doesn\'t look right (need 10 digits).');
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) throw new HttpError(400, 'That email doesn\'t look right.');
    if (lead.phone) lead.phone = formatPhone(lead.phone);
    if (lead.alt_phone && normalizePhone(lead.alt_phone)) lead.alt_phone = formatPhone(lead.alt_phone);
    const addr = addressKey(lead.address);
    lead.keys = {
      phone: normalizePhone(lead.phone),
      email: normalizeEmail(lead.email),
      address: addr.street,
      zip: (normalizeZip(lead.zip) || addr.zip).slice(0,5),
    };
    return lead;
  }


  // Checks against ALL referrals from every team, then the uploaded past sales.
  // The caller never tells the rep which lead matched.
  // history: which keys to test against past sales ({ phone, address }); edits only test keys that changed.
  function findDuplicate(keys, excludeId = 0, history = { phone: true, address: true }) {
    let hit;
    if (keys.phone && (hit = db.prepare('SELECT id FROM referrals WHERE phone_key = ? AND id <> ? LIMIT 1').get(keys.phone, excludeId))) {
      return { id: hit.id, on: 'phone' };
    }
    if (keys.email && (hit = db.prepare('SELECT id FROM referrals WHERE email_key = ? AND id <> ? LIMIT 1').get(keys.email, excludeId))) {
      return { id: hit.id, on: 'email' };
    }
    if (keys.address && (hit = db.prepare(`SELECT id FROM referrals WHERE address_key = ? AND id <> ?
        AND (? = '' OR address_zip = '' OR address_zip = ?) LIMIT 1`).get(keys.address, excludeId, keys.zip, keys.zip))) {
      return { id: hit.id, on: 'address' };
    }
    const past = historyMatch(db, keys, history);
    if (past) return { id: null, on: past };
    return null;
  }

  function logDuplicate(userId, dup, lead) {
    db.prepare(`INSERT INTO duplicate_attempts (user_id, matched_referral_id, matched_on, customer_name, phone, email, address)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, dup.id, dup.on, lead.name, lead.phone, lead.email, lead.address);
  }

  // In-app notification, plus an email when email is set up and the user wants alerts.
  // Emails go out after the request's transaction: a notification that was rolled back
  // no longer exists when the queue is flushed, so it is never emailed.
  // Also pushed to the user's phones, and emailed when they want email alerts.
  let noteQueue = [];
  function notify(userId, referralId, message, event = 'general') {
    const type=Object.hasOwn(notificationPrefs.EVENTS,event)?event:'general';
    const r = db.prepare('INSERT INTO notifications (user_id, referral_id, message,event_type) VALUES (?, ?, ?,?)').run(userId, referralId, message,type);
    if (!noteQueue.length) setImmediate(flushNotifications);
    noteQueue.push(Number(r.lastInsertRowid));
  }

  function flushNotifications() {
    const ids = noteQueue;
    noteQueue = [];
    const rows = db.prepare(`
      SELECT n.id, n.user_id, n.referral_id, n.message,n.event_type, u.full_name, u.email, u.email_alerts, u.whatsapp, u.whatsapp_alerts,u.notification_preferences
      FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.id IN (${ids.map(() => '?').join(',')}) AND u.active = 1`).all(...ids);
    const settings = getSettings();
    const emailOn = mail.emailConfig(settings).enabled;
    for (const row of rows) {
      if (push && notificationPrefs.allows(row.notification_preferences,row.event_type,'push')) {
        push.sendPush(row.user_id, { body: row.message, url: row.referral_id ? `/#/r/${row.referral_id}` : '/#/notifications', tag: `n${row.id}` })
          .catch((e) => console.error(`Push failed: ${e.message}`));
      }
      if (whatsapp && notificationPrefs.allows(row.notification_preferences,row.event_type,'whatsapp')) {
        const { appUrl } = mail.emailConfig(settings);
        const link = appUrl ? `\n${appUrl}/#/${row.referral_id ? `r/${row.referral_id}` : 'notifications'}` : '';
        whatsapp.sendToUser(row, `🔔 ${row.message}${link}`);
      }
      if (!emailOn || !row.email_alerts || !row.email || !notificationPrefs.allows(row.notification_preferences,row.event_type,'email')) continue;
      const msg = mail.alertEmail({ fullName: row.full_name, message: row.message, referralId: row.referral_id }, settings);
      mail.sendEmail({ to: row.email, ...msg }, settings).then((res) => {
        if (!res.ok) console.error(`Email to ${row.email} failed: ${res.error}`);
      });
    }
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function cleanEmail(value) {
    const e = String(value ?? '').trim().toLowerCase().slice(0, 200);
    if (e && !EMAIL_RE.test(e)) throw new HttpError(400, 'That email address doesn\'t look right.');
    return e;
  }

  // Everyone allowed to see a referral: creator, assignee, that team's managers, dispatch and admins.
  function referralAudience(ref) {
    return db.prepare(`
      SELECT id, username, full_name, role FROM users
      WHERE active = 1 AND (id = ? OR id = ? OR role IN ('admin', 'dispatch')
        OR (role = 'manager' AND team_id IS NOT NULL AND team_id = ?))
      ORDER BY full_name`).all(ref.created_by, ref.assigned_to ?? -1, ref.team_id);
  }

  function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
    return out;
  }

  // A person's WhatsApp number and alerts switch, from their profile or from whoever manages
  // them. A new number switches alerts on unless told otherwise; no number switches them off.
  function setWhatsapp(userId, b) {
    if (b.whatsapp !== undefined) {
      const wa = formatWhatsapp(b.whatsapp);
      if (wa === null) throw new HttpError(400, 'Enter the WhatsApp number with area code, e.g. (512) 555-0142, or with the country code for numbers outside the US.');
      const before = db.prepare('SELECT whatsapp FROM users WHERE id = ?').get(userId).whatsapp;
      // A learned privacy id belongs to the old number, not to a user's account forever.
      if (wa !== before) db.prepare('DELETE FROM wa_identities WHERE user_id = ?').run(userId);
      db.prepare('UPDATE users SET whatsapp = ? WHERE id = ?').run(wa, userId);
      if (!wa) db.prepare('UPDATE users SET whatsapp_alerts = 0 WHERE id = ?').run(userId);
      else if (b.whatsapp_alerts === undefined && wa !== before) db.prepare('UPDATE users SET whatsapp_alerts = 1 WHERE id = ?').run(userId);
    }
    if (b.whatsapp_alerts !== undefined) {
      const has = db.prepare('SELECT whatsapp FROM users WHERE id = ?').get(userId).whatsapp;
      if (b.whatsapp_alerts && !has) throw new HttpError(400, 'Add the WhatsApp number first.');
      db.prepare('UPDATE users SET whatsapp_alerts = ? WHERE id = ?').run(b.whatsapp_alerts ? 1 : 0, userId);
    }
  }

  // The least-busy active dispatcher (fewest open leads), for auto-assignment.
  function pickDispatcher() {
    return db.prepare(`
      SELECT u.id FROM users u
      WHERE u.role = 'dispatch' AND u.active = 1
      ORDER BY (SELECT COUNT(*) FROM referrals r WHERE r.assigned_to = u.id AND r.status IN ('New', 'Working', 'Passed')),
        (SELECT MAX(r.assigned_at) FROM referrals r WHERE r.assigned_to = u.id), u.id
      LIMIT 1`).get()?.id ?? null;
  }

  function assignableUser(id) {
    return db.prepare("SELECT id, full_name FROM users WHERE id = ? AND active = 1 AND role IN ('dispatch', 'admin')").get(Number(id));
  }

  // ---------- auth ----------

  const loginAttempts = new Map();

  function logLogin(req, user, username, success, reason) {
    db.prepare(`INSERT INTO login_events (user_id, username, success, reason, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(user ? user.id : null, String(username).slice(0, 100), success ? 1 : 0, reason, String(req.ip || '').slice(0, 64),
        String(req.headers['user-agent'] || '').slice(0, 300));
    if (Math.random() < 0.02) db.prepare("DELETE FROM login_events WHERE created_at < datetime('now', '-180 days')").run();
  }

  // ---------- forgot password: emailed 6-digit code ----------

  const RESET_MINUTES = 15;
  const resetRequests = new Map();
  const hashCode = (userId, code) => crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
  function rateLimit(map, key, max, windowMs) {
    const now = Date.now();
    const hits = (map.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) return false;
    hits.push(now);
    map.set(key, hits);
    return true;
  }
  const findByLogin = (login) => db.prepare(`SELECT * FROM users WHERE username = ? OR (email <> '' AND email = lower(?))
    ORDER BY username = ? DESC LIMIT 1`).get(login, login, login);

  // Always answers the same way, so it can't be used to find out who has an account.
  app.post('/api/password/forgot', awrap(async (req) => {
    const login = String(req.body.login || '').trim();
    const settings = getSettings();
    if (!mail.emailConfig(settings).enabled) {
      return { ok: true, email_enabled: false };
    }
    if (!login) throw new HttpError(400, 'Enter your username or email.');
    if (!rateLimit(resetRequests, `ip:${req.ip}`, 10, 15 * 60 * 1000)) throw new HttpError(429, 'Too many requests. Try again in a few minutes.');
    const user = findByLogin(login);
    if (user && user.active && user.email && rateLimit(resetRequests, `u:${user.id}`, 3, 15 * 60 * 1000)) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
      db.prepare('INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, ?)')
        .run(user.id, hashCode(user.id, code), Date.now() + RESET_MINUTES * 60 * 1000);
      const r = await mail.sendEmail({ to: user.email, ...mail.resetCodeEmail({ fullName: user.full_name, code, minutes: RESET_MINUTES }) }, settings);
      if (!r.ok) console.error(`Reset code email to ${user.email} failed: ${r.error}`);
    }
    return { ok: true, email_enabled: true };
  }));

  app.post('/api/password/reset', wrap((req, res) => {
    const login = String(req.body.login || '').trim();
    const code = String(req.body.code || '').replace(/\D/g, '');
    const next = String(req.body.password || '');
    if (next.length < 8) throw new HttpError(400, 'New password needs at least 8 characters.');
    const wrong = new HttpError(400, 'That code is wrong or has expired. Request a new one.');
    const user = findByLogin(login);
    if (!user || !user.active) throw wrong;
    const row = db.prepare('SELECT * FROM password_resets WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(user.id);
    if (!row || row.expires_at < Date.now() || row.attempts >= 5) throw wrong;
    const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(hashCode(user.id, code)), Buffer.from(row.code_hash));
    if (!ok) {
      db.prepare('UPDATE password_resets SET attempts = attempts + 1, used = CASE WHEN attempts + 1 >= 5 THEN 1 ELSE used END WHERE id = ?').run(row.id);
      logLogin(req, user, login, false, 'wrong reset code');
      throw wrong;
    }
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(user.id);
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now') WHERE id = ?")
      .run(auth.hashPassword(next), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    // Sign them straight in.
    logLogin(req, user, login, true, 'reset code');
    db.prepare("UPDATE users SET last_login_at = datetime('now'), last_seen_at = datetime('now'), login_count = login_count + 1 WHERE id = ?").run(user.id);
    res.set('Set-Cookie', auth.sessionCookie(auth.createSession(db, user.id), req));
    return { ok: true };
  }));
  app.post('/api/login', wrap((req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const key = `${req.ip}|${username.toLowerCase()}`;
    const now = Date.now();
    const attempts = (loginAttempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
    if (attempts.length >= 10) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');

    const user = db.prepare('SELECT * FROM users WHERE username = ? OR (email <> \'\' AND email = lower(?)) ORDER BY username = ? DESC LIMIT 1')
      .get(username, username, username);
    if (user && user.approval_pending && auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(403, 'Your account is waiting for an admin to approve it. You\'ll get an email when it\'s ready.');
    }
    if (!user || !user.active || !auth.verifyPassword(password, user.password_hash)) {
      attempts.push(now);
      loginAttempts.set(key, attempts);
      logLogin(req, user, username, false, !user ? 'unknown user' : !user.active ? 'deactivated' : 'wrong password');
      throw new HttpError(401, 'Wrong username or password.');
    }
    loginAttempts.delete(key);
    logLogin(req, user, username, true, '');
    db.prepare("UPDATE users SET last_login_at = datetime('now'), last_seen_at = datetime('now'), login_count = login_count + 1 WHERE id = ?").run(user.id);
    const token = auth.createSession(db, user.id);
    res.set('Set-Cookie', auth.sessionCookie(token, req));
    return { ok: true };
  }));

  app.post('/api/logout', wrap((req, res) => {
    if (req.user) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.user.token);
    res.set('Set-Cookie', auth.sessionCookie('', req));
    return { ok: true };
  }));

  app.get('/api/me', wrap((req) => {
    const u = requireUser(req);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(u.id).n;
    const queue = seesAll(u)
      ? db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE assigned_to = ? AND status IN ('New', 'Working', 'Passed')").get(u.id).n
      : 0;
    return {
      id: u.id, username: u.username, full_name: u.full_name, role: u.role,
      team_id: u.team_id, team_name: u.team_name, must_change_password: !!u.must_change_password,
      unread, queue, statuses: STATUSES, services: SERVICES,
      email: u.email, phone: u.phone || '', email_alerts: !!u.email_alerts, email_enabled: mail.emailConfig(getSettings()).enabled,
      dashboard_layout: parseLayout(u.dashboard_layout),
      payments: u.role === 'admin' || u.role === 'manager' || !!u.payments_enabled,
      affiliate: getSettings().affiliate_enabled === '1',
      whatsapp: u.whatsapp || '', whatsapp_alerts: !!u.whatsapp_alerts, whatsapp_ready: !!whatsapp && whatsapp.status() === 'connected',
      notification_preferences:notificationPrefs.read(u.notification_preferences),comparepower_afuid:u.comparepower_afuid||'',
    };
  }));

  app.patch('/api/me', wrap((req) => {
    const u = requireUser(req);
    const b = req.body || {};
    if(b.comparepower_afuid!==undefined){const id=String(b.comparepower_afuid).trim();if(id&&!/^[A-Za-z0-9._-]{1,80}$/.test(id))throw new HttpError(400,'Tracking ID must use letters, numbers, dots, underscores or hyphens.');db.prepare('UPDATE users SET comparepower_afuid=? WHERE id=?').run(id,u.id);}
    if (b.email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(cleanEmail(b.email), u.id);
    if (b.phone !== undefined) {
      const phone = String(b.phone || '').trim().slice(0, 30);
      if (phone && phone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'That phone number looks too short.');
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, u.id);
    }
    if (b.email_alerts !== undefined) db.prepare('UPDATE users SET email_alerts = ? WHERE id = ?').run(b.email_alerts ? 1 : 0, u.id);
    setWhatsapp(u.id, b);
    if (b.dashboard_layout !== undefined) {
      const layout = b.dashboard_layout === null ? '' : JSON.stringify([...new Set(parseLayout(JSON.stringify(b.dashboard_layout)) || [])]);
      db.prepare('UPDATE users SET dashboard_layout = ? WHERE id = ?').run(layout, u.id);
    }
    return { ok: true };
  }));
  app.patch('/api/me/notification-preferences',wrap((req)=>{
    const u=requireUser(req);let preferences;
    try{notificationPrefs.validate(req.body);preferences=notificationPrefs.read(u.notification_preferences);for(const [event,channels]of Object.entries(req.body.events||{}))Object.assign(preferences.events[event],channels);if(req.body.automatic_coaching!==undefined)preferences.automatic_coaching=req.body.automatic_coaching;}catch(e){throw new HttpError(400,e.message);}
    db.prepare('UPDATE users SET notification_preferences=? WHERE id=?').run(JSON.stringify(preferences),u.id);
    return preferences;
  }));

  app.post('/api/me/password', wrap((req) => {
    const u = requireUser(req);
    const { current, next } = req.body;
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
    if (!auth.verifyPassword(String(current || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong.');
    if (String(next || '').length < 8) throw new HttpError(400, 'New password needs at least 8 characters.');
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now') WHERE id = ?")
      .run(auth.hashPassword(next), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(u.id, u.token);
    return { ok: true };
  }));

  app.post('/api/me/logout-all', wrap((req) => {
    const u = requireUser(req);
    const n = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(u.id, u.token).changes;
    return { ok: true, signed_out: Number(n) };
  }));

  // ---------- dashboard ----------

  function parseLayout(raw) {
    try {
      const v = JSON.parse(raw || 'null');
      return Array.isArray(v) ? v.filter((id) => WIDGETS.includes(id)) : null;
    } catch {
      return null;
    }
  }

  app.get('/api/dashboard', wrap((req) => {
    const u = requireUser(req);
    return { ...buildDashboard(db, u, req.query), speed: speedStats(u, req.query), followups: followUps(u) };
  }));

  // First-response times (in working minutes) for the dashboard, over the same scope and period.
  function speedStats(u, q) {
    const c = speed.config();
    const tz = Math.max(-840, Math.min(840, Math.trunc(Number(q.tz) || 0)));
    const local = (col) => `date(datetime(${col}, '${-tz >= 0 ? '+' : ''}${-tz} minutes'))`;
    const where = [];
    const p = [];
    if (u.role === 'rep') { where.push('r.created_by = ?'); p.push(u.id); } else if (u.role === 'manager') { where.push('r.team_id = ?'); p.push(u.team_id ?? -1); } else if (q.team_id) { where.push('r.team_id = ?'); p.push(Number(q.team_id)); }
    if (q.user_id && u.role !== 'rep') { where.push('r.created_by = ?'); p.push(Number(q.user_id)); }
    const W = where.length ? where.join(' AND ') : '1 = 1';
    const isDate = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ''));
    const R = isDate(q.from) ? `${local('r.created_at')} BETWEEN '${q.from}' AND '${isDate(q.to) ? q.to : '9999-12-31'}'` : '1 = 1';
    const toMs = (x) => Date.parse(`${x.replace(' ', 'T')}Z`);
    const mins = db.prepare(`SELECT r.created_at, r.first_touch_at FROM referrals r WHERE ${W} AND ${R} AND r.first_touch_at IS NOT NULL`).all(...p)
      .map((r) => speed.businessMinutes(toMs(r.created_at), toMs(r.first_touch_at))).sort((a, b) => a - b);
    const now = Date.now();
    const waiting = db.prepare(`SELECT r.id, r.customer_name, r.phone, r.created_at, a.full_name AS assigned_name FROM referrals r
      LEFT JOIN users a ON a.id = r.assigned_to WHERE ${W} AND r.status = 'New' AND r.first_touch_at IS NULL AND r.created_at >= datetime('now', '-14 days')
      ORDER BY r.created_at LIMIT 8`).all(...p).map((r) => ({ ...r, minutes: speed.businessMinutes(toMs(r.created_at), now) }));
    return {
      target: c.minutes, escalate: c.escalate, count: mins.length,
      avg: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
      median: mins.length ? mins[Math.floor((mins.length - 1) / 2)] : null,
      within_pct: mins.length ? Math.round((mins.filter((m) => m <= c.minutes).length / mins.length) * 100) : null,
      waiting,
    };
  }

  function followUps(u) {
    return db.prepare(`SELECT id, customer_name, phone, follow_up_at, follow_up_note FROM referrals
      WHERE follow_up_user = ? AND follow_up_sent = 0 AND follow_up_at IS NOT NULL ORDER BY follow_up_at LIMIT 10`).all(u.id);
  }

  // ---------- global search ----------

  app.get('/api/search', wrap((req) => {
    const u = requireUser(req);
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return { referrals: [], users: [] };
    const referrals = listReferrals(u, { q, limit: 8, scope: seesAll(u) ? 'all' : isManager(u) ? 'team' : 'mine' }, 8)
      .map((r) => ({ id: r.id, customer_name: r.customer_name, phone: r.phone, email: r.email, address: r.address,
        status: r.status, created_by_name: r.created_by_name, team_name: r.team_name }));
    let users = [];
    if (isAdmin(u) || isManager(u)) {
      const like = `%${q.toLowerCase()}%`;
      users = db.prepare(`SELECT u.id, u.full_name, u.username, u.role, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id
        WHERE (lower(u.full_name) LIKE ? OR lower(u.username) LIKE ? OR lower(u.email) LIKE ?) ${isAdmin(u) ? '' : 'AND u.team_id = ?'}
        ORDER BY u.active DESC, u.full_name LIMIT 5`).all(like, like, like, ...(isAdmin(u) ? [] : [u.team_id ?? -1]));
    }
    return { referrals, users };
  }));

  // ---------- settings ----------

  // Only the app settings people need; never internal values like the push keys.
  app.get('/api/settings', wrap((req) => {
    const u = requireUser(req);
    const all = getSettings();
    const out = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, all[k]]));
    if (isAdmin(u) && all.location_repair_v20) {
      try { out.location_repair_summary = JSON.parse(all.location_repair_v20); } catch { /* Ignore malformed diagnostics. */ }
    }
    return out;
  }));

  app.patch('/api/settings', wrap((req) => {
    requireRole(req, 'admin');
    const b = req.body || {};
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (b.auto_assign !== undefined) set.run('auto_assign', b.auto_assign ? '1' : '0');
    if (b.entry_template !== undefined) set.run('entry_template', String(b.entry_template).slice(0, 2000));
    if (b.email_from_name !== undefined) set.run('email_from_name', String(b.email_from_name).replace(/[\r\n"<>]/g, '').trim().slice(0, 60));
    if (b.email_reply_to !== undefined) set.run('email_reply_to', cleanEmail(b.email_reply_to));
    if (b.new_lead_alert !== undefined) set.run('new_lead_alert', b.new_lead_alert ? '1' : '0');
    if (b.whatsapp_template !== undefined) {
      const t = String(b.whatsapp_template).slice(0, 2000);
      set.run('whatsapp_template', t.trim() ? t : DEFAULT_SETTINGS.whatsapp_template);
    }
    if (b.whatsapp_number !== undefined) {
      const n = String(b.whatsapp_number).replace(/\D/g, '');
      if (n && (n.length < 10 || n.length > 15)) throw new HttpError(400, 'Enter the WhatsApp number with country code, e.g. 1 512 555 0142.');
      set.run('whatsapp_number', n.length === 10 ? `1${n}` : n);
    }
    const all = getSettings();
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, all[k]]));
  }));

  // ---------- people (for pickers) ----------

  // Users the caller may credit a referral to, plus the dispatchers they may assign to.
  app.get('/api/people', wrap((req) => {
    const u = requireUser(req);
    if (u.role === 'rep') return { credit: [], dispatchers: [] };
    const credit = db.prepare(`
      SELECT u.id, u.full_name, u.username, u.role, u.team_id, t.name AS team_name
      FROM users u LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.active = 1 AND u.role IN ('rep', 'manager') ${seesAll(u) ? '' : 'AND u.team_id = ?'}
      ORDER BY t.name, u.full_name`).all(...(seesAll(u) ? [] : [u.team_id ?? -1]));
    const dispatchers = seesAll(u)
      ? db.prepare(`SELECT id, full_name, username, role FROM users
          WHERE active = 1 AND role IN ('dispatch', 'admin') ORDER BY role DESC, full_name`).all()
      : [];
    return { credit, dispatchers };
  }));

  // ---------- referrals ----------

  app.post('/api/parse', wrap((req) => {
    requireUser(req);
    return parseLeadText(String(req.body.text || ''));
  }));

  app.post('/api/referrals', wrap((req, res) => {
    const u = requireUser(req);
    const lead = cleanLead(req.body || {});

    // Managers, dispatch and admins can enter a lead on a rep's behalf; the rep gets the credit.
    let owner = u;
    if (req.body.credit_to && Number(req.body.credit_to) !== u.id) {
      if (u.role === 'rep') throw new HttpError(403, 'Not allowed.');
      const target = db.prepare("SELECT id, full_name, team_id FROM users WHERE id = ? AND active = 1 AND role IN ('rep', 'manager')")
        .get(Number(req.body.credit_to));
      if (!target || (!seesAll(u) && target.team_id !== u.team_id)) throw new HttpError(400, 'Pick someone on your team.');
      owner = target;
    }

    const autoAssign = getSettings().auto_assign === '1';
    const result = tx(db, () => {
      const dup = findDuplicate(lead.keys);
      if (dup) return { dup };
      const assignee = autoAssign ? pickDispatcher() : null;
      const r = db.prepare(`INSERT INTO referrals
        (customer_name, company, phone, alt_phone, email, address, city, state, zip, notes, services,
         contact_pref, package_details, lead_priority, est_monthly_value,
         raw_text, phone_key, email_key, address_key, address_zip,
         created_by, entered_by, team_id, assigned_to, assigned_at, lead_score, lead_flags, dob)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END, ?, ?, ?)`).run(
        lead.name, lead.company, lead.phone, lead.alt_phone, lead.email, lead.address, lead.city, lead.state, lead.zip,
        lead.notes, lead.services, lead.contact_pref, lead.package_details, lead.lead_priority, lead.est_monthly_value,
        String(req.body.text || '').slice(0, 4000),
        lead.keys.phone, lead.keys.email, lead.keys.address, lead.keys.zip,
        owner.id, u.id, owner.team_id ?? null, assignee, assignee, lead.score, lead.flags, lead.dob,
      );
      const id = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO status_history (referral_id, user_id, from_status, to_status) VALUES (?, ?, NULL, ?)').run(id, u.id, 'New');
      if (owner.id !== u.id) notify(owner.id, id, `${u.full_name} entered ${lead.name || 'a referral'} for you`,'assignments');
      if (assignee && assignee !== u.id) notify(assignee, id, `New lead assigned to you: ${lead.name || `lead #${id}`}`,'assignments');
      return { id };
    });
    if (result.dup) {
      logDuplicate(u.id, result.dup, lead);
      throw new HttpError(409, DUPLICATE_MESSAGE);
    }
    const created = getReferral(result.id);
    announceNewLead(created, u);
    res.status(201);
    return publicReferral(created);
  }));

  // Dispatchers receive new-lead alerts according to their personal preferences.
  // The shared dispatch group receives the full lead post independently, so
  // replies can add notes and update the CRM even when personal alerts are muted.
  function announceNewLead(ref, enteredBy) {
    const settings = getSettings();
    if (settings.new_lead_alert !== '0') {
      const msg = `🆕 New lead: ${leadLabel(ref)}${ref.phone ? ` · ${ref.phone}` : ''} — from ${ref.created_by_name}. Tap to take it.`;
      for (const d of db.prepare("SELECT id FROM users WHERE role = 'dispatch' AND active = 1").all()) {
        if (d.id !== enteredBy.id && d.id !== ref.assigned_to) notify(d.id, ref.id, msg,'new_leads');
      }
    }
    if (whatsapp) {
      const { appUrl } = mail.emailConfig(settings);
      const { text } = waFormat.fill(ref, settings.whatsapp_template, ref.created_by_name);
      const footer = settings.wa_two_way !== '0' ? '\n\n↩️ _Reply to this message to add a note or update the lead · Responde a este mensaje para agregar una nota o actualizar el lead_' : '';
      whatsapp.postToGroup(`${text}${appUrl ? `\n🔗 ${appUrl}/#/r/${ref.id}` : ''}${footer}`, (id, chat) => {
        db.prepare("INSERT OR IGNORE INTO wa_messages (id, chat, referral_id, kind) VALUES (?, ?, ?, 'lead')").run(id, chat, ref.id);
      }, { referralId: ref.id });
    }
  }

  // Shared by the list, the board and the CSV export. Scope is always narrowed to what the caller may see.
  function listReferrals(u, query, maxRows) {
    const where = [];
    const params = [];
    const scope = query.scope || (seesAll(u) ? 'all' : isManager(u) ? 'team' : 'mine');
    if (u.role === 'rep') {
      where.push('(r.created_by = ? OR r.assigned_to = ?)');
      params.push(u.id, u.id);
    } else if (scope === 'mine') {
      where.push('r.created_by = ?');
      params.push(u.id);
    } else if (isManager(u) || scope === 'team') {
      where.push('r.team_id = ?');
      params.push(u.team_id ?? -1);
    }
    if (seesAll(u)) {
      if (scope === 'assigned') {
        where.push('r.assigned_to = ?');
        params.push(u.id);
      } else if (scope === 'unassigned') {
        where.push('r.assigned_to IS NULL');
      }
      if (query.team_id) {
        where.push('r.team_id = ?');
        params.push(Number(query.team_id));
      }
      if (query.assigned_to) {
        where.push('r.assigned_to = ?');
        params.push(Number(query.assigned_to));
      }
    }
    if (query.user_id) {
      where.push('r.created_by = ?');
      params.push(Number(query.user_id));
    }
    if (query.status && STATUSES.includes(query.status)) {
      where.push('r.status = ?');
      params.push(query.status);
    }
    if (query.service && SERVICES.includes(query.service)) {
      where.push("(', ' || r.services || ',') LIKE ?");
      params.push(`%, ${query.service},%`);
    }
    // Board: closed leads (DNQ / Ordered / Cancelled) only from the last N days.
    if (query.closed_days && Number(query.closed_days) > 0) {
      where.push(`(r.status IN ('New', 'Working', 'Passed') OR r.updated_at >= datetime('now', ?))`);
      params.push(`-${Math.floor(Number(query.closed_days))} days`);
    }
    if (query.from) {
      where.push('r.created_at >= ?');
      params.push(String(query.from));
    }
    if (query.to) {
      where.push("r.created_at < date(?, '+1 day')");
      params.push(String(query.to));
    }
    if (query.q) {
      const q = `%${String(query.q).trim().toLowerCase()}%`;
      const digits = String(query.q).replace(/\D/g, '');
      where.push(`(lower(r.customer_name) LIKE ? OR lower(r.email) LIKE ? OR lower(r.address) LIKE ?
        OR lower(r.account_number) LIKE ? OR lower(r.notes) LIKE ?${digits.length >= 3 ? ' OR r.phone_key LIKE ?' : ''})`);
      params.push(q, q, q, q, q);
      if (digits.length >= 3) params.push(`%${digits}%`);
    }
    const limit = Math.min(Math.max(Number(query.limit) || 500, 1), maxRows);
    return db.prepare(`
      SELECT r.*, u.full_name AS created_by_name, t.name AS team_name,
        a.full_name AS assigned_name, e.full_name AS entered_by_name,
        (SELECT COUNT(*) FROM comments c WHERE c.referral_id = r.id) AS comment_count
      FROM referrals r
      JOIN users u ON u.id = r.created_by
      LEFT JOIN teams t ON t.id = r.team_id
      LEFT JOIN users a ON a.id = r.assigned_to
      LEFT JOIN users e ON e.id = r.entered_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit}`).all(...params).map(publicReferral);
  }

  app.get('/api/referrals', wrap((req) => listReferrals(requireUser(req), req.query, 2000)));

  app.get('/api/referrals.csv', (req, res, next) => {
    try {
      const u = requireUser(req);
      const rows = listReferrals(u, { ...req.query, limit: 50000 }, 50000);
      const cols = [
        ['ID', 'id'], ['Entered', 'created_at'], ['Customer', 'customer_name'], ['Phone', 'phone'], ['Email', 'email'],
        ['Address', 'address'], ['Services', 'services'], ['Status', 'status'], ['Account #', 'account_number'],
        ['Install date', 'install_date'], ['Rep', 'created_by_name'], ['Team', 'team_name'],
        ['Entered by', 'entered_by_name'], ['Assigned to', 'assigned_name'], ['Notes', 'notes'],
      ];
      const cell = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from running it as a formula
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map(([, k]) => cell(r[k])).join(','))].join('\r\n');
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="eo-referrals-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('﻿' + csv);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/referrals/:id', wrap((req) => {
    const u = requireUser(req);
    const ref = getReferral(req.params.id);
    if (!canViewReferral(u, ref)) throw new HttpError(404, 'Referral not found.');
    const comments = db.prepare(`SELECT c.id, c.user_id, c.body, c.created_at, c.source, u.full_name, u.username
      FROM comments c JOIN users u ON u.id = c.user_id WHERE c.referral_id = ? ORDER BY c.id`).all(ref.id);
    const history = db.prepare(`SELECT h.user_id, h.from_status, h.to_status, h.created_at, u.full_name
      FROM status_history h JOIN users u ON u.id = h.user_id WHERE h.referral_id = ? ORDER BY h.id`).all(ref.id);
    const toMs = (x) => Date.parse(`${x.replace(' ', 'T')}Z`);
    const speedInfo = ref.first_touch_at
      ? { response_minutes: speed.businessMinutes(toMs(ref.created_at), toMs(ref.first_touch_at)),
        response_by: (db.prepare('SELECT full_name FROM users WHERE id = ?').get(ref.first_touch_by) || {}).full_name || '' }
      : ref.status === 'New' ? { waiting_minutes: speed.businessMinutes(toMs(ref.created_at), Date.now()) } : {};
    return {
      ...publicReferral(ref), comments, history, ...speedInfo, speed_target: speed.config().minutes,
      can_manage: canManageReferral(u, ref),
      can_assign: seesAll(u),
      can_edit: canManageReferral(u, ref) || (ref.created_by === u.id && ref.status === 'New'),
      mentionable: referralAudience(ref).filter((x) => x.id !== u.id).map((x) => ({ username: x.username, full_name: x.full_name })),
    };
  }));

  app.patch('/api/referrals/:id', wrap((req) => updateReferral(requireUser(req), req.params.id, req.body || {})));

  // Every change to a lead goes through here: the edit form, the Board, and WhatsApp replies.
  function updateReferral(u, refId, body) {
    const ref = getReferral(refId);
    if (!canViewReferral(u, ref)) throw new HttpError(404, 'Referral not found.');
    const manage = canManageReferral(u, ref);
    const touch = "updated_at = datetime('now')";

    const dup = tx(db, () => {
      if (body.status !== undefined && body.status !== ref.status) {
        if (!manage) throw new HttpError(403, 'Only a manager or dispatch can change the status.');
        if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status.');
        db.prepare(`UPDATE referrals SET status = ?, ${touch} WHERE id = ?`).run(body.status, ref.id);
        db.prepare('INSERT INTO status_history (referral_id, user_id, from_status, to_status) VALUES (?, ?, ?, ?)')
          .run(ref.id, u.id, ref.status, body.status);
        if (ref.created_by !== u.id) {
          notify(ref.created_by, ref.id, body.status === 'Ordered'
            ? `🎉 Your lead ${leadLabel(ref)} was Ordered! (${u.full_name})`
            : `${u.full_name} marked ${leadLabel(ref)} as ${body.status}`,body.status==='Ordered'?'ordered':'lead_updates');
        }
        speed.touch(ref, u.id);
        // An order with no commission yet gets the default one (Affiliate settings).
        const def = Number(getSettings().affiliate_commission) || 0;
        if (body.status === 'Ordered' && ref.commission == null && def > 0 && body.commission === undefined) {
          db.prepare('UPDATE referrals SET commission = ? WHERE id = ?').run(def, ref.id);
        }
      }
      if (body.commission !== undefined) {
        if (!isAdmin(u)) throw new HttpError(403, 'Only an admin can set the commission.');
        const c = body.commission === null || body.commission === '' ? null : Number(body.commission);
        if (c != null && (!Number.isFinite(c) || c < 0 || c > 100000)) throw new HttpError(400, 'The commission must be a dollar amount.');
        db.prepare(`UPDATE referrals SET commission = ?, ${touch} WHERE id = ?`).run(c == null ? null : Math.round(c * 100) / 100, ref.id);
      }
      if (body.status !== undefined || body.commission !== undefined) affiliates.syncEarnings(ref.id);
      if (body.account_number !== undefined) {
        if (!manage) throw new HttpError(403, 'Only a manager or dispatch can set the account number.');
        db.prepare(`UPDATE referrals SET account_number = ?, ${touch} WHERE id = ?`).run(String(body.account_number).trim().slice(0, 100), ref.id);
      }
      if (body.install_date !== undefined) {
        if (!manage) throw new HttpError(403, 'Only a manager or dispatch can set the install date.');
        const d = String(body.install_date || '');
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'Install date should look like 2026-10-15.');
        db.prepare(`UPDATE referrals SET install_date = ?, ${touch} WHERE id = ?`).run(d, ref.id);
      }
      if (body.assigned_to !== undefined) {
        if (!seesAll(u)) throw new HttpError(403, 'Only dispatch or an admin can assign leads.');
        let to = null;
        if (body.assigned_to !== null && body.assigned_to !== '') {
          const target = assignableUser(body.assigned_to);
          if (!target) throw new HttpError(400, 'Leads can only be assigned to dispatch or admins.');
          to = target.id;
        }
        if (to !== ref.assigned_to) {
          db.prepare(`UPDATE referrals SET assigned_to = ?, assigned_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END, ${touch} WHERE id = ?`)
            .run(to, to, ref.id);
          if (to && to !== u.id) notify(to, ref.id, `${u.full_name} assigned ${leadLabel(ref)} to you`,'assignments');
          if (to === u.id) speed.touch(ref, u.id);
        }
      }
      const detailFields = ['name', 'company', 'phone', 'alt_phone', 'email', 'address', 'city', 'state', 'zip', 'notes', 'services', 'contact_pref', 'package_details', 'lead_priority', 'est_monthly_value', 'dob'];
      if (detailFields.some((f) => body[f] !== undefined)) {
        if (!manage && !(ref.created_by === u.id && ref.status === 'New')) {
          throw new HttpError(403, 'You can only edit details while the referral is New.');
        }
        const editedLocation = body.address !== undefined && String(body.address).trim() !== ref.address
          ? parseAddressLocation(body.address) : {};
        const lead = cleanLead({
          name: body.name ?? ref.customer_name,
          company: body.company ?? ref.company,
          phone: body.phone ?? ref.phone,
          alt_phone: body.alt_phone ?? ref.alt_phone,
          email: body.email ?? ref.email,
          address: body.address ?? ref.address,
          city: body.city ?? (editedLocation.city || ref.city),
          state: body.state ?? (editedLocation.state || ref.state),
          zip: body.zip ?? (editedLocation.zip || ref.zip),
          notes: body.notes ?? ref.notes,
          services: body.services ?? ref.services,
          contact_pref: body.contact_pref ?? ref.contact_pref,
          package_details: body.package_details ?? ref.package_details,
          lead_priority: body.lead_priority ?? ref.lead_priority,
          est_monthly_value: body.est_monthly_value ?? ref.est_monthly_value,
          dob: body.dob ?? ref.dob,
        }, {
          requireName: body.name !== undefined || !!ref.customer_name,
          changed: new Set(detailFields.filter((f) => body[f] !== undefined)),
        });
        const d = findDuplicate(lead.keys, ref.id, { phone: lead.keys.phone !== ref.phone_key, address: lead.keys.address !== ref.address_key || lead.keys.zip !== ref.address_zip });
        if (d) return { d, lead };
        db.prepare(`UPDATE referrals SET customer_name = ?, company = ?, phone = ?, alt_phone = ?, email = ?, address = ?, city = ?, state = ?, zip = ?,
          notes = ?, services = ?, contact_pref = ?, package_details = ?, lead_priority = ?, est_monthly_value = ?,
          phone_key = ?, email_key = ?, address_key = ?, address_zip = ?, lead_score = ?, lead_flags = ?, dob = ?, ${touch} WHERE id = ?`).run(
          lead.name, lead.company, lead.phone, lead.alt_phone, lead.email, lead.address, lead.city, lead.state, lead.zip,
          lead.notes, lead.services, lead.contact_pref, lead.package_details, lead.lead_priority, lead.est_monthly_value,
          lead.keys.phone, lead.keys.email, lead.keys.address, lead.keys.zip, lead.score, lead.flags, lead.dob, ref.id,
        );
      }
      return null;
    });
    if (dup) {
      logDuplicate(u.id, dup.d, dup.lead);
      throw new HttpError(409, DUPLICATE_MESSAGE);
    }
    return publicReferral(getReferral(ref.id));
  }

  app.delete('/api/referrals/:id', wrap((req) => {
    requireRole(req, 'admin');
    const ref = getReferral(req.params.id);
    tx(db, () => {
      affiliates.syncEarnings(ref.id, { removed: true });
      db.prepare('DELETE FROM referrals WHERE id = ?').run(ref.id);
      logAudit(req, 'referral.delete', 'referral', ref.id, `Deleted ${ref.customer_name} (${ref.status})`);
    });
    return { ok: true };
  }));

  app.post('/api/referrals/:id/comments', wrap((req, res) => {
    const u = requireUser(req);
    const ref = getReferral(req.params.id);
    if (!canViewReferral(u, ref)) throw new HttpError(404, 'Referral not found.');
    addComment(u, ref, req.body.body);
    res.status(201);
    return { ok: true };
  }));

  // A note on a lead. opts.source: 'app' | 'whatsapp'. WhatsApp notes only alert the lead's
  // owner when asked to (@owner), so dispatch chatter in the group doesn't flood the reps.
  function addComment(u, ref, text, { source = 'app', notifyOwner = true, ownerMention = false, allowMentions = true } = {}) {
    const body = String(text || '').trim().slice(0, 2000);
    if (!body) throw new HttpError(400, 'Comment is empty.');
    tx(db, () => {
      db.prepare('INSERT INTO comments (referral_id, user_id, body, source) VALUES (?, ?, ?, ?)').run(ref.id, u.id, body, source);
      speed.touch(ref, u.id);
      const audience = referralAudience(ref);
      const mentioned = new Set(allowMentions ? [...body.matchAll(/@([A-Za-z0-9._-]+)/g)].map((m) => m[1].toLowerCase()) : []);
      const notified = new Set([u.id]);
      const snippet = body.slice(0, 120);
      // Only people who can already see this lead get notified — mentions never leak leads.
      for (const person of audience) {
        if (mentioned.has(person.username.toLowerCase()) && !notified.has(person.id)) {
          notify(person.id, ref.id, `${u.full_name} mentioned you on ${leadLabel(ref)}: "${snippet}"`,person.id===ref.created_by?'owner_mention':'comments');
          notified.add(person.id);
        }
      }
      const taggedOwner=(allowMentions && /\B@(owner|due[nñ]o|rep|vendedor|vendedora)\b/i.test(body))||ownerMention;
      if(taggedOwner&&!notified.has(ref.created_by)){
        notify(ref.created_by,ref.id,`${u.full_name} mentioned you on ${leadLabel(ref)}: "${snippet}"`,'owner_mention');notified.add(ref.created_by);
      }
      for (const id of [notifyOwner ? ref.created_by : null, ref.assigned_to]) {
        if (id && !notified.has(id)) {
          notify(id, ref.id, `${u.full_name}${source === 'whatsapp' ? ' (WhatsApp)' : ''} commented on ${leadLabel(ref)}: "${snippet}"`,'comments');
          notified.add(id);
        }
      }
    });
  }

  // ---------- duplicate attempts (admin & dispatch) ----------

  app.get('/api/duplicates', wrap((req) => {
    requireRole(req, 'admin', 'dispatch');
    return db.prepare(`
      SELECT d.*, u.full_name AS attempted_by_name, t.name AS attempted_by_team,
        r.customer_name AS matched_name, r.status AS matched_status, o.full_name AS matched_owner_name, ot.name AS matched_owner_team
      FROM duplicate_attempts d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN teams t ON t.id = u.team_id
      LEFT JOIN referrals r ON r.id = d.matched_referral_id
      LEFT JOIN users o ON o.id = r.created_by
      LEFT JOIN teams ot ON ot.id = r.team_id
      ORDER BY d.id DESC LIMIT 500`).all();
  }));

  // ---------- notifications ----------

  app.get('/api/notifications', wrap((req) => {
    const u = requireUser(req);
    return db.prepare(`SELECT id, referral_id, message, read, created_at FROM notifications
      WHERE user_id = ? ORDER BY id DESC LIMIT 100`).all(u.id);
  }));

  app.post('/api/notifications/read', wrap((req) => {
    const u = requireUser(req);
    if (req.body.id) db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?').run(u.id, Number(req.body.id));
    else db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(u.id);
    return { ok: true };
  }));

  // ---------- sales stats ----------

  const statusCols = () => STATUSES.map((s) => `SUM(CASE WHEN r.status = '${s}' THEN 1 ELSE 0 END) AS "${s}"`).join(', ');
  const countsSql = () => `SELECT ${statusCols()}, COUNT(r.id) AS total`;

  app.get('/api/stats', wrap((req) => {
    const u = requireUser(req);
    const range = [];
    const rangeParams = [];
    if (req.query.from) { range.push('r.created_at >= ?'); rangeParams.push(String(req.query.from)); }
    if (req.query.to) { range.push("r.created_at < date(?, '+1 day')"); rangeParams.push(String(req.query.to)); }
    const rangeSql = range.length ? ' AND ' + range.join(' AND ') : '';
    const zero = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v || 0]));

    const me = zero(db.prepare(`${countsSql()} FROM referrals r WHERE r.created_by = ?${rangeSql}`).get(u.id, ...rangeParams));

    const perUser = (teamId) => db.prepare(`
      SELECT u.id, u.full_name, u.username, u.role, ${statusCols()}, COUNT(r.id) AS total
      FROM users u LEFT JOIN referrals r ON r.created_by = u.id${rangeSql}
      WHERE u.team_id IS ? AND u.active = 1 AND u.role IN ('rep', 'manager', 'admin')
      GROUP BY u.id ORDER BY "Ordered" DESC, total DESC, u.full_name`).all(...rangeParams, teamId).map(zero);

    const out = { me, statuses: STATUSES };
    if (u.team_id != null) {
      out.team = {
        id: u.team_id,
        name: u.team_name,
        totals: zero(db.prepare(`${countsSql()} FROM referrals r WHERE r.team_id = ?${rangeSql}`).get(u.team_id, ...rangeParams)),
        users: perUser(u.team_id),
      };
    }
    if (seesAll(u)) {
      out.teams = db.prepare(`
        SELECT t.id, t.name, ${statusCols()}, COUNT(r.id) AS total
        FROM teams t LEFT JOIN referrals r ON r.team_id = t.id${rangeSql}
        GROUP BY t.id ORDER BY "Ordered" DESC, total DESC, t.name`).all(...rangeParams).map(zero);
      out.all = zero(db.prepare(`${countsSql()} FROM referrals r WHERE 1 = 1${rangeSql}`).get(...rangeParams));
      out.dispatchers = db.prepare(`
        SELECT u.id, u.full_name, u.username, u.role, ${statusCols()}, COUNT(r.id) AS total
        FROM users u LEFT JOIN referrals r ON r.assigned_to = u.id${rangeSql}
        WHERE u.active = 1 AND u.role IN ('dispatch', 'admin')
        GROUP BY u.id HAVING u.role = 'dispatch' OR COUNT(r.id) > 0
        ORDER BY "Ordered" DESC, total DESC, u.full_name`).all(...rangeParams).map(zero);
      out.unassigned = db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE assigned_to IS NULL AND status IN ('New', 'Working', 'Passed')").get().n;
      out.services = SERVICES.map((s) => ({
        service: s,
        ...zero(db.prepare(`${countsSql()} FROM referrals r WHERE (', ' || r.services || ',') LIKE ?${rangeSql}`).get(`%, ${s},%`, ...rangeParams)),
      }));
      if (req.query.team_id) {
        const t = db.prepare('SELECT id, name FROM teams WHERE id = ?').get(Number(req.query.team_id));
        if (t) out.selectedTeam = { ...t, users: perUser(t.id) };
      }
    }
    return out;
  }));

  // ---------- audit logging ----------

  function logAudit(req, action, resourceType, resourceId, details = '') {
    const u = req.user;
    const userId = u ? u.id : null;
    const username = u ? u.username : 'system';
    const ip = String(req.ip || '').slice(0, 64);
    db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, resource_type, resource_id, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, username, action, resourceType, String(resourceId || ''), String(details).slice(0, 500), ip);
  }

  app.get('/api/audit-logs', wrap((req) => {
    requireRole(req, 'admin');
    return db.prepare(`
      SELECT a.*, u.full_name
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT 200
    `).all();
  }));

  // ---------- filter options & saved filters ----------

  app.get('/api/filter-options', wrap((req) => {
    requireUser(req);
    const { STATE_MAP } = require('./normalize');
    const states = Object.entries(STATE_MAP).map(([code, name]) => ({ code, name }));
    const teams = db.prepare('SELECT id, name FROM teams ORDER BY name').all();
    const reps = db.prepare("SELECT id, full_name, team_id, username FROM users WHERE active = 1 AND role IN ('rep', 'manager') ORDER BY full_name").all();
    const dispatchers = db.prepare("SELECT id, full_name, username FROM users WHERE active = 1 AND role IN ('dispatch', 'admin') ORDER BY full_name").all();
    const datePresets = [
      { id: 'today', name: 'Today' },
      { id: 'yesterday', name: 'Yesterday' },
      { id: 'this_week', name: 'This Week' },
      { id: 'last_week', name: 'Last Week' },
      { id: 'this_month', name: 'This Month' },
      { id: 'last_month', name: 'Last Month' },
      { id: 'qtd', name: 'Quarter to Date (QTD)' },
      { id: 'ytd', name: 'Year to Date (YTD)' },
      { id: 'rolling_30d', name: 'Rolling 30 Days' },
      { id: 'rolling_90d', name: 'Rolling 90 Days' },
    ];
    return { states, teams, reps, dispatchers, services: SERVICES, statuses: STATUSES, date_presets: datePresets };
  }));

  app.get('/api/saved-filters', wrap((req) => {
    const u = requireUser(req);
    return db.prepare('SELECT * FROM saved_filters WHERE user_id = ? ORDER BY id DESC').all(u.id);
  }));

  app.post('/api/saved-filters', wrap((req, res) => {
    const u = requireUser(req);
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) throw new HttpError(400, 'Filter name is required.');
    const entity = String(req.body.entity || 'referrals');
    const filterConfig = JSON.stringify(req.body.filter_config || {});
    const r = db.prepare('INSERT INTO saved_filters (user_id, name, entity, filter_config) VALUES (?, ?, ?, ?)').run(u.id, name, entity, filterConfig);
    res.status(201);
    return { id: Number(r.lastInsertRowid), name, entity, filter_config: req.body.filter_config };
  }));

  app.delete('/api/saved-filters/:id', wrap((req) => {
    const u = requireUser(req);
    db.prepare('DELETE FROM saved_filters WHERE id = ? AND user_id = ?').run(Number(req.params.id), u.id);
    return { ok: true };
  }));

  // ---------- custom report builder & analytics ----------

  const { executeReportQuery, generateCSV, computeNextRun, runScheduledReport } = require('./scheduler');

  app.get('/api/reports', wrap((req) => {
    const u = requireUser(req);
    return db.prepare(`
      SELECT r.*, u.full_name AS creator_name,
        (SELECT COUNT(*) FROM report_schedules s WHERE s.report_id = r.id AND s.active = 1) AS schedule_count
      FROM reports r
      JOIN users u ON u.id = r.created_by
      WHERE r.created_by = ? OR r.is_public = 1 OR ? = 'admin'
      ORDER BY r.updated_at DESC
    `).all(u.id, u.role);
  }));

  app.post('/api/reports', wrap((req, res) => {
    const u = requireUser(req);
    const name = String(req.body.name || '').trim().slice(0, 150);
    if (!name) throw new HttpError(400, 'Report name is required.');
    const description = String(req.body.description || '').slice(0, 500);
    const dataSource = String(req.body.data_source || 'referrals');
    const isPublic = req.body.is_public ? 1 : 0;
    const config = JSON.stringify(req.body.config || {});

    const r = db.prepare(`
      INSERT INTO reports (name, description, data_source, created_by, is_public, config)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, description, dataSource, u.id, isPublic, config);

    const id = Number(r.lastInsertRowid);
    logAudit(req, 'create_report', 'report', id, `Created report: ${name}`);
    res.status(201);
    return { id, name, description, data_source: dataSource, created_by: u.id, is_public: !!isPublic };
  }));

  app.get('/api/reports/:id', wrap((req) => {
    const u = requireUser(req);
    const report = db.prepare(`
      SELECT r.*, u.full_name AS creator_name
      FROM reports r JOIN users u ON u.id = r.created_by WHERE r.id = ?
    `).get(Number(req.params.id));
    if (!report) throw new HttpError(404, 'Report not found.');
    if (report.created_by !== u.id && !report.is_public && u.role !== 'admin') {
      throw new HttpError(403, 'Access denied to private report.');
    }
    const schedules = db.prepare('SELECT * FROM report_schedules WHERE report_id = ?').all(report.id);
    return { ...report, config: JSON.parse(report.config || '{}'), schedules };
  }));

  app.patch('/api/reports/:id', wrap((req) => {
    const u = requireUser(req);
    const id = Number(req.params.id);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    if (!report) throw new HttpError(404, 'Report not found.');
    if (report.created_by !== u.id && u.role !== 'admin') throw new HttpError(403, 'Only the report owner or admin can edit.');

    const b = req.body || {};
    const updates = {};
    if (b.name !== undefined) {
      const n = String(b.name).trim().slice(0, 150);
      if (!n) throw new HttpError(400, 'Report name cannot be empty.');
      updates.name = n;
    }
    if (b.description !== undefined) updates.description = String(b.description).slice(0, 500);
    if (b.is_public !== undefined) updates.is_public = b.is_public ? 1 : 0;
    if (b.config !== undefined) updates.config = JSON.stringify(b.config);
    updates.updated_at = "datetime('now')";

    const keys = Object.keys(updates);
    if (keys.length) {
      const setSql = keys.map((k) => (k === 'updated_at' ? `${k} = datetime('now')` : `${k} = ?`)).join(', ');
      const valParams = keys.filter((k) => k !== 'updated_at').map((k) => updates[k]);
      db.prepare(`UPDATE reports SET ${setSql} WHERE id = ?`).run(...valParams, id);
    }
    logAudit(req, 'update_report', 'report', id, `Updated report: ${updates.name || report.name}`);
    return { ok: true };
  }));

  app.delete('/api/reports/:id', wrap((req) => {
    const u = requireUser(req);
    const id = Number(req.params.id);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    if (!report) throw new HttpError(404, 'Report not found.');
    if (report.created_by !== u.id && u.role !== 'admin') throw new HttpError(403, 'Access denied.');
    db.prepare('DELETE FROM reports WHERE id = ?').run(id);
    logAudit(req, 'delete_report', 'report', id, `Deleted report: ${report.name}`);
    return { ok: true };
  }));

  app.post('/api/reports/:id/run', wrap((req) => {
    const u = requireUser(req);
    const id = Number(req.params.id);
    let config = req.body.config;
    let reportName = 'Ad-hoc Query';

    if (id > 0) {
      const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
      if (!report) throw new HttpError(404, 'Report not found.');
      if (report.created_by !== u.id && !report.is_public && u.role !== 'admin') {
        throw new HttpError(403, 'Access denied.');
      }
      reportName = report.name;
      config = config || JSON.parse(report.config || '{}');
    }

    const rows = executeReportQuery(db, u, config || {});

    // Compute aggregations & groupings
    const primaryGroup = config?.group_by || null;
    const secondaryGroup = config?.secondary_group_by || null;
    const calcField = config?.calc_field || null;

    let summary = null;
    if (primaryGroup) {
      const groupsMap = new Map();
      for (const row of rows) {
        const key = String(row[primaryGroup] || 'Unassigned');
        const secKey = secondaryGroup ? String(row[secondaryGroup] || 'Unassigned') : null;

        if (!groupsMap.has(key)) {
          groupsMap.set(key, { name: key, count: 0, ordered: 0, dnq: 0, cancelled: 0, total_val: 0, sub: new Map() });
        }
        const grp = groupsMap.get(key);
        grp.count++;
        if (row.status === 'Ordered') grp.ordered++;
        if (row.status === 'DNQ') grp.dnq++;
        if (row.status === 'Cancelled') grp.cancelled++;
        if (calcField && Number(row[calcField])) grp.total_val += Number(row[calcField]);

        if (secKey) {
          if (!grp.sub.has(secKey)) {
            grp.sub.set(secKey, { name: secKey, count: 0, ordered: 0 });
          }
          const subGrp = grp.sub.get(secKey);
          subGrp.count++;
          if (row.status === 'Ordered') subGrp.ordered++;
        }
      }

      summary = Array.from(groupsMap.values()).map((g) => ({
        group: g.name,
        count: g.count,
        ordered: g.ordered,
        dnq: g.dnq,
        cancelled: g.cancelled,
        conversion_rate: g.count ? Math.round((g.ordered / g.count) * 1000) / 10 : 0,
        subgroups: Array.from(g.sub.values()).map((s) => ({
          group: s.name,
          count: s.count,
          ordered: s.ordered,
          conversion_rate: s.count ? Math.round((s.ordered / s.count) * 1000) / 10 : 0,
        })),
      }));
    }

    const totals = {
      total_records: rows.length,
      ordered_count: rows.filter((r) => r.status === 'Ordered').length,
      conversion_rate: rows.length ? Math.round((rows.filter((r) => r.status === 'Ordered').length / rows.length) * 1000) / 10 : 0,
    };

    return { report_name: reportName, total_records: rows.length, totals, summary, rows: rows.slice(0, 1000) };
  }));

  app.get('/api/reports/:id/export', (req, res, next) => {
    try {
      const u = requireUser(req);
      const id = Number(req.params.id);
      const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
      if (!report) throw new HttpError(404, 'Report not found.');
      if (report.created_by !== u.id && !report.is_public && u.role !== 'admin') throw new HttpError(403, 'Access denied.');

      const config = JSON.parse(report.config || '{}');
      const rows = executeReportQuery(db, u, config);
      const csv = generateCSV(rows, config.columns);

      logAudit(req, 'export_report', 'report', id, `Exported CSV for report: ${report.name}`);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${report.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('﻿' + csv);
    } catch (e) {
      next(e);
    }
  });

  // ---------- scheduled reporting APIs ----------

  app.get('/api/reports/:id/schedules', wrap((req) => {
    const u = requireUser(req);
    const id = Number(req.params.id);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    if (!report) throw new HttpError(404, 'Report not found.');
    return db.prepare('SELECT * FROM report_schedules WHERE report_id = ?').all(id);
  }));

  app.post('/api/reports/:id/schedules', wrap((req, res) => {
    const u = requireUser(req);
    const id = Number(req.params.id);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    if (!report) throw new HttpError(404, 'Report not found.');

    const cadence = String(req.body.cadence || 'daily');
    if (!['daily', 'weekly', 'monthly'].includes(cadence)) throw new HttpError(400, 'Invalid cadence.');

    const deliveryTime = String(req.body.delivery_time || '08:00');
    const timezone = String(req.body.timezone || 'America/New_York');
    const dayOfWeek = Number(req.body.day_of_week || 1);
    const dayOfMonth = Number(req.body.day_of_month || 1);
    const format = String(req.body.format || 'csv');
    const skipEmpty = req.body.skip_empty !== false ? 1 : 0;
    const recipients = JSON.stringify(Array.isArray(req.body.recipients) ? req.body.recipients : [u.email]);

    const nextRun = computeNextRun(cadence, deliveryTime, dayOfWeek, dayOfMonth);

    const r = db.prepare(`
      INSERT INTO report_schedules (report_id, created_by, cadence, delivery_time, timezone, day_of_week, day_of_month, recipients, format, skip_empty, active, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, u.id, cadence, deliveryTime, timezone, dayOfWeek, dayOfMonth, recipients, format, skipEmpty, nextRun);

    const scheduleId = Number(r.lastInsertRowid);
    logAudit(req, 'create_schedule', 'report_schedule', scheduleId, `Scheduled report #${id} (${cadence} at ${deliveryTime})`);
    res.status(201);
    return { id: scheduleId, report_id: id, cadence, delivery_time: deliveryTime, next_run_at: nextRun, recipients: JSON.parse(recipients) };
  }));

  app.patch('/api/schedules/:id', wrap((req) => {
    const u = requireUser(req);
    const id = Number(req.params.id);
    const schedule = db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id);
    if (!schedule) throw new HttpError(404, 'Schedule not found.');
    if (schedule.created_by !== u.id && u.role !== 'admin') throw new HttpError(403, 'Access denied.');

    const b = req.body || {};
    const updates = {};
    if (b.active !== undefined) updates.active = b.active ? 1 : 0;
    if (b.cadence !== undefined) updates.cadence = b.cadence;
    if (b.delivery_time !== undefined) updates.delivery_time = b.delivery_time;
    if (b.recipients !== undefined) updates.recipients = JSON.stringify(b.recipients);
    if (b.format !== undefined) updates.format = b.format;
    if (b.skip_empty !== undefined) updates.skip_empty = b.skip_empty ? 1 : 0;

    const cadence = updates.cadence || schedule.cadence;
    const time = updates.delivery_time || schedule.delivery_time;
    updates.next_run_at = computeNextRun(cadence, time, schedule.day_of_week, schedule.day_of_month);

    const keys = Object.keys(updates);
    if (keys.length) {
      db.prepare(`UPDATE report_schedules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => updates[k]), id);
    }
    logAudit(req, 'update_schedule', 'report_schedule', id, `Updated schedule #${id}`);
    return { ok: true };
  }));

  app.delete('/api/schedules/:id', wrap((req) => {
    const u = requireUser(req);
    const id = Number(req.params.id);
    const schedule = db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id);
    if (!schedule) throw new HttpError(404, 'Schedule not found.');
    if (schedule.created_by !== u.id && u.role !== 'admin') throw new HttpError(403, 'Access denied.');
    db.prepare('DELETE FROM report_schedules WHERE id = ?').run(id);
    logAudit(req, 'delete_schedule', 'report_schedule', id, `Deleted schedule #${id}`);
    return { ok: true };
  }));

  app.post('/api/schedules/:id/test', awrap(async (req) => {
    const u = requireUser(req);
    const id = Number(req.params.id);
    const schedule = db.prepare('SELECT created_by FROM report_schedules WHERE id = ?').get(id);
    if (!schedule) throw new HttpError(404, 'Schedule not found.');
    if (schedule.created_by !== u.id && u.role !== 'admin') throw new HttpError(403, 'Access denied.');
    const res = await runScheduledReport(db, id);
    if (!res) throw new HttpError(400, 'Could not run schedule test.');
    logAudit(req, 'test_schedule', 'report_schedule', id, `Executed test delivery for schedule #${id}`);
    return res;
  }));

  app.get('/api/schedules/:id/history', wrap((req) => {
    const u = requireUser(req);
    const id = Number(req.params.id);
    const schedule = db.prepare('SELECT created_by FROM report_schedules WHERE id = ?').get(id);
    if (!schedule) throw new HttpError(404, 'Schedule not found.');
    if (schedule.created_by !== u.id && u.role !== 'admin') throw new HttpError(403, 'Access denied.');
    return db.prepare('SELECT * FROM schedule_deliveries WHERE schedule_id = ? ORDER BY id DESC LIMIT 50').all(id);
  }));

  app.get('/api/analytics/schedules', wrap((req) => {
    const u = requireUser(req);
    return db.prepare(`
      SELECT s.*, r.name AS report_name, u.full_name AS creator_name
      FROM report_schedules s
      JOIN reports r ON r.id = s.report_id
      JOIN users u ON u.id = s.created_by
      WHERE s.created_by = ? OR ? = 'admin'
      ORDER BY s.id DESC
    `).all(u.id, u.role);
  }));


  // ---------- teams & users ----------

  app.get('/api/teams', wrap((req) => {
    requireUser(req);
    return db.prepare(`SELECT t.id, t.name, (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.active = 1) AS members
      FROM teams t ORDER BY t.name`).all();
  }));

  app.post('/api/teams', wrap((req, res) => {
    requireRole(req, 'admin');
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) throw new HttpError(400, 'Team name is required.');
    if (db.prepare('SELECT 1 FROM teams WHERE name = ?').get(name)) throw new HttpError(409, 'A team with that name already exists.');
    const r = db.prepare('INSERT INTO teams (name) VALUES (?)').run(name);
    res.status(201);
    return { id: Number(r.lastInsertRowid), name };
  }));

  app.patch('/api/teams/:id', wrap((req) => {
    requireRole(req, 'admin');
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (!name) throw new HttpError(400, 'Team name is required.');
    db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, Number(req.params.id));
    return { ok: true };
  }));

  app.get('/api/users', wrap((req) => {
    const u = requireRole(req, 'admin', 'manager');
    const rows = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.whatsapp, u.whatsapp_alerts, u.role, u.payments_enabled, u.team_id, t.name AS team_name, u.active, u.must_change_password, u.created_at,
        (SELECT COUNT(*) FROM referrals r WHERE r.created_by = u.id) AS referral_count,
        (SELECT COUNT(*) FROM referrals r WHERE r.created_by = u.id AND r.status = 'Ordered') AS ordered_count,
        (SELECT COUNT(*) FROM referrals r WHERE r.assigned_to = u.id AND r.status IN ('New', 'Working', 'Passed')) AS open_assigned,
        u.last_login_at, u.last_seen_at, u.password_changed_at, u.login_count,
        (SELECT COUNT(*) FROM login_events l WHERE l.user_id = u.id AND l.success = 0 AND l.created_at >= datetime('now', '-7 days')) AS failed_7d
      FROM users u LEFT JOIN teams t ON t.id = u.team_id
      ${isAdmin(u) ? '' : 'WHERE u.team_id = ?'}
      ORDER BY u.active DESC, t.name, u.full_name`).all(...(isAdmin(u) ? [] : [u.team_id ?? -1]));
    return rows;
  }));

  app.post('/api/users', awrap(async (req, res) => {
    const actor = requireRole(req, 'admin', 'manager');
    const username = String(req.body.username || '').trim().toLowerCase();
    const fullName = String(req.body.full_name || '').trim().slice(0, 100);
    let role = String(req.body.role || 'rep');
    let teamId = req.body.team_id != null && req.body.team_id !== '' ? Number(req.body.team_id) : null;

    if (!/^[a-z0-9._-]{2,40}$/.test(username)) throw new HttpError(400, 'Username: 2-40 letters, numbers, dots, dashes or underscores.');
    if (!fullName) throw new HttpError(400, 'Full name is required.');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role.');
    if (!isAdmin(actor)) {
      role = 'rep';
      teamId = actor.team_id;
    }
    if (teamId != null && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw new HttpError(400, 'Unknown team.');
    if (!['admin', 'dispatch'].includes(role) && teamId == null) throw new HttpError(400, 'Pick a team for this user.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');

    const email = cleanEmail(req.body.email);
    const wa = formatWhatsapp(req.body.whatsapp);
    if (wa === null) throw new HttpError(400, 'Enter the WhatsApp number with area code, e.g. (512) 555-0142, or with the country code for numbers outside the US.');
    const password = req.body.password ? String(req.body.password) : auth.tempPassword();
    if (password.length < 8) throw new HttpError(400, 'Password needs at least 8 characters.');
    const r = db.prepare(`INSERT INTO users (username, full_name, email, whatsapp, whatsapp_alerts, password_hash, role, team_id, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(username, fullName, email, wa, wa ? 1 : 0, auth.hashPassword(password), role, teamId);
    const id = Number(r.lastInsertRowid);
    let welcome = { sent: false };
    const settings = getSettings();
    if (req.body.send_welcome && email && mail.emailConfig(settings).enabled) {
      const teamName = teamId != null ? db.prepare('SELECT name FROM teams WHERE id = ?').get(teamId).name : '';
      const w = await mail.sendEmail({ to: email, ...mail.welcomeEmail({
        fullName, username, password, teamName, invitedBy: actor.full_name, role,
        roleLabel: { admin: 'admin', manager: 'manager', dispatch: 'dispatcher', rep: 'rep' }[role],
      }, settings) }, settings);
      welcome = w.ok ? { sent: true, to: email } : { sent: false, error: w.error };
    }
    res.status(201);
    return { id, username, temp_password: password, welcome };
  }));

  app.patch('/api/users/:id', wrap((req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target || !canManageUser(actor, target)) throw new HttpError(404, 'User not found.');
    const b = req.body || {};
    const updates = {};
    if (b.full_name !== undefined) {
      const n = String(b.full_name).trim().slice(0, 100);
      if (!n) throw new HttpError(400, 'Full name is required.');
      updates.full_name = n;
    }
    if (b.email !== undefined) updates.email = cleanEmail(b.email);
    if (b.active !== undefined) {
      if (target.id === actor.id) throw new HttpError(400, 'You can\'t deactivate yourself.');
      updates.active = b.active ? 1 : 0;
    }
    if (isAdmin(actor)) {
      if (b.role !== undefined) {
        if (!ROLES.includes(b.role)) throw new HttpError(400, 'Unknown role.');
        if (target.id === actor.id && b.role !== 'admin') throw new HttpError(400, 'You can\'t remove your own admin role.');
        updates.role = b.role;
      }
      if (b.team_id !== undefined) {
        const t = b.team_id === null || b.team_id === '' ? null : Number(b.team_id);
        if (t != null && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(t)) throw new HttpError(400, 'Unknown team.');
        updates.team_id = t;
      }
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => updates[k]), target.id);
    }
    setWhatsapp(target.id, b);
    if (updates.active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    return { ok: true };
  }));

  app.post('/api/users/:id/reset-password', awrap(async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target || !canManageUser(actor, target)) throw new HttpError(404, 'User not found.');
    const password = auth.tempPassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(password), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    let emailed = { sent: false };
    const settings = getSettings();
    if (req.body.send_email && target.email && mail.emailConfig(settings).enabled) {
      const r = await mail.sendEmail({ to: target.email, ...mail.tempPasswordEmail({
        fullName: target.full_name, username: target.username, password, resetBy: actor.full_name }, settings) }, settings);
      emailed = r.ok ? { sent: true, to: target.email } : { sent: false, error: r.error };
    }
    return { temp_password: password, emailed };
  }));

  // Sign-in history for one user (admins: anyone; managers: their reps).
  app.get('/api/users/:id/logins', wrap((req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target || !canManageUser(actor, target)) throw new HttpError(404, 'User not found.');
    return db.prepare(`SELECT success, reason, ip, user_agent, created_at FROM login_events
      WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(target.id);
  }));

  // Account-health overview for admins.
  app.get('/api/admin/security', wrap((req) => {
    requireRole(req, 'admin');
    const one = (sql, ...p) => db.prepare(sql).get(...p).n;
    return {
      users: one('SELECT COUNT(*) AS n FROM users WHERE active = 1'),
      active_today: one("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND last_seen_at >= datetime('now', '-1 day')"),
      active_7d: one("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND last_seen_at >= datetime('now', '-7 days')"),
      never_signed_in: one('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND last_login_at IS NULL'),
      inactive_30d: one("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND last_login_at IS NOT NULL AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-30 days'))"),
      old_passwords: one("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND must_change_password = 0 AND (password_changed_at IS NULL OR password_changed_at < datetime('now', '-90 days'))"),
      temp_passwords: one('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND must_change_password = 1'),
      failed_24h: one("SELECT COUNT(*) AS n FROM login_events WHERE success = 0 AND created_at >= datetime('now', '-1 day')"),
      recent_failed: db.prepare(`SELECT l.username, l.reason, l.ip, l.created_at, u.full_name
        FROM login_events l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.success = 0 ORDER BY l.id DESC LIMIT 15`).all(),
    };
  }));

  app.get('/api/admin/email', wrap((req) => {
    requireRole(req, 'admin');
    const cfg = mail.emailConfig(getSettings());
    return { enabled: cfg.enabled, from: cfg.from, name: cfg.name, address: cfg.address, reply_to: cfg.replyTo, app_url: cfg.appUrl };
  }));

  // Sends a test email to the admin's own address and reports Resend's answer.
  app.post('/api/admin/test-email', async (req, res, next) => {
    try {
      const u = requireRole(req, 'admin');
      if (!u.email) throw new HttpError(400, 'Add your own email under My account first.');
      const settings = getSettings();
      if (!mail.emailConfig(settings).enabled) throw new HttpError(400, 'Email is off: add RESEND_API_KEY in Render → Environment.');
      const msg = mail.alertEmail({ fullName: u.full_name, message: 'This is a test email. Alerts are working!', referralId: null }, settings);
      const r = await mail.sendEmail({ to: u.email, ...msg, subject: 'E&O Referrals test email' }, settings);
      if (!r.ok) throw new HttpError(502, `Resend said: ${r.error}`);
      res.json({ ok: true, to: u.email });
    } catch (e) {
      next(e);
    }
  });

  // Full copy of the database, for admins to keep offsite backups.
  app.get('/api/admin/backup', (req, res, next) => {
    let tmp;
    try {
      requireRole(req, 'admin');
      tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eo-backup-')), 'referrals.db');
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const stamp = new Date().toISOString().slice(0, 10);
      res.download(tmp, `eo-referrals-backup-${stamp}.db`, () => fs.rmSync(path.dirname(tmp), { recursive: true, force: true }));
    } catch (e) {
      if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
      next(e);
    }
  });

  // ---------- errors & SPA fallback ----------

  require('./invites').mount(app, db, { requireRole, wrap, awrap, HttpError, getSettings, logAudit, notify, rateLimit, cleanEmail });
  require('./history').mount(app, db, { requireRole, wrap, HttpError, logAudit });
  require('./payments').mount(app, db, { requireUser, requireRole, wrap, awrap, HttpError, getSettings, logAudit, notify });
  speed = require('./speed').mount(app, db, {
    requireUser, requireRole, wrap, HttpError, getSettings, logAudit, notify,
    getViewableReferral: (u, id) => { const r = getReferral(id); if (!canViewReferral(u, r)) throw new HttpError(404, 'Referral not found.'); return r; },
  });
  app.locals.speed = speed;
  push = require('./push').mount(app, db, { requireUser, wrap, HttpError });
  require('./address').mount(app, db, { requireUser, wrap, HttpError, rateLimit });
  {
    const envDb = process.env.DB_FILE;
    whatsapp = require('./whatsapp').mount(app, db, {
      requireUser, requireRole, wrap, awrap, HttpError, getSettings, logAudit, rateLimit,
      notifyAdmins: (msg) => { for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all()) notify(a.id, null, msg); },
      createTransport: opts.whatsappTransport || require('./whatsapp-baileys').createTransport,
      dataDir: envDb && envDb !== ':memory:' ? path.dirname(envDb) : path.join(__dirname, '..', 'data'),
    });
    app.locals.whatsapp = whatsapp;
    app.locals.ai = opts.ai || require('./ai').createAi({ getSettings });
    app.locals.agent = require('./agent').mount(app, db, {
      ai: app.locals.ai, whatsapp, getSettings, getReferral, canViewReferral, seesAll, updateReferral, addComment, notify, logAudit,
      speedConfig: () => speed.config(), requireUser, requireRole, wrap, awrap, HttpError, rateLimit,
    });
    app.locals.coach = require('./seller-coach').mount(app, db, {
      ai: app.locals.ai, whatsapp, getSettings, speedConfig: () => speed.config(), notify, logAudit,
      requireRole, wrap, HttpError, rateLimit,
    });
    app.locals.dispatchBot = require('./dispatch-bot').mount(app, db, {
      whatsapp, ai: app.locals.ai, agent: app.locals.agent, coach: app.locals.coach, getSettings, getReferral, canViewReferral, canManageReferral, seesAll,
      updateReferral, addComment, logAudit, requireRole, wrap, HttpError,
    });
  }
  affiliates = require('./affiliates').mount(app, db, { requireUser, requireRole, wrap, awrap, HttpError, getSettings, logAudit, notify, rateLimit, cleanEmail });
  require('./people').mount(app,db,{requireUser,wrap,HttpError,seesAll,canViewReferral});
  require('./energy').mount(app,db,{requireUser,requireRole,wrap,awrap,HttpError,getReferral,canViewReferral,getSettings,addComment,logAudit,fetchImpl:opts.energyFetch||globalThis.fetch});

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}

// Creates the first admin on an empty database.
function ensureAdmin(db, log = console.log) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || auth.tempPassword();
  db.prepare(`INSERT INTO users (username, full_name, password_hash, role, team_id, must_change_password)
    VALUES (?, ?, ?, 'admin', NULL, ?)`).run(username, 'Administrator', auth.hashPassword(password), process.env.ADMIN_PASSWORD ? 0 : 1);
  const note = process.env.ADMIN_PASSWORD ? '' : "\n  (you'll be asked to change it on first sign-in)";
  log(`\n  First admin account created\n    username: ${username}\n    password: ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : password}${note}\n`);
  return { username, password };
}

module.exports = { createApp, ensureAdmin, DUPLICATE_MESSAGE, OPEN_STATUSES };
