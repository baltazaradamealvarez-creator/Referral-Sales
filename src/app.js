'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const express = require('express');
const { tx, STATUSES, ROLES } = require('./db');
const auth = require('./auth');
const { normalizeEmail, normalizePhone, formatPhone, addressKey, parseLeadText } = require('./normalize');

const DUPLICATE_MESSAGE = 'This lead is a duplicate and cannot be entered.';

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

  function canViewReferral(u, ref) {
    if (isAdmin(u)) return true;
    if (ref.created_by === u.id) return true;
    return isManager(u) && u.team_id != null && ref.team_id === u.team_id;
  }

  function canManageReferral(u, ref) {
    if (isAdmin(u)) return true;
    return isManager(u) && u.team_id != null && ref.team_id === u.team_id;
  }

  function canManageUser(actor, target) {
    if (isAdmin(actor)) return true;
    return isManager(actor) && target.role === 'rep' && actor.team_id != null && target.team_id === actor.team_id;
  }

  function getReferral(id) {
    const ref = db.prepare(`
      SELECT r.*, u.full_name AS created_by_name, u.username AS created_by_username, t.name AS team_name
      FROM referrals r JOIN users u ON u.id = r.created_by LEFT JOIN teams t ON t.id = r.team_id
      WHERE r.id = ?`).get(Number(id));
    if (!ref) throw new HttpError(404, 'Referral not found.');
    return ref;
  }

  function publicReferral(r) {
    const { phone_key, email_key, address_key, address_zip, ...rest } = r;
    return rest;
  }

  function cleanLead(input) {
    const parsed = input.text ? parseLeadText(input.text) : {};
    const pick = (k) => String(input[k] != null && input[k] !== '' ? input[k] : parsed[k] || '').trim();
    const lead = {
      name: pick('name').slice(0, 200),
      phone: pick('phone').slice(0, 50),
      email: pick('email').slice(0, 200),
      address: pick('address').slice(0, 300),
      notes: pick('notes').slice(0, 2000),
    };
    if (!lead.name) throw new HttpError(400, 'Please include the customer name.');
    if (!lead.phone && !lead.email && !lead.address) {
      throw new HttpError(400, 'Please include a phone, email, or address.');
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

  // Checks against ALL referrals from every team. Never reveals which lead matched.
  function isDuplicate(keys, excludeId = 0) {
    if (keys.phone && db.prepare('SELECT 1 FROM referrals WHERE phone_key = ? AND id <> ? LIMIT 1').get(keys.phone, excludeId)) return true;
    if (keys.email && db.prepare('SELECT 1 FROM referrals WHERE email_key = ? AND id <> ? LIMIT 1').get(keys.email, excludeId)) return true;
    if (keys.address) {
      const hit = db.prepare(`SELECT 1 FROM referrals WHERE address_key = ? AND id <> ?
        AND (? = '' OR address_zip = '' OR address_zip = ?) LIMIT 1`).get(keys.address, excludeId, keys.zip, keys.zip);
      if (hit) return true;
    }
    return false;
  }

  function notify(userId, referralId, message) {
    db.prepare('INSERT INTO notifications (user_id, referral_id, message) VALUES (?, ?, ?)').run(userId, referralId, message);
  }

  // Everyone allowed to see a referral: creator, that team's managers, admins.
  function referralAudience(ref) {
    return db.prepare(`
      SELECT id, username, full_name, role FROM users
      WHERE active = 1 AND (id = ? OR role = 'admin' OR (role = 'manager' AND team_id IS NOT NULL AND team_id = ?))
      ORDER BY full_name`).all(ref.created_by, ref.team_id);
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
    return {
      id: u.id, username: u.username, full_name: u.full_name, role: u.role,
      team_id: u.team_id, team_name: u.team_name, must_change_password: !!u.must_change_password,
      unread, statuses: STATUSES,
    };
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

  // ---------- referrals ----------

  app.post('/api/parse', wrap((req) => {
    requireUser(req);
    return parseLeadText(String(req.body.text || ''));
  }));

  app.post('/api/referrals', wrap((req, res) => {
    const u = requireUser(req);
    const lead = cleanLead(req.body || {});
    const id = tx(db, () => {
      if (isDuplicate(lead.keys)) throw new HttpError(409, DUPLICATE_MESSAGE);
      const r = db.prepare(`INSERT INTO referrals
        (customer_name, phone, email, address, notes, raw_text, phone_key, email_key, address_key, address_zip, created_by, team_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        lead.name, lead.phone, lead.email, lead.address, lead.notes, String(req.body.text || '').slice(0, 4000),
        lead.keys.phone, lead.keys.email, lead.keys.address, lead.keys.zip, u.id, u.team_id,
      );
      const newId = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO status_history (referral_id, user_id, from_status, to_status) VALUES (?, ?, NULL, ?)').run(newId, u.id, 'New');
      return newId;
    });
    res.status(201);
    return publicReferral(getReferral(id));
  }));

  app.get('/api/referrals', wrap((req) => {
    const u = requireUser(req);
    const where = [];
    const params = [];
    const scope = req.query.scope || 'mine';
    if (scope === 'mine' || u.role === 'rep') {
      where.push('r.created_by = ?');
      params.push(u.id);
    } else if (scope === 'team' || isManager(u)) {
      where.push('r.team_id = ?');
      params.push(u.team_id ?? -1);
    }
    if (req.query.team_id && isAdmin(u)) {
      where.push('r.team_id = ?');
      params.push(Number(req.query.team_id));
    }
    if (req.query.user_id) {
      where.push('r.created_by = ?');
      params.push(Number(req.query.user_id));
    }
    if (req.query.status && STATUSES.includes(req.query.status)) {
      where.push('r.status = ?');
      params.push(req.query.status);
    }
    if (req.query.q) {
      const q = `%${String(req.query.q).trim().toLowerCase()}%`;
      const digits = String(req.query.q).replace(/\D/g, '');
      where.push(`(lower(r.customer_name) LIKE ? OR lower(r.email) LIKE ? OR lower(r.address) LIKE ?
        OR lower(r.account_number) LIKE ?${digits.length >= 3 ? ' OR r.phone_key LIKE ?' : ''})`);
      params.push(q, q, q, q);
      if (digits.length >= 3) params.push(`%${digits}%`);
    }
    const rows = db.prepare(`
      SELECT r.*, u.full_name AS created_by_name, t.name AS team_name,
        (SELECT COUNT(*) FROM comments c WHERE c.referral_id = r.id) AS comment_count
      FROM referrals r JOIN users u ON u.id = r.created_by LEFT JOIN teams t ON t.id = r.team_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC, r.id DESC LIMIT 500`).all(...params);
    return rows.map(publicReferral);
  }));

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

    tx(db, () => {
      if (body.status !== undefined && body.status !== ref.status) {
        if (!manage) throw new HttpError(403, 'Only a manager can change the status.');
        if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status.');
        db.prepare("UPDATE referrals SET status = ?, updated_at = datetime('now') WHERE id = ?").run(body.status, ref.id);
        db.prepare('INSERT INTO status_history (referral_id, user_id, from_status, to_status) VALUES (?, ?, ?, ?)')
          .run(ref.id, u.id, ref.status, body.status);
        if (ref.created_by !== u.id) notify(ref.created_by, ref.id, `${u.full_name} marked ${ref.customer_name} as ${body.status}`);
      }
      if (body.account_number !== undefined) {
        if (!manage) throw new HttpError(403, 'Only a manager can set the account number.');
        db.prepare("UPDATE referrals SET account_number = ?, updated_at = datetime('now') WHERE id = ?")
          .run(String(body.account_number).trim().slice(0, 100), ref.id);
      }
      const detailFields = ['name', 'phone', 'email', 'address', 'notes'];
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
        });
        if (isDuplicate(lead.keys, ref.id)) throw new HttpError(409, DUPLICATE_MESSAGE);
        db.prepare(`UPDATE referrals SET customer_name = ?, phone = ?, email = ?, address = ?, notes = ?,
          phone_key = ?, email_key = ?, address_key = ?, address_zip = ?, updated_at = datetime('now') WHERE id = ?`).run(
          lead.name, lead.phone, lead.email, lead.address, lead.notes,
          lead.keys.phone, lead.keys.email, lead.keys.address, lead.keys.zip, ref.id,
        );
      }
    });
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
      // Only people who can already see this lead get notified — mentions never leak leads.
      for (const person of audience) {
        if (mentioned.has(person.username.toLowerCase()) && !notified.has(person.id)) {
          notify(person.id, ref.id, `${u.full_name} mentioned you on ${ref.customer_name}: "${body.slice(0, 120)}"`);
          notified.add(person.id);
        }
      }
      if (!notified.has(ref.created_by)) {
        notify(ref.created_by, ref.id, `${u.full_name} commented on ${ref.customer_name}: "${body.slice(0, 120)}"`);
      }
    });
    res.status(201);
    return { ok: true };
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

  function countsSql() {
    return `SELECT ${STATUSES.map((s) => `SUM(CASE WHEN r.status = '${s}' THEN 1 ELSE 0 END) AS "${s}"`).join(', ')},
      COUNT(r.id) AS total`;
  }

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
      SELECT u.id, u.full_name, u.username, u.role, ${STATUSES.map((s) => `SUM(CASE WHEN r.status = '${s}' THEN 1 ELSE 0 END) AS "${s}"`).join(', ')},
        COUNT(r.id) AS total
      FROM users u LEFT JOIN referrals r ON r.created_by = u.id${rangeSql}
      WHERE u.team_id IS ? AND u.active = 1
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
    if (isAdmin(u)) {
      out.teams = db.prepare(`
        SELECT t.id, t.name, ${STATUSES.map((s) => `SUM(CASE WHEN r.status = '${s}' THEN 1 ELSE 0 END) AS "${s}"`).join(', ')},
          COUNT(r.id) AS total
        FROM teams t LEFT JOIN referrals r ON r.team_id = t.id${rangeSql}
        GROUP BY t.id ORDER BY "Ordered" DESC, total DESC, t.name`).all(...rangeParams).map(zero);
      out.all = zero(db.prepare(`${countsSql()} FROM referrals r WHERE 1 = 1${rangeSql}`).get(...rangeParams));
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
      SELECT u.id, u.username, u.full_name, u.role, u.team_id, t.name AS team_name, u.active, u.must_change_password, u.created_at,
        (SELECT COUNT(*) FROM referrals r WHERE r.created_by = u.id) AS referral_count,
        (SELECT COUNT(*) FROM referrals r WHERE r.created_by = u.id AND r.status = 'Ordered') AS ordered_count
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
    if (role !== 'admin' && teamId == null) throw new HttpError(400, 'Pick a team for this user.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');

    const password = req.body.password ? String(req.body.password) : auth.tempPassword();
    if (password.length < 8) throw new HttpError(400, 'Password needs at least 8 characters.');
    const r = db.prepare(`INSERT INTO users (username, full_name, password_hash, role, team_id, must_change_password)
      VALUES (?, ?, ?, ?, ?, 1)`).run(username, fullName, auth.hashPassword(password), role, teamId);
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

  // ---------- errors & SPA fallback ----------

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

module.exports = { createApp, ensureAdmin, DUPLICATE_MESSAGE };
