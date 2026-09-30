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
