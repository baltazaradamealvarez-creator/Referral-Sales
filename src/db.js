'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const STATUSES = ['New', 'Working', 'Passed', 'DNQ', 'Ordered', 'Cancelled'];
const ROLES = ['admin', 'manager', 'dispatch', 'rep'];
const SERVICES = ['Internet', 'TV', 'Mobile', 'Voice'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','rep')),
  team_id INTEGER REFERENCES teams(id),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL DEFAULT '',
  phone_key TEXT NOT NULL DEFAULT '',
  email_key TEXT NOT NULL DEFAULT '',
  address_key TEXT NOT NULL DEFAULT '',
  address_zip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Passed','DNQ','Ordered','Cancelled')),
  account_number TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ref_phone ON referrals(phone_key) WHERE phone_key <> '';
CREATE INDEX IF NOT EXISTS idx_ref_email ON referrals(email_key) WHERE email_key <> '';
CREATE INDEX IF NOT EXISTS idx_ref_addr ON referrals(address_key) WHERE address_key <> '';
CREATE INDEX IF NOT EXISTS idx_ref_team ON referrals(team_id);
CREATE INDEX IF NOT EXISTS idx_ref_creator ON referrals(created_by);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  referral_id INTEGER NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_ref ON comments(referral_id);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY,
  referral_id INTEGER NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_id INTEGER REFERENCES referrals(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
`;

// Upgrades an existing database in place. Each step runs once; PRAGMA user_version
// records how far a database has been upgraded.
const MIGRATIONS = [
  // v2: dispatch role, lead assignment, entered-on-behalf, install date, services,
  // duplicate-attempt log and app settings.
  `
  CREATE TABLE users_new (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','manager','dispatch','rep')),
    team_id INTEGER REFERENCES teams(id),
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO users_new (id, username, full_name, password_hash, role, team_id, active, must_change_password, created_at)
    SELECT id, username, full_name, password_hash, role, team_id, active, must_change_password, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;

  ALTER TABLE referrals ADD COLUMN assigned_to INTEGER REFERENCES users(id);
  ALTER TABLE referrals ADD COLUMN assigned_at TEXT;
  ALTER TABLE referrals ADD COLUMN entered_by INTEGER REFERENCES users(id);
  ALTER TABLE referrals ADD COLUMN install_date TEXT NOT NULL DEFAULT '';
  ALTER TABLE referrals ADD COLUMN services TEXT NOT NULL DEFAULT '';
  CREATE INDEX idx_ref_assigned ON referrals(assigned_to);
  CREATE INDEX idx_ref_status ON referrals(status);

  CREATE TABLE duplicate_attempts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    matched_referral_id INTEGER REFERENCES referrals(id) ON DELETE SET NULL,
    matched_on TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v3: email alerts
  `
  ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN email_alerts INTEGER NOT NULL DEFAULT 1;
  `,
  // v4: account activity, emailed password-reset codes, saved dashboard layouts
  `
  ALTER TABLE users ADD COLUMN last_login_at TEXT;
  ALTER TABLE users ADD COLUMN last_seen_at TEXT;
  ALTER TABLE users ADD COLUMN password_changed_at TEXT;
  ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN dashboard_layout TEXT NOT NULL DEFAULT '';

  CREATE TABLE login_events (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL DEFAULT '',
    success INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_login_user ON login_events(user_id, id);
  CREATE INDEX idx_login_time ON login_events(created_at);

  CREATE TABLE password_resets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_reset_user ON password_resets(user_id, id);
  CREATE INDEX idx_history_ref ON status_history(referral_id);
  CREATE INDEX idx_ref_created ON referrals(created_at);
  `,
  // v5: reports, report schedules, schedule deliveries, saved filters, audit logs, referral state column
  `
  ALTER TABLE referrals ADD COLUMN state TEXT NOT NULL DEFAULT '';
  CREATE INDEX idx_ref_state ON referrals(state);

  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    data_source TEXT NOT NULL DEFAULT 'referrals',
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_public INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE report_schedules (
    id INTEGER PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
    delivery_time TEXT NOT NULL DEFAULT '08:00',
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    day_of_week INTEGER DEFAULT 1,
    day_of_month INTEGER DEFAULT 1,
    recipients TEXT NOT NULL DEFAULT '[]',
    format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'html', 'xlsx')),
    skip_empty INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_run_at TEXT,
    last_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE schedule_deliveries (
    id INTEGER PRIMARY KEY,
    schedule_id INTEGER NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
    report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    run_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL,
    record_count INTEGER NOT NULL DEFAULT 0,
    recipients_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NOT NULL DEFAULT '',
    period_label TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE saved_filters (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    entity TEXT NOT NULL DEFAULT 'referrals',
    filter_config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    details TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_audit_created ON audit_logs(created_at);
  `,
  // v6: rich enterprise contact & account record fields
  `
  ALTER TABLE referrals ADD COLUMN company TEXT NOT NULL DEFAULT '';
  ALTER TABLE referrals ADD COLUMN city TEXT NOT NULL DEFAULT '';
  ALTER TABLE referrals ADD COLUMN zip TEXT NOT NULL DEFAULT '';
  ALTER TABLE referrals ADD COLUMN alt_phone TEXT NOT NULL DEFAULT '';
  ALTER TABLE referrals ADD COLUMN contact_pref TEXT NOT NULL DEFAULT 'Anytime';
  ALTER TABLE referrals ADD COLUMN package_details TEXT NOT NULL DEFAULT '';
  ALTER TABLE referrals ADD COLUMN lead_priority TEXT NOT NULL DEFAULT 'Standard';
  ALTER TABLE referrals ADD COLUMN est_monthly_value REAL NOT NULL DEFAULT 0.0;
  `,
  // v7: invite links for self sign-up
  `
  ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN invite_id INTEGER;

  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','manager','dispatch','rep')),
    team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // v8: emailed invites, past-sales block list, payout details
  `
  CREATE TABLE invite_emails (
    id INTEGER PRIMARY KEY,
    invite_id INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ok INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_invite_emails_invite ON invite_emails(invite_id);

  CREATE TABLE history_imports (
    id INTEGER PRIMARY KEY,
    file_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    rows_read INTEGER NOT NULL DEFAULT 0,
    phones INTEGER NOT NULL DEFAULT 0,
    addresses INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Phones and addresses from past sales: used only to block duplicates, never listed.
  CREATE TABLE history_contacts (
    id INTEGER PRIMARY KEY,
    import_id INTEGER NOT NULL REFERENCES history_imports(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('phone','address')),
    key TEXT NOT NULL,
    zip TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX idx_history_contacts_unique ON history_contacts(import_id, kind, key, zip);
  CREATE INDEX idx_history_contacts_key ON history_contacts(kind, key);

  ALTER TABLE users ADD COLUMN payments_enabled INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE payout_methods (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    method TEXT NOT NULL CHECK (method IN ('bank','bit','bitcoin')),
    country TEXT NOT NULL DEFAULT '',
    holder_name TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    secret TEXT NOT NULL,
    key_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  `,
  // v9: lead quality score (0-100) and the tips behind it
  `
  ALTER TABLE referrals ADD COLUMN lead_score INTEGER;
  ALTER TABLE referrals ADD COLUMN lead_flags TEXT NOT NULL DEFAULT '';
  CREATE INDEX idx_referrals_score ON referrals(lead_score);
  `,
  // v10: affiliate program (sponsors, per-sale commission, earnings ledger, payouts)
  `
  ALTER TABLE users ADD COLUMN sponsor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN affiliate_code TEXT;
  ALTER TABLE users ADD COLUMN approval_pending INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX idx_users_affiliate_code ON users(affiliate_code);
  CREATE INDEX idx_users_sponsor ON users(sponsor_id);
  ALTER TABLE referrals ADD COLUMN commission REAL;

  CREATE TABLE affiliate_payouts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- One row per change: a sale adds, a cancellation or lower commission adds a negative row.
  -- What someone is owed = the sum of their rows not yet in a payout.
  CREATE TABLE affiliate_earnings (
    id INTEGER PRIMARY KEY,
    referral_id INTEGER REFERENCES referrals(id) ON DELETE SET NULL,
    earner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    level INTEGER NOT NULL,
    pct REAL NOT NULL,
    base REAL NOT NULL,
    amount REAL NOT NULL,
    kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','adjustment','reversal')),
    payout_id INTEGER REFERENCES affiliate_payouts(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_aff_earner ON affiliate_earnings(earner_id, payout_id);
  CREATE INDEX idx_aff_referral ON affiliate_earnings(referral_id);
  `,
  // v11: speed to lead, call-back reminders, phone push notifications, date of birth
  `
  ALTER TABLE referrals ADD COLUMN first_touch_at TEXT;
  ALTER TABLE referrals ADD COLUMN first_touch_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE referrals ADD COLUMN sla_alerted_at TEXT;
  ALTER TABLE referrals ADD COLUMN sla_escalated_at TEXT;
  ALTER TABLE referrals ADD COLUMN follow_up_at TEXT;
  ALTER TABLE referrals ADD COLUMN follow_up_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE referrals ADD COLUMN follow_up_user INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE referrals ADD COLUMN follow_up_sent INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE referrals ADD COLUMN dob TEXT NOT NULL DEFAULT '';
  CREATE INDEX idx_referrals_untouched ON referrals(status, first_touch_at);
  CREATE INDEX idx_referrals_follow_up ON referrals(follow_up_sent, follow_up_at);

  -- Leads already worked: their first response is their first status change.
  UPDATE referrals SET first_touch_at = (SELECT MIN(h.created_at) FROM status_history h WHERE h.referral_id = referrals.id AND h.from_status IS NOT NULL);
  -- Don't alert about leads that existed before this feature.
  UPDATE referrals SET sla_alerted_at = datetime('now'), sla_escalated_at = datetime('now');

  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_ok_at TEXT
  );
  CREATE INDEX idx_push_user ON push_subscriptions(user_id);
  `,
  // v12: WhatsApp alerts per person
  `
  ALTER TABLE users ADD COLUMN whatsapp TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN whatsapp_alerts INTEGER NOT NULL DEFAULT 0;
  `,
  // v13: two-way WhatsApp dispatch group (replies become notes and status changes)
  `
  ALTER TABLE comments ADD COLUMN source TEXT NOT NULL DEFAULT 'app';
  -- Messages the app posted, so a reply to one finds its lead.
  CREATE TABLE wa_messages (
    id TEXT PRIMARY KEY,
    chat TEXT NOT NULL,
    referral_id INTEGER REFERENCES referrals(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'lead',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_wa_messages_ref ON wa_messages(referral_id);
  -- Incoming messages already handled (WhatsApp can deliver one twice after a reconnect).
  CREATE TABLE wa_seen (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- WhatsApp ids (phone or privacy id) learned for people, to recognise them in the group.
  CREATE TABLE wa_identities (
    jid TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // v14: reminders (set in the app, or by the assistant on WhatsApp)
  `
  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- who gets it; NULL = the WhatsApp dispatch group
    referral_id INTEGER REFERENCES referrals(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    due_at TEXT NOT NULL,
    repeat TEXT NOT NULL DEFAULT '' CHECK (repeat IN ('', 'daily', 'weekdays', 'weekly')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_reminders_due ON reminders(sent_at, due_at);
  `,
  // v15: paced seller coaching and owner-reviewed replies. No pay or pricing calculations.
  `
  CREATE TABLE coach_contacts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    opted_out INTEGER NOT NULL DEFAULT 0,
    last_checkin_at TEXT,
    last_sent_at TEXT,
    last_error TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE coach_drafts (
    id INTEGER PRIMARY KEY,
    seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    draft TEXT NOT NULL,
    reason TEXT NOT NULL,
    chat TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','sent','rejected','failed')),
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    sent_at TEXT
  );
  CREATE INDEX idx_coach_drafts_status ON coach_drafts(status, created_at);
  CREATE UNIQUE INDEX idx_coach_message ON coach_drafts(chat, message_id) WHERE message_id <> '';
  `,
  // v16: expand the status constraint, retaining every referral column and index.
  (db) => {
    const oldSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='referrals'").get().sql;
    const expanded = oldSql.replace("'New','Passed','DNQ','Ordered','Cancelled'", "'New','Working','Passed','DNQ','Ordered','Cancelled'");
    if (expanded === oldSql) throw new Error('Could not expand the referral status constraint.');
    const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='referrals' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
    db.exec(expanded.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+["`]?referrals["`]?/i, 'CREATE TABLE referrals_next'));
    db.exec('INSERT INTO referrals_next SELECT * FROM referrals; DROP TABLE referrals; ALTER TABLE referrals_next RENAME TO referrals;');
    for (const item of objects) db.exec(item.sql);
  },
  // v17: reversible cleanup of completed coaching drafts.
  `ALTER TABLE coach_drafts ADD COLUMN hidden_at TEXT;`,
  // v18: personal channel preferences, typed notifications and energy attribution.
  `
  ALTER TABLE users ADD COLUMN notification_preferences TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE users ADD COLUMN comparepower_afuid TEXT NOT NULL DEFAULT '';
  ALTER TABLE notifications ADD COLUMN event_type TEXT NOT NULL DEFAULT 'general';
  INSERT INTO settings(key,value) VALUES('wa_new_lead_group','1') ON CONFLICT(key) DO NOTHING;
  `,
  // v19: v18 accidentally disabled dispatch-group lead posts when introducing
  // personal alert preferences. Repair affected installations with a selected
  // group; upgrades from older versions retain their explicit group setting.
  (db, startingVersion) => {
    if (startingVersion !== 18) return;
    db.prepare(`UPDATE settings SET value='1' WHERE key='wa_new_lead_group'
      AND EXISTS(SELECT 1 FROM settings WHERE key='wa_group_id' AND trim(value)<>'')`).run();
  },
  // v20: recover separate location fields from existing, unambiguous saved data.
  (db) => { require('./location-repair').repairLocations(db); },
  // v21: capture external WhatsApp replies without impersonating a CRM account.
  (db) => {
    if (db.prepare('PRAGMA table_info(comments)').all().some(column => column.name === 'external_author')) return;
    const oldSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='comments'").get().sql;
    const nullable = oldSql.replace(/user_id\s+INTEGER\s+NOT NULL/i, 'user_id INTEGER');
    if (nullable === oldSql) throw new Error('Could not expand comment authorship.');
    const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='comments' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
    db.exec(nullable.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+["`]?comments["`]?/i, 'CREATE TABLE comments_next'));
    db.exec('INSERT INTO comments_next SELECT * FROM comments; DROP TABLE comments; ALTER TABLE comments_next RENAME TO comments;');
    for (const item of objects) db.exec(item.sql);
    db.exec(`ALTER TABLE comments ADD COLUMN external_author TEXT NOT NULL DEFAULT '';
      ALTER TABLE comments ADD COLUMN whatsapp_chat TEXT NOT NULL DEFAULT '';
      ALTER TABLE comments ADD COLUMN whatsapp_message_id TEXT NOT NULL DEFAULT '';
      CREATE UNIQUE INDEX idx_comments_whatsapp_message ON comments(whatsapp_chat,whatsapp_message_id) WHERE whatsapp_message_id<>'';`);
  },
];



function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version || 1;
  for (let v = version + 1; v <= MIGRATIONS.length + 1; v++) {
    // Table rebuilds need foreign keys off (this pragma is ignored inside a transaction).
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        const migration = MIGRATIONS[v - 2];
        if (typeof migration === 'function') migration(db, version); else db.exec(migration);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`Migration to v${v} broke foreign keys: ${JSON.stringify(broken)}`);
        db.exec(`PRAGMA user_version = ${v}`);
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function openDb(file) {
  const dbFile = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'referrals.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Runs fn inside a transaction; SQLite serializes writers, so the duplicate
// check + insert cannot interleave with another request's insert.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, tx, STATUSES, ROLES, SERVICES, SCHEMA_V1: SCHEMA };
