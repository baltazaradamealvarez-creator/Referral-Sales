'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const STATUSES = ['New', 'Passed', 'DNQ', 'Ordered', 'Cancelled'];
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
];



function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version || 1;
  for (let v = version + 1; v <= MIGRATIONS.length + 1; v++) {
    // Table rebuilds need foreign keys off (this pragma is ignored inside a transaction).
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        db.exec(MIGRATIONS[v - 2]);
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
