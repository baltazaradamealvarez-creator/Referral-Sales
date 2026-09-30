'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const express = require('express');
const { tx, STATUSES, ROLES, SERVICES } = require('./db');
const auth = require('./auth');
const mail = require('./email');
const { normalizeEmail, normalizePhone, formatPhone, addressKey, parseLeadText } = require('./normalize');

const DUPLICATE_MESSAGE = 'This lead is a duplicate and cannot be entered.';
const OPEN_STATUSES = ['New', 'Passed'];

const DEFAULT_SETTINGS = {
  auto_assign: '0',
  entry_template: 'Name: \nPhone: \nEmail: \nAddress: \nServices: \nNotes: ',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '100kb' }));

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
    const allowed = ['/me', '/me/password', '/logout', '/login'];
    if (req.user && req.user.must_change_password && !allowed.includes(req.path)) {
      return res.status(403).json({ error: 'Please set a new password first.', must_change_password: true });
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
    return ref;
  }

  function publicReferral(r) {
    const { phone_key, email_key, address_key, address_zip, ...rest } = r;
    return rest;
  }

  function cleanServices(list) {
    const arr = Array.isArray(list) ? list : String(list || '').split(',');
    return SERVICES.filter((s) => arr.some((x) => String(x).trim().toLowerCase() === s.toLowerCase())).join(', ');
  }

  function cleanLead(input) {
    const parsed = input.text ? parseLeadText(input.text) : {};
    const pick = (k) => String(input[k] != null && input[k] !== '' ? input[k] : parsed[k] || '').trim();
    const lead = {
      name: pick('name').slice(0, 200),
      phone: pick('phone').slice(0, 50),
      email: pick('email').slice(0, 200),
      address: pick('address').slice(0, 300),
      notes: pick('notes').slice(0, 4000),
      services: cleanServices(input.services !== undefined ? input.services : parsed.services),
    };
    if (!lead.phone && !lead.email && !lead.address) {
      throw new HttpError(400, 'Add a phone number, email or address so we can check it isn\'t a duplicate.');
    }
    if (lead.phone && !normalizePhone(lead.phone)) throw new HttpError(400, 'That phone number doesn\'t look right (need 10 digits).');
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) throw new HttpError(400, 'That email doesn\'t look right.');
    if (lead.phone) lead.phone = formatPhone(lead.phone);
    const addr = addressKey(lead.address);
    lead.keys = {
      phone: normalizePhone(lead.phone),
      email: normalizeEmail(lead.email),
      address: addr.street,
      zip: addr.zip,
    };
    return lead;
  }

  // Checks against ALL referrals from every team. The caller never tells the rep which lead matched.
  function findDuplicate(keys, excludeId = 0) {
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
    return null;
  }

  function logDuplicate(userId, dup, lead) {
    db.prepare(`INSERT INTO duplicate_attempts (user_id, matched_referral_id, matched_on, customer_name, phone, email, address)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, dup.id, dup.on, lead.name, lead.phone, lead.email, lead.address);
  }

  // In-app notification, plus an email when email is set up and the user wants alerts.
  // Emails go out after the request's transaction: a notification that was rolled back
  // no longer exists when the queue is flushed, so it is never emailed.
  let emailQueue = [];
  function notify(userId, referralId, message) {
    const r = db.prepare('INSERT INTO notifications (user_id, referral_id, message) VALUES (?, ?, ?)').run(userId, referralId, message);
    if (!mail.emailConfig().enabled) return;
    if (!emailQueue.length) setImmediate(flushEmails);
    emailQueue.push(Number(r.lastInsertRowid));
  }

  function flushEmails() {
    const ids = emailQueue;
    emailQueue = [];
    const rows = db.prepare(`
      SELECT n.referral_id, n.message, u.full_name, u.email
      FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.id IN (${ids.map(() => '?').join(',')}) AND u.active = 1 AND u.email_alerts = 1 AND u.email <> ''`).all(...ids);
    for (const row of rows) {
      const msg = mail.alertEmail({ fullName: row.full_name, message: row.message, referralId: row.referral_id });
      mail.sendEmail({ to: row.email, ...msg }).then((res) => {
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

  // The least-busy active dispatcher (fewest open leads), for auto-assignment.
  function pickDispatcher() {
    return db.prepare(`
      SELECT u.id FROM users u
      WHERE u.role = 'dispatch' AND u.active = 1
      ORDER BY (SELECT COUNT(*) FROM referrals r WHERE r.assigned_to = u.id AND r.status IN ('New', 'Passed')),
        (SELECT MAX(r.assigned_at) FROM referrals r WHERE r.assigned_to = u.id), u.id
      LIMIT 1`).get()?.id ?? null;
  }

  function assignableUser(id) {
    return db.prepare("SELECT id, full_name FROM users WHERE id = ? AND active = 1 AND role IN ('dispatch', 'admin')").get(Number(id));
  }

  // ---------- auth ----------

  const loginAttempts = new Map();
  app.post('/api/login', wrap((req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const key = `${req.ip}|${username.toLowerCase()}`;
    const now = Date.now();
    const attempts = (loginAttempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
    if (attempts.length >= 10) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !user.active || !auth.verifyPassword(password, user.password_hash)) {
      attempts.push(now);
      loginAttempts.set(key, attempts);
      throw new HttpError(401, 'Wrong username or password.');
    }
    loginAttempts.delete(key);
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
      ? db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE assigned_to = ? AND status IN ('New', 'Passed')").get(u.id).n
      : 0;
    return {
      id: u.id, username: u.username, full_name: u.full_name, role: u.role,
      team_id: u.team_id, team_name: u.team_name, must_change_password: !!u.must_change_password,
      unread, queue, statuses: STATUSES, services: SERVICES,
      email: u.email, email_alerts: !!u.email_alerts, email_enabled: mail.emailConfig().enabled,
    };
  }));

  app.patch('/api/me', wrap((req) => {
    const u = requireUser(req);
    const b = req.body || {};
    if (b.email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(cleanEmail(b.email), u.id);
    if (b.email_alerts !== undefined) db.prepare('UPDATE users SET email_alerts = ? WHERE id = ?').run(b.email_alerts ? 1 : 0, u.id);
    return { ok: true };
  }));

  app.post('/api/me/password', wrap((req) => {
    const u = requireUser(req);
    const { current, next } = req.body;
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
    if (!auth.verifyPassword(String(current || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong.');
    if (String(next || '').length < 8) throw new HttpError(400, 'New password needs at least 8 characters.');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(next), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(u.id, u.token);
    return { ok: true };
  }));

  // ---------- settings ----------

  app.get('/api/settings', wrap((req) => {
    requireUser(req);
    return getSettings();
  }));

  app.patch('/api/settings', wrap((req) => {
    requireRole(req, 'admin');
    const b = req.body || {};
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (b.auto_assign !== undefined) set.run('auto_assign', b.auto_assign ? '1' : '0');
    if (b.entry_template !== undefined) set.run('entry_template', String(b.entry_template).slice(0, 2000));
    return getSettings();
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
        (customer_name, phone, email, address, notes, services, raw_text, phone_key, email_key, address_key, address_zip,
         created_by, entered_by, team_id, assigned_to, assigned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)`).run(
        lead.name, lead.phone, lead.email, lead.address, lead.notes, lead.services, String(req.body.text || '').slice(0, 4000),
        lead.keys.phone, lead.keys.email, lead.keys.address, lead.keys.zip,
        owner.id, u.id, owner.team_id ?? null, assignee, assignee,
      );
      const id = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO status_history (referral_id, user_id, from_status, to_status) VALUES (?, ?, NULL, ?)').run(id, u.id, 'New');
      if (owner.id !== u.id) notify(owner.id, id, `${u.full_name} entered ${lead.name || 'a referral'} for you`);
      if (assignee && assignee !== u.id) notify(assignee, id, `New lead assigned to you: ${lead.name || `lead #${id}`}`);
      return { id };
    });
    if (result.dup) {
      logDuplicate(u.id, result.dup, lead);
      throw new HttpError(409, DUPLICATE_MESSAGE);
    }
    res.status(201);
    return publicReferral(getReferral(result.id));
  }));

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
      where.push(`(r.status IN ('New', 'Passed') OR r.updated_at >= datetime('now', ?))`);
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
    const comments = db.prepare(`SELECT c.id, c.body, c.created_at, u.full_name, u.username
      FROM comments c JOIN users u ON u.id = c.user_id WHERE c.referral_id = ? ORDER BY c.id`).all(ref.id);
    const history = db.prepare(`SELECT h.from_status, h.to_status, h.created_at, u.full_name
      FROM status_history h JOIN users u ON u.id = h.user_id WHERE h.referral_id = ? ORDER BY h.id`).all(ref.id);
    return {
      ...publicReferral(ref), comments, history,
      can_manage: canManageReferral(u, ref),
      can_assign: seesAll(u),
      can_edit: canManageReferral(u, ref) || (ref.created_by === u.id && ref.status === 'New'),
      mentionable: referralAudience(ref).filter((x) => x.id !== u.id).map((x) => ({ username: x.username, full_name: x.full_name })),
    };
  }));

  app.patch('/api/referrals/:id', wrap((req) => {
    const u = requireUser(req);
    const ref = getReferral(req.params.id);
    if (!canViewReferral(u, ref)) throw new HttpError(404, 'Referral not found.');
    const manage = canManageReferral(u, ref);
    const body = req.body || {};
    const touch = "updated_at = datetime('now')";

    const dup = tx(db, () => {
      if (body.status !== undefined && body.status !== ref.status) {
        if (!manage) throw new HttpError(403, 'Only a manager or dispatch can change the status.');
        if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status.');
        db.prepare(`UPDATE referrals SET status = ?, ${touch} WHERE id = ?`).run(body.status, ref.id);
        db.prepare('INSERT INTO status_history (referral_id, user_id, from_status, to_status) VALUES (?, ?, ?, ?)')
          .run(ref.id, u.id, ref.status, body.status);
        if (ref.created_by !== u.id) notify(ref.created_by, ref.id, `${u.full_name} marked ${leadLabel(ref)} as ${body.status}`);
      }
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
          if (to && to !== u.id) notify(to, ref.id, `${u.full_name} assigned ${leadLabel(ref)} to you`);
        }
      }
      const detailFields = ['name', 'phone', 'email', 'address', 'notes', 'services'];
      if (detailFields.some((f) => body[f] !== undefined)) {
        if (!manage && !(ref.created_by === u.id && ref.status === 'New')) {
          throw new HttpError(403, 'You can only edit details while the referral is New.');
        }
        const lead = cleanLead({
          name: body.name ?? ref.customer_name,
          phone: body.phone ?? ref.phone,
          email: body.email ?? ref.email,
          address: body.address ?? ref.address,
          notes: body.notes ?? ref.notes,
          services: body.services ?? ref.services,
        });
        const d = findDuplicate(lead.keys, ref.id);
        if (d) return { d, lead };
        db.prepare(`UPDATE referrals SET customer_name = ?, phone = ?, email = ?, address = ?, notes = ?, services = ?,
          phone_key = ?, email_key = ?, address_key = ?, address_zip = ?, ${touch} WHERE id = ?`).run(
          lead.name, lead.phone, lead.email, lead.address, lead.notes, lead.services,
          lead.keys.phone, lead.keys.email, lead.keys.address, lead.keys.zip, ref.id,
        );
      }
      return null;
    });
    if (dup) {
      logDuplicate(u.id, dup.d, dup.lead);
      throw new HttpError(409, DUPLICATE_MESSAGE);
    }
    return publicReferral(getReferral(ref.id));
  }));

  app.delete('/api/referrals/:id', wrap((req) => {
    requireRole(req, 'admin');
    const ref = getReferral(req.params.id);
    db.prepare('DELETE FROM referrals WHERE id = ?').run(ref.id);
    return { ok: true };
  }));

  app.post('/api/referrals/:id/comments', wrap((req, res) => {
    const u = requireUser(req);
    const ref = getReferral(req.params.id);
    if (!canViewReferral(u, ref)) throw new HttpError(404, 'Referral not found.');
    const body = String(req.body.body || '').trim().slice(0, 2000);
    if (!body) throw new HttpError(400, 'Comment is empty.');

    tx(db, () => {
      db.prepare('INSERT INTO comments (referral_id, user_id, body) VALUES (?, ?, ?)').run(ref.id, u.id, body);
      const audience = referralAudience(ref);
      const mentioned = new Set([...body.matchAll(/@([A-Za-z0-9._-]+)/g)].map((m) => m[1].toLowerCase()));
      const notified = new Set([u.id]);
      const snippet = body.slice(0, 120);
      // Only people who can already see this lead get notified — mentions never leak leads.
      for (const person of audience) {
        if (mentioned.has(person.username.toLowerCase()) && !notified.has(person.id)) {
          notify(person.id, ref.id, `${u.full_name} mentioned you on ${leadLabel(ref)}: "${snippet}"`);
          notified.add(person.id);
        }
      }
      for (const id of [ref.created_by, ref.assigned_to]) {
        if (id && !notified.has(id)) {
          notify(id, ref.id, `${u.full_name} commented on ${leadLabel(ref)}: "${snippet}"`);
          notified.add(id);
        }
      }
    });
    res.status(201);
    return { ok: true };
  }));

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
      out.unassigned = db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE assigned_to IS NULL AND status IN ('New', 'Passed')").get().n;
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
      SELECT u.id, u.username, u.full_name, u.email, u.role, u.team_id, t.name AS team_name, u.active, u.must_change_password, u.created_at,
        (SELECT COUNT(*) FROM referrals r WHERE r.created_by = u.id) AS referral_count,
        (SELECT COUNT(*) FROM referrals r WHERE r.created_by = u.id AND r.status = 'Ordered') AS ordered_count,
        (SELECT COUNT(*) FROM referrals r WHERE r.assigned_to = u.id AND r.status IN ('New', 'Passed')) AS open_assigned
      FROM users u LEFT JOIN teams t ON t.id = u.team_id
      ${isAdmin(u) ? '' : 'WHERE u.team_id = ?'}
      ORDER BY u.active DESC, t.name, u.full_name`).all(...(isAdmin(u) ? [] : [u.team_id ?? -1]));
    return rows;
  }));

  app.post('/api/users', wrap((req, res) => {
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
    const password = req.body.password ? String(req.body.password) : auth.tempPassword();
    if (password.length < 8) throw new HttpError(400, 'Password needs at least 8 characters.');
    const r = db.prepare(`INSERT INTO users (username, full_name, email, password_hash, role, team_id, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(username, fullName, email, auth.hashPassword(password), role, teamId);
    res.status(201);
    return { id: Number(r.lastInsertRowid), username, temp_password: password };
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
    if (updates.active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    return { ok: true };
  }));

  app.post('/api/users/:id/reset-password', wrap((req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target || !canManageUser(actor, target)) throw new HttpError(404, 'User not found.');
    const password = auth.tempPassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(password), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    return { temp_password: password };
  }));

  app.get('/api/admin/email', wrap((req) => {
    requireRole(req, 'admin');
    const cfg = mail.emailConfig();
    return { enabled: cfg.enabled, from: cfg.from, app_url: cfg.appUrl };
  }));

  // Sends a test email to the admin's own address and reports Resend's answer.
  app.post('/api/admin/test-email', async (req, res, next) => {
    try {
      const u = requireRole(req, 'admin');
      if (!u.email) throw new HttpError(400, 'Add your own email under My account first.');
      if (!mail.emailConfig().enabled) throw new HttpError(400, 'Email is off: add RESEND_API_KEY in Render → Environment.');
      const msg = mail.alertEmail({ fullName: u.full_name, message: 'This is a test email. Alerts are working!', referralId: null });
      const r = await mail.sendEmail({ to: u.email, ...msg, subject: 'E&O Referrals test email' });
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
