'use strict';

// Affiliate program: anyone can share a personal sign-up link. The people who join
// through it are their "level 1"; people those recruits bring in are "level 2", and
// so on. When a recruit's lead is Ordered with a commission, each person up the chain
// earns a percentage of that commission (by default 15% for level 1, 5% for level 2),
// paid on top of the seller's own commission. Earnings come from real sales only,
// never from sign-ups.
//
// Earnings are a ledger: every change (sale, commission edit, cancellation) adds a row,
// so what someone is owed is the sum of their rows not yet in a payout.

const crypto = require('node:crypto');
const auth = require('./auth');
const mail = require('./email');
const { readSignupForm, ROLE_LABEL } = require('./invites');

const MAX_LEVELS = 5;
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => `$${Number(n).toFixed(2)}`;

// "15, 5" -> [15, 5]. Percentages 0–50, at most 5 levels, trailing zeros dropped.
function parseLevels(value) {
  const out = String(value || '').split(/[\s,;]+/).filter(Boolean).slice(0, MAX_LEVELS).map(Number);
  if (out.some((n) => !Number.isFinite(n) || n < 0 || n > 50)) return null;
  while (out.length && out[out.length - 1] === 0) out.pop();
  return out.map((n) => round2(n));
}

function mount(app, db, { requireUser, requireRole, wrap, awrap, HttpError, getSettings, logAudit, notify, rateLimit, cleanEmail }) {
  const program = () => {
    const s = getSettings();
    return {
      enabled: s.affiliate_enabled === '1',
      levels: parseLevels(s.affiliate_levels) || [15, 5],
      commission: Math.max(0, Number(s.affiliate_commission) || 0),
      approval: s.affiliate_approval !== '0',
    };
  };

  function codeFor(userId) {
    const row = db.prepare('SELECT affiliate_code FROM users WHERE id = ?').get(userId);
    if (row && row.affiliate_code) return row.affiliate_code;
    for (;;) {
      const code = crypto.randomBytes(6).toString('base64url');
      try {
        db.prepare('UPDATE users SET affiliate_code = ? WHERE id = ?').run(code, userId);
        return code;
      } catch { /* taken; try again */ }
    }
  }

  const linkFor = (req, code) => {
    const base = (mail.emailConfig().appUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    return `${base}/#/join/a/${code}`;
  };

  // The seller's sponsors, nearest first: [level 1, level 2, …].
  function sponsorChain(sellerId, depth) {
    const chain = [];
    const seen = new Set([sellerId]);
    let cur = db.prepare('SELECT sponsor_id FROM users WHERE id = ?').get(sellerId);
    while (cur && cur.sponsor_id && chain.length < depth && !seen.has(cur.sponsor_id)) {
      const u = db.prepare('SELECT id, active, sponsor_id FROM users WHERE id = ?').get(cur.sponsor_id);
      if (!u) break;
      seen.add(u.id);
      chain.push(u);
      cur = u;
    }
    return chain;
  }

  // Brings a referral's affiliate earnings in line with its current status and commission.
  // Once someone has earned on a sale, the level, person and percentage are locked for it.
  function syncEarnings(referralId, { removed = false } = {}) {
    const ref = db.prepare(`SELECT r.id, r.status, r.commission, r.created_by, r.customer_name, u.full_name AS seller_name
      FROM referrals r JOIN users u ON u.id = r.created_by WHERE r.id = ?`).get(referralId);
    if (!ref) return;
    const p = program();
    const base = !removed && ref.status === 'Ordered' && ref.commission > 0 ? Number(ref.commission) : 0;
    const existing = new Map(db.prepare(`SELECT level, earner_id, MAX(pct) AS pct, SUM(amount) AS total
      FROM affiliate_earnings WHERE referral_id = ? GROUP BY level, earner_id`).all(ref.id).map((r) => [r.level, r]));
    if (!existing.size && (!base || !p.enabled)) return;

    const chain = base && p.enabled ? sponsorChain(ref.created_by, p.levels.length) : [];
    const levels = new Set([...existing.keys(), ...chain.map((_, i) => i + 1)]);
    const add = db.prepare(`INSERT INTO affiliate_earnings (referral_id, earner_id, seller_id, level, pct, base, amount, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const level of [...levels].sort()) {
      const had = existing.get(level);
      let earnerId;
      let pct;
      if (had) {
        earnerId = had.earner_id;
        pct = had.pct;
      } else {
        const who = chain[level - 1];
        if (!who || !who.active || !p.levels[level - 1]) continue;
        earnerId = who.id;
        pct = p.levels[level - 1];
      }
      const want = round2((base * pct) / 100);
      const have = round2(had ? had.total : 0);
      const diff = round2(want - have);
      if (Math.abs(diff) < 0.005) continue;
      const kind = have === 0 ? 'sale' : want === 0 ? 'reversal' : 'adjustment';
      add.run(ref.id, earnerId, ref.created_by, level, pct, base, diff, kind);
      if (kind === 'sale') {
        notify(earnerId, null, `💸 You earned ${money(diff)} (${pct}%) on a sale by ${ref.seller_name}${level > 1 ? ` (level ${level})` : ''}`);
      } else if (kind === 'reversal') {
        notify(earnerId, null, `A sale by ${ref.seller_name} was cancelled, so ${money(-diff)} of your affiliate earnings was taken back`);
      }
    }
  }

  // Whole downline, for counting and cycle checks: Map(userId -> level).
  function downline(userId, depth = MAX_LEVELS) {
    const out = new Map();
    let frontier = [userId];
    for (let level = 1; level <= depth && frontier.length; level++) {
      const next = db.prepare(`SELECT id FROM users WHERE sponsor_id IN (${frontier.map(() => '?').join(',')})`).all(...frontier).map((r) => r.id);
      frontier = next.filter((id) => !out.has(id) && id !== userId);
      for (const id of frontier) out.set(id, level);
    }
    return out;
  }

  const owedFor = (userId) => round2(db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM affiliate_earnings WHERE earner_id = ? AND payout_id IS NULL').get(userId).n);

  // ---------- the member's own page ----------

  app.get('/api/affiliate/me', wrap((req) => {
    const u = requireUser(req);
    const p = program();
    if (!p.enabled) throw new HttpError(403, 'The affiliate program isn’t switched on.');
    const code = codeFor(u.id);
    const team = downline(u.id, p.levels.length || 1);
    const month = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM affiliate_earnings
      WHERE earner_id = ? AND created_at >= datetime('now', 'start of month')`).get(u.id).n;
    const lifetime = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM affiliate_earnings WHERE earner_id = ?').get(u.id).n;
    const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM affiliate_payouts WHERE user_id = ?').get(u.id).n;
    const direct = db.prepare(`SELECT u.id, u.full_name, u.created_at, u.active, u.approval_pending,
        (SELECT COUNT(*) FROM users x WHERE x.sponsor_id = u.id) AS recruits,
        (SELECT COUNT(*) FROM referrals r WHERE r.created_by = u.id AND r.status = 'Ordered' AND r.updated_at >= datetime('now', 'start of month')) AS orders_month,
        (SELECT COALESCE(SUM(e.amount), 0) FROM affiliate_earnings e WHERE e.earner_id = ? AND e.seller_id = u.id) AS earned_from
      FROM users u WHERE u.sponsor_id = ? ORDER BY u.created_at DESC`).all(u.id, u.id);
    // Customer names stay private: members see the seller and lead number only.
    const earnings = db.prepare(`SELECT e.id, e.referral_id, e.level, e.pct, e.base, e.amount, e.kind, e.payout_id, e.created_at, s.full_name AS seller_name
      FROM affiliate_earnings e LEFT JOIN users s ON s.id = e.seller_id WHERE e.earner_id = ? ORDER BY e.id DESC LIMIT 100`).all(u.id);
    const byLevel = [...team.values()].reduce((acc, l) => { acc[l] = (acc[l] || 0) + 1; return acc; }, {});
    return {
      levels: p.levels, commission: p.commission, approval: p.approval, code, link: linkFor(req, code),
      stats: { owed: owedFor(u.id), month: round2(month), lifetime: round2(lifetime), paid: round2(paid), by_level: byLevel },
      direct, earnings,
      payouts: db.prepare('SELECT id, amount, note, created_at FROM affiliate_payouts WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id),
    };
  }));

  // Email your link to friends.
  const inviteHits = new Map();
  app.post('/api/affiliate/invite', awrap(async (req) => {
    const u = requireUser(req);
    if (!program().enabled) throw new HttpError(403, 'The affiliate program isn’t switched on.');
    const settings = getSettings();
    if (!mail.emailConfig(settings).enabled) throw new HttpError(400, 'Email isn’t switched on, so copy your link and text it instead.');
    const b = req.body || {};
    const emails = [...new Set(String(Array.isArray(b.emails) ? b.emails.join(',') : b.emails || '').split(/[\s,;]+/).filter(Boolean).map((e) => cleanEmail(e)))];
    if (!emails.length) throw new HttpError(400, 'Enter at least one email address.');
    if (emails.length > 10) throw new HttpError(400, 'Send to 10 people or fewer at a time.');
    for (let i = 0; i < emails.length; i++) {
      if (!rateLimit(inviteHits, `u:${u.id}`, 30, 24 * 60 * 60 * 1000)) throw new HttpError(429, 'You’ve sent a lot of invites today. Try again tomorrow.');
    }
    const url = linkFor(req, codeFor(u.id));
    const msg = mail.affiliateInviteEmail({ url, fromName: u.full_name, message: b.message }, settings);
    const results = [];
    for (const to of emails) {
      const r = await mail.sendEmail({ to, ...msg }, settings);
      results.push({ email: to, sent: r.ok, error: r.ok ? undefined : r.error });
    }
    logAudit(req, 'affiliate.invite', 'user', u.id, `${results.filter((x) => x.sent).length} of ${emails.length} sent`);
    return { emailed: results };
  }));

  // ---------- public: join through someone's link ----------

  const joinHits = new Map();
  const sponsorByCode = (code) => {
    const s = db.prepare(`SELECT u.id, u.full_name, u.team_id, u.active, t.name AS team_name FROM users u
      LEFT JOIN teams t ON t.id = u.team_id WHERE u.affiliate_code = ?`).get(String(code || ''));
    if (!s || !s.active || !program().enabled) throw new HttpError(404, 'This sign-up link isn’t valid any more. Ask the person who sent it for a new one.');
    return s;
  };

  app.get('/api/join-a/:code', wrap((req) => {
    if (!rateLimit(joinHits, `ip:${req.ip}`, 60, 15 * 60 * 1000)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const s = sponsorByCode(req.params.code);
    return { invited_by: s.full_name, role_label: 'rep', team_name: s.team_name || '', approval: program().approval, affiliate: true };
  }));

  app.post('/api/join-a/:code', awrap(async (req, res) => {
    if (!rateLimit(joinHits, `post:${req.ip}`, 20, 15 * 60 * 1000)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const form = readSignupForm(req.body, { cleanEmail, HttpError });
    const p = program();
    let user;
    let sponsor;
    db.exec('BEGIN IMMEDIATE');
    try {
      sponsor = sponsorByCode(req.params.code);
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(form.username)) throw new HttpError(409, 'That username is taken — try another.');
      if (db.prepare("SELECT 1 FROM users WHERE email <> '' AND email = ?").get(form.email)) throw new HttpError(409, 'An account with that email already exists. Try signing in, or use Forgot your password.');
      // Recruits join their sponsor's team (or the first team if the sponsor has none).
      const teamId = sponsor.team_id ?? (db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get() || {}).id ?? null;
      const r = db.prepare(`INSERT INTO users (username, full_name, email, phone, whatsapp, whatsapp_alerts, password_hash, role, team_id, must_change_password, password_changed_at, sponsor_id, active, approval_pending)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'rep', ?, 0, datetime('now'), ?, ?, ?)`).run(form.username, form.fullName, form.email, form.phone, form.whatsapp, form.whatsapp ? 1 : 0,
        auth.hashPassword(form.password), teamId, sponsor.id, p.approval ? 0 : 1, p.approval ? 1 : 0);
      user = db.prepare('SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?').get(Number(r.lastInsertRowid));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    req.user = user;
    logAudit(req, 'affiliate.join', 'user', user.id, `${user.full_name} joined via ${sponsor.full_name}'s link${p.approval ? ' (waiting for approval)' : ''}`);
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all()) {
      notify(a.id, null, p.approval
        ? `${user.full_name} signed up through ${sponsor.full_name}'s affiliate link and is waiting for your approval (Affiliate page)`
        : `${user.full_name} (@${user.username}) joined through ${sponsor.full_name}'s affiliate link`);
    }
    res.status(201);
    if (p.approval) {
      notify(sponsor.id, null, `${user.full_name} signed up with your link. They can start once an admin approves them.`);
      return { ok: true, pending: true };
    }
    notify(sponsor.id, null, `🎉 ${user.full_name} joined with your link. You'll earn on their sales.`);
    const welcome = await sendWelcome(user, sponsor.full_name);
    db.prepare("UPDATE users SET last_login_at = datetime('now'), last_seen_at = datetime('now'), login_count = login_count + 1 WHERE id = ?").run(user.id);
    res.set('Set-Cookie', auth.sessionCookie(auth.createSession(db, user.id), req));
    return { ok: true, username: user.username, welcome };
  }));

  async function sendWelcome(user, invitedBy) {
    const settings = getSettings();
    if (!mail.emailConfig(settings).enabled || !user.email) return { sent: false };
    const w = await mail.sendEmail({ to: user.email, ...mail.welcomeEmail({
      fullName: user.full_name, username: user.username, role: 'rep', roleLabel: ROLE_LABEL.rep,
      teamName: user.team_name || '', invitedBy, selfSignup: true,
    }, settings) }, settings);
    return w.ok ? { sent: true } : { sent: false, error: w.error };
  }

  // ---------- admin ----------

  app.get('/api/affiliate/admin', wrap((req) => {
    requireRole(req, 'admin');
    const p = program();
    const pending = db.prepare(`SELECT u.id, u.full_name, u.username, u.email, u.phone, u.created_at, s.full_name AS sponsor_name, t.name AS team_name
      FROM users u LEFT JOIN users s ON s.id = u.sponsor_id LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.approval_pending = 1 ORDER BY u.id`).all();
    const members = db.prepare(`SELECT u.id, u.full_name, u.username, u.role, u.active, u.sponsor_id, s.full_name AS sponsor_name,
        (SELECT COUNT(*) FROM users x WHERE x.sponsor_id = u.id) AS recruits,
        (SELECT COALESCE(SUM(amount), 0) FROM affiliate_earnings e WHERE e.earner_id = u.id AND e.payout_id IS NULL) AS owed,
        (SELECT COALESCE(SUM(amount), 0) FROM affiliate_earnings e WHERE e.earner_id = u.id) AS lifetime,
        (SELECT MAX(created_at) FROM affiliate_payouts p WHERE p.user_id = u.id) AS last_paid,
        EXISTS (SELECT 1 FROM payout_methods m WHERE m.user_id = u.id) AS has_payout_details
      FROM users u LEFT JOIN users s ON s.id = u.sponsor_id
      WHERE u.approval_pending = 0 ORDER BY owed DESC, u.active DESC, u.full_name`).all()
      .map((m) => ({ ...m, owed: round2(m.owed), lifetime: round2(m.lifetime), has_payout_details: !!m.has_payout_details }));
    const payouts = db.prepare(`SELECT p.id, p.amount, p.note, p.created_at, u.full_name, c.full_name AS paid_by
      FROM affiliate_payouts p JOIN users u ON u.id = p.user_id LEFT JOIN users c ON c.id = p.created_by ORDER BY p.id DESC LIMIT 50`).all();
    return { settings: p, pending, members, payouts };
  }));

  app.patch('/api/affiliate/settings', wrap((req) => {
    requireRole(req, 'admin');
    const b = req.body || {};
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (b.enabled !== undefined) set.run('affiliate_enabled', b.enabled ? '1' : '0');
    if (b.approval !== undefined) set.run('affiliate_approval', b.approval ? '1' : '0');
    if (b.levels !== undefined) {
      const lv = parseLevels(Array.isArray(b.levels) ? b.levels.join(',') : b.levels);
      if (!lv || !lv.length) throw new HttpError(400, 'Each level is a percentage from 0 to 50, up to 5 levels (e.g. 15, 5).');
      set.run('affiliate_levels', lv.join(','));
    }
    if (b.commission !== undefined) {
      const c = Number(b.commission);
      if (!Number.isFinite(c) || c < 0 || c > 100000) throw new HttpError(400, 'The default commission must be a dollar amount.');
      set.run('affiliate_commission', String(round2(c)));
    }
    logAudit(req, 'affiliate.settings', 'settings', '', JSON.stringify(program()));
    return program();
  }));

  app.post('/api/affiliate/approve/:id', awrap(async (req) => {
    requireRole(req, 'admin');
    const u = db.prepare('SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ? AND u.approval_pending = 1').get(Number(req.params.id));
    if (!u) throw new HttpError(404, 'No sign-up waiting with that id.');
    const sponsor = u.sponsor_id ? db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(u.sponsor_id) : null;
    if ((req.body || {}).approve === false) {
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      logAudit(req, 'affiliate.reject', 'user', u.id, u.full_name);
      return { ok: true, rejected: true };
    }
    db.prepare('UPDATE users SET active = 1, approval_pending = 0 WHERE id = ?').run(u.id);
    logAudit(req, 'affiliate.approve', 'user', u.id, u.full_name);
    if (sponsor) notify(sponsor.id, null, `🎉 ${u.full_name} was approved and joined your team. You'll earn on their sales.`);
    const welcome = await sendWelcome(u, sponsor ? sponsor.full_name : 'Your admin');
    return { ok: true, welcome };
  }));

  // Set who recruited whom (for people who were already here before the program).
  app.patch('/api/affiliate/sponsor/:id', wrap((req) => {
    requireRole(req, 'admin');
    const u = db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) throw new HttpError(404, 'User not found.');
    const raw = (req.body || {}).sponsor_id;
    const sponsorId = raw === null || raw === '' || raw === undefined ? null : Number(raw);
    if (sponsorId != null) {
      if (sponsorId === u.id) throw new HttpError(400, 'Someone can’t recruit themselves.');
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(sponsorId)) throw new HttpError(400, 'Unknown user.');
      if (downline(u.id, 50).has(sponsorId)) throw new HttpError(400, 'That would make a loop: they’re already below this person.');
    }
    db.prepare('UPDATE users SET sponsor_id = ? WHERE id = ?').run(sponsorId, u.id);
    logAudit(req, 'affiliate.sponsor', 'user', u.id, `sponsor → ${sponsorId ?? 'none'}`);
    return { ok: true };
  }));

  app.post('/api/affiliate/payouts', wrap((req, res) => {
    requireRole(req, 'admin');
    const b = req.body || {};
    const u = db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(Number(b.user_id));
    if (!u) throw new HttpError(404, 'User not found.');
    db.exec('BEGIN IMMEDIATE');
    let id;
    let owed;
    try {
      owed = owedFor(u.id);
      if (owed <= 0) throw new HttpError(400, `${u.full_name} isn’t owed anything right now.`);
      id = Number(db.prepare('INSERT INTO affiliate_payouts (user_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
        .run(u.id, owed, String(b.note || '').trim().slice(0, 200), req.user.id).lastInsertRowid);
      db.prepare('UPDATE affiliate_earnings SET payout_id = ? WHERE earner_id = ? AND payout_id IS NULL').run(id, u.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    logAudit(req, 'affiliate.payout', 'user', u.id, `${money(owed)}${b.note ? `: ${b.note}` : ''}`);
    notify(u.id, null, `✅ Your affiliate earnings of ${money(owed)} were marked as paid`);
    res.status(201);
    return { id, amount: owed };
  }));

  return { syncEarnings, program };
}

module.exports = { mount, parseLevels };
