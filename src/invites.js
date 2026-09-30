'use strict';

// Invite links: an admin creates a link that lets people sign themselves up.
// The role and team come from the invite, never from the sign-up form, so a link
// can only ever create the kind of account the admin chose.

const crypto = require('node:crypto');
const auth = require('./auth');
const mail = require('./email');

const ROLE_LABEL = { admin: 'admin', manager: 'manager', dispatch: 'dispatcher', rep: 'rep' };

function inviteStatus(inv) {
  if (inv.revoked) return 'revoked';
  if (inv.uses >= inv.max_uses) return 'used';
  if (Date.parse(inv.expires_at.replace(' ', 'T') + 'Z') < Date.now()) return 'expired';
  return 'active';
}

function mount(app, db, { requireRole, wrap, awrap, HttpError, getSettings, logAudit, notify, rateLimit, cleanEmail }) {
  const joinHits = new Map();

  function inviteUrl(req, token) {
    const base = (mail.emailConfig().appUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    return `${base}/#/join/${token}`;
  }

  function findActive(token) {
    const inv = db.prepare(`SELECT i.*, t.name AS team_name, u.full_name AS created_by_name
      FROM invites i LEFT JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.created_by
      WHERE i.token = ?`).get(String(token || ''));
    if (!inv) throw new HttpError(404, 'This invite link isn’t valid. Ask your admin for a new one.');
    const st = inviteStatus(inv);
    if (st === 'revoked') throw new HttpError(410, 'This invite link was turned off. Ask your admin for a new one.');
    if (st === 'expired') throw new HttpError(410, 'This invite link has expired. Ask your admin for a new one.');
    if (st === 'used') throw new HttpError(410, 'This invite link has already been used. Ask your admin for a new one.');
    return inv;
  }

  // ---------- admin: create, list, turn off ----------

  app.post('/api/invites', wrap((req, res) => {
    const u = requireRole(req, 'admin');
    const b = req.body || {};
    const role = String(b.role || 'rep');
    if (!ROLE_LABEL[role]) throw new HttpError(400, 'Unknown role.');
    const teamId = b.team_id != null && b.team_id !== '' ? Number(b.team_id) : null;
    if (teamId != null && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw new HttpError(400, 'Unknown team.');
    if (!['admin', 'dispatch'].includes(role) && teamId == null) throw new HttpError(400, 'Pick the team new people will join.');
    const maxUses = Number(b.max_uses ?? 1);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 500) throw new HttpError(400, 'Uses must be between 1 and 500.');
    const days = Number(b.expires_days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, 'The link can last 1 to 90 days.');
    const note = String(b.note || '').trim().slice(0, 120);
    const token = crypto.randomBytes(18).toString('base64url');
    const r = db.prepare(`INSERT INTO invites (token, created_by, role, team_id, max_uses, expires_at, note)
      VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?)`).run(token, u.id, role, teamId, maxUses, `+${days} days`, note);
    const id = Number(r.lastInsertRowid);
    logAudit(req, 'invite.create', 'invite', id, `${ROLE_LABEL[role]}, ${maxUses} use(s), ${days} day(s)${note ? `: ${note}` : ''}`);
    res.status(201);
    return { id, url: inviteUrl(req, token), status: 'active' };
  }));

  app.get('/api/invites', wrap((req) => {
    requireRole(req, 'admin');
    const rows = db.prepare(`SELECT i.*, t.name AS team_name, u.full_name AS created_by_name
      FROM invites i LEFT JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.created_by
      ORDER BY i.id DESC LIMIT 200`).all();
    const joined = db.prepare('SELECT id, full_name, username, created_at FROM users WHERE invite_id = ? ORDER BY id');
    return rows.map((i) => ({
      id: i.id, role: i.role, team_id: i.team_id, team_name: i.team_name, max_uses: i.max_uses, uses: i.uses,
      expires_at: i.expires_at, note: i.note, created_at: i.created_at, created_by_name: i.created_by_name,
      status: inviteStatus(i), url: inviteUrl(req, i.token), joined: joined.all(i.id),
    }));
  }));

  app.delete('/api/invites/:id', wrap((req) => {
    requireRole(req, 'admin');
    const inv = db.prepare('SELECT * FROM invites WHERE id = ?').get(Number(req.params.id));
    if (!inv) throw new HttpError(404, 'Invite not found.');
    db.prepare('UPDATE invites SET revoked = 1 WHERE id = ?').run(inv.id);
    logAudit(req, 'invite.revoke', 'invite', inv.id, '');
    return { ok: true };
  }));

  // ---------- public: check a link, sign up ----------

  app.get('/api/join/:token', wrap((req) => {
    if (!rateLimit(joinHits, `ip:${req.ip}`, 60, 15 * 60 * 1000)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const inv = findActive(req.params.token);
    return {
      role: inv.role, role_label: ROLE_LABEL[inv.role], team_name: inv.team_name || '',
      invited_by: inv.created_by_name || 'Your admin', expires_at: inv.expires_at,
      email_enabled: mail.emailConfig(getSettings()).enabled,
    };
  }));

  app.post('/api/join/:token', awrap(async (req, res) => {
    if (!rateLimit(joinHits, `post:${req.ip}`, 20, 15 * 60 * 1000)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const b = req.body || {};
    const fullName = String(b.full_name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const username = String(b.username || '').trim().toLowerCase();
    const email = cleanEmail(b.email);
    const phone = String(b.phone || '').trim().slice(0, 30);
    const password = String(b.password || '');
    if (!fullName) throw new HttpError(400, 'Enter your full name.');
    if (!/^[a-z0-9._-]{2,40}$/.test(username)) throw new HttpError(400, 'Username: 2–40 letters, numbers, dots, dashes or underscores.');
    if (!email) throw new HttpError(400, 'Enter your email address — it’s used for alerts and password resets.');
    if (phone && phone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'That phone number looks too short.');
    if (password.length < 8) throw new HttpError(400, 'Your password needs at least 8 characters.');
    if (password !== String(b.password_confirm ?? password)) throw new HttpError(400, 'The two passwords don’t match.');

    // Claim a use and create the account together, so a single-use link can't be used twice.
    db.exec('BEGIN IMMEDIATE');
    let user;
    let inv;
    try {
      inv = findActive(req.params.token);
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken — try another.');
      if (db.prepare("SELECT 1 FROM users WHERE email <> '' AND email = ?").get(email)) throw new HttpError(409, 'An account with that email already exists. Try signing in, or use Forgot your password.');
      const claimed = db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked = 0').run(inv.id).changes;
      if (!claimed) throw new HttpError(410, 'This invite link has already been used. Ask your admin for a new one.');
      const r = db.prepare(`INSERT INTO users (username, full_name, email, phone, password_hash, role, team_id, must_change_password, password_changed_at, invite_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), ?)`).run(username, fullName, email, phone, auth.hashPassword(password), inv.role, inv.team_id, inv.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    req.user = user;
    logAudit(req, 'invite.join', 'user', user.id, `${user.full_name} joined as ${ROLE_LABEL[user.role]} via invite #${inv.id}`);
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all()) {
      notify(a.id, null, `${user.full_name} (@${user.username}) signed up as a ${ROLE_LABEL[user.role]}${inv.team_name ? ` on ${inv.team_name}` : ''}`);
    }

    // Welcome email with a quick guide to entering leads (no password in it).
    let welcome = { sent: false };
    const settings = getSettings();
    if (mail.emailConfig(settings).enabled) {
      const w = await mail.sendEmail({ to: user.email, ...mail.welcomeEmail({
        fullName: user.full_name, username: user.username, role: user.role, roleLabel: ROLE_LABEL[user.role],
        teamName: inv.team_name || '', invitedBy: inv.created_by_name || 'Your admin', selfSignup: true,
      }, settings) }, settings);
      welcome = w.ok ? { sent: true } : { sent: false, error: w.error };
    }

    // Sign them straight in.
    db.prepare("UPDATE users SET last_login_at = datetime('now'), last_seen_at = datetime('now'), login_count = login_count + 1 WHERE id = ?").run(user.id);
    res.set('Set-Cookie', auth.sessionCookie(auth.createSession(db, user.id), req));
    res.status(201);
    return { ok: true, username: user.username, welcome };
  }));
}

module.exports = { mount, inviteStatus };
