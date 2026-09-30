'use strict';

// Payout details: managers (and anyone an admin switches on) record how they get paid:
// bank account (account number or IBAN), Bit, or a Bitcoin wallet.
// Account numbers are encrypted at rest (AES-256-GCM). Users only ever see a masked
// summary; admins can reveal the full details, and every reveal is audit-logged.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const mail = require('./email');

// ---------- countries ----------

const COUNTRY_CODES = ('AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CU CV CW CY CZ '
  + 'DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP '
  + 'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ '
  + 'OM PA PE PF PG PH PK PL PM PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TL TM TN TO TR TT TV TW TZ '
  + 'UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW').split(' ');

// IBAN length by country (SWIFT IBAN registry).
const IBAN_LENGTH = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
  LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25,
  QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20,
};

const regionName = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRIES = COUNTRY_CODES
  .map((code) => ({ code, name: regionName.of(code) || code, iban: IBAN_LENGTH[code] || 0 }))
  .sort((a, b) => a.name.localeCompare(b.name));
const COUNTRY_SET = new Set(COUNTRY_CODES);

// ---------- validation ----------

function ibanValid(iban) {
  const cc = iban.slice(0, 2);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return 'That IBAN doesn’t look right. It starts with 2 letters and 2 digits, like DE89 3704…';
  if (IBAN_LENGTH[cc] && iban.length !== IBAN_LENGTH[cc]) return `A ${regionName.of(cc)} IBAN has ${IBAN_LENGTH[cc]} characters; this one has ${iban.length}.`;
  if (iban.length < 15 || iban.length > 34) return 'That IBAN is the wrong length.';
  const moved = iban.slice(4) + iban.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1 ? '' : 'That IBAN has a typo: its check digits don’t add up. Copy it again from your bank app.';
}

function routingValid(r) {
  if (!/^\d{9}$/.test(r)) return false;
  const d = [...r].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

const last4 = (s) => String(s).replace(/\s/g, '').slice(-4);

// Returns { method, country, holder_name, summary, details } or throws HttpError(400).
function cleanPayout(b, HttpError) {
  const bad = (m) => { throw new HttpError(400, m); };
  const method = String(b.method || '');
  if (!['bank', 'bit', 'bitcoin'].includes(method)) bad('Pick how you want to be paid.');
  const country = String(b.country || '').toUpperCase();
  if (!COUNTRY_SET.has(country)) bad('Pick a country.');
  const holder = String(b.holder_name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!holder) bad('Enter the account holder’s full name.');
  const details = {};

  if (method === 'bank') {
    details.bank_name = String(b.bank_name || '').trim().slice(0, 120);
    if (!details.bank_name) bad('Enter the bank’s name.');
    const format = b.format === 'iban' ? 'iban' : 'account';
    details.format = format;
    const swift = String(b.swift || '').replace(/\s/g, '').toUpperCase();
    if (swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) bad('A SWIFT/BIC code has 8 or 11 letters and numbers, like BOFAUS3N.');
    if (swift) details.swift = swift;
    if (format === 'iban') {
      const iban = String(b.iban || '').replace(/[\s-]/g, '').toUpperCase();
      if (!iban) bad('Enter your IBAN.');
      const err = ibanValid(iban);
      if (err) bad(err);
      if (iban.slice(0, 2) !== country) bad(`That IBAN is from ${regionName.of(iban.slice(0, 2)) || iban.slice(0, 2)}, but you picked ${regionName.of(country)}. Check the country.`);
      details.iban = iban;
      return { method, country, holder_name: holder, details, summary: `IBAN ${iban.slice(0, 2)}•• •••• ${last4(iban)}` };
    }
    const acct = String(b.account_number || '').replace(/[\s-]/g, '');
    if (!/^[A-Za-z0-9]{4,34}$/.test(acct)) bad('Enter the account number (4 to 34 letters or digits).');
    details.account_number = acct;
    if (country === 'US') {
      const routing = String(b.routing_number || '').replace(/\D/g, '');
      if (!routingValid(routing)) bad('Enter the 9-digit routing number. It’s printed at the bottom left of a check.');
      details.routing_number = routing;
      details.account_type = b.account_type === 'savings' ? 'savings' : 'checking';
    } else {
      const code = String(b.bank_code || '').trim().slice(0, 40);
      if (code) details.bank_code = code;
    }
    return { method, country, holder_name: holder, details, summary: `${details.bank_name} •••• ${last4(acct)}` };
  }

  if (method === 'bit') {
    const phone = String(b.bit_phone || '').replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 9 || phone.replace(/\D/g, '').length > 15) bad('Enter the phone number your Bit account uses.');
    details.bit_phone = phone;
    return { method, country, holder_name: holder, details, summary: `Bit •••• ${last4(phone)}` };
  }

  const wallet = String(b.wallet || '').trim();
  if (!/^(bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(wallet)) bad('That doesn’t look like a Bitcoin address. It starts with bc1, 1 or 3.');
  details.wallet = wallet;
  return { method, country, holder_name: holder, details, summary: `Bitcoin ${wallet.slice(0, 6)}…${wallet.slice(-4)}` };
}

// ---------- encryption ----------

// PAYMENT_ENCRYPTION_KEY (any long random string) is preferred. Without it, a random key
// is created once next to the database and kept there.
function loadKeys() {
  const keys = new Map();
  const add = (secret) => {
    const key = crypto.createHash('sha256').update(String(secret)).digest();
    const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
    keys.set(id, key);
    return id;
  };
  let primary = null;
  if (process.env.PAYMENT_ENCRYPTION_KEY) primary = add(process.env.PAYMENT_ENCRYPTION_KEY);
  const envDb = process.env.DB_FILE;
  const dbFile = envDb && envDb !== ':memory:' ? envDb : path.join(__dirname, '..', 'data', 'referrals.db');
  const keyFile = path.join(path.dirname(dbFile), 'payment.key');
  try {
    if (!fs.existsSync(keyFile) && !primary) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    }
    if (fs.existsSync(keyFile)) {
      const id = add(fs.readFileSync(keyFile, 'utf8').trim());
      if (!primary) primary = id;
    }
  } catch (e) {
    if (!primary) primary = add(crypto.randomBytes(32).toString('hex')); // last resort: this run only
    console.error(`Payment key file problem: ${e.message}`);
  }
  return { keys, primary };
}

function mount(app, db, { requireUser, requireRole, wrap, awrap, HttpError, getSettings, logAudit, notify }) {
  const { keys, primary } = loadKeys();

  const encrypt = (obj) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keys.get(primary), iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`;
  };
  const decrypt = (row) => {
    const key = keys.get(row.key_id);
    if (!key) return null;
    try {
      const [iv, tag, data] = row.secret.split('.').map((x) => Buffer.from(x, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
    } catch {
      return null;
    }
  };

  const hasAccess = (u) => u.role === 'admin' || u.role === 'manager' || !!u.payments_enabled;
  const flag = (u) => ({ ...u, payments_enabled: db.prepare('SELECT payments_enabled FROM users WHERE id = ?').get(u.id).payments_enabled });
  const view = (row) => row && {
    method: row.method, country: row.country, country_name: regionName.of(row.country) || row.country,
    holder_name: row.holder_name, summary: row.summary, updated_at: row.updated_at,
  };

  app.get('/api/payments/meta', wrap((req) => {
    requireUser(req);
    return { countries: COUNTRIES };
  }));

  app.get('/api/payments/me', wrap((req) => {
    const u = flag(requireUser(req));
    if (!hasAccess(u)) throw new HttpError(403, 'Payments aren’t switched on for your account. Ask your admin.');
    return { payout: view(db.prepare('SELECT * FROM payout_methods WHERE user_id = ?').get(u.id)) };
  }));

  // Saving needs the user's password, so someone on an unlocked phone can't redirect pay.
  app.put('/api/payments/me', awrap(async (req) => {
    const u = flag(requireUser(req));
    if (!hasAccess(u)) throw new HttpError(403, 'Payments aren’t switched on for your account. Ask your admin.');
    const b = req.body || {};
    const hash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id).password_hash;
    if (!auth.verifyPassword(String(b.password || ''), hash)) throw new HttpError(400, 'Your password is wrong. Enter the password you sign in with.');
    const p = cleanPayout(b, HttpError);
    const before = db.prepare('SELECT summary FROM payout_methods WHERE user_id = ?').get(u.id);
    db.prepare(`INSERT INTO payout_methods (user_id, method, country, holder_name, summary, secret, key_id, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(user_id) DO UPDATE SET method = excluded.method, country = excluded.country, holder_name = excluded.holder_name,
        summary = excluded.summary, secret = excluded.secret, key_id = excluded.key_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(u.id, p.method, p.country, p.holder_name, p.summary, encrypt({ holder_name: p.holder_name, ...p.details }), primary, u.id);
    logAudit(req, before ? 'payment.update' : 'payment.create', 'user', u.id, p.summary);
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").all(u.id)) {
      notify(a.id, null, `${u.full_name} ${before ? 'changed' : 'added'} their payout details (${p.summary})`);
    }
    // Tell the account owner, so a change they didn't make doesn't go unnoticed.
    const settings = getSettings();
    if (u.email && mail.emailConfig(settings).enabled) {
      mail.sendEmail({ to: u.email, ...mail.payoutChangedEmail({ fullName: u.full_name, summary: p.summary }, settings) }, settings)
        .then((r) => { if (!r.ok) console.error(`Payout email to ${u.email} failed: ${r.error}`); });
    }
    return { payout: view(db.prepare('SELECT * FROM payout_methods WHERE user_id = ?').get(u.id)) };
  }));

  app.delete('/api/payments/me', wrap((req) => {
    const u = requireUser(req);
    const hash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id).password_hash;
    if (!auth.verifyPassword(String((req.body || {}).password || ''), hash)) throw new HttpError(400, 'Your password is wrong.');
    db.prepare('DELETE FROM payout_methods WHERE user_id = ?').run(u.id);
    logAudit(req, 'payment.delete', 'user', u.id, '');
    return { ok: true };
  }));

  // ---------- admin ----------

  app.get('/api/payments', wrap((req) => {
    requireRole(req, 'admin');
    return db.prepare(`SELECT u.id, u.full_name, u.username, u.role, u.active, u.payments_enabled, t.name AS team_name,
        p.method, p.country, p.holder_name, p.summary, p.updated_at
      FROM users u LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN payout_methods p ON p.user_id = u.id
      WHERE u.role IN ('admin', 'manager') OR u.payments_enabled = 1 OR p.user_id IS NOT NULL
      ORDER BY u.active DESC, p.updated_at IS NULL, u.full_name`).all()
      .map((r) => ({ ...r, country_name: r.country ? regionName.of(r.country) : '', access: hasAccess(r) }));
  }));

  app.post('/api/payments/:userId/reveal', wrap((req, res) => {
    requireRole(req, 'admin');
    const row = db.prepare(`SELECT p.*, u.full_name FROM payout_methods p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?`).get(Number(req.params.userId));
    if (!row) throw new HttpError(404, 'No payout details saved for this person.');
    const details = decrypt(row);
    if (!details) throw new HttpError(409, 'These details can’t be read: the encryption key changed. Ask them to enter their payout details again.');
    logAudit(req, 'payment.reveal', 'user', row.user_id, `${row.full_name}: ${row.summary}`);
    res.set('Cache-Control', 'no-store');
    return { ...view(row), details };
  }));

  app.patch('/api/users/:id/payments', wrap((req) => {
    requireRole(req, 'admin');
    const target = db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target) throw new HttpError(404, 'User not found.');
    const on = (req.body || {}).enabled ? 1 : 0;
    db.prepare('UPDATE users SET payments_enabled = ? WHERE id = ?').run(on, target.id);
    logAudit(req, on ? 'payment.enable' : 'payment.disable', 'user', target.id, target.full_name);
    return { ok: true };
  }));

  return { hasAccess };
}

module.exports = { mount, cleanPayout, ibanValid, routingValid, COUNTRIES };
