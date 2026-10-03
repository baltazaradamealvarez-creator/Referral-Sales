'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');

function fixture(t, version, group) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-group-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'previous.db');
  const db = openDb(file);
  db.exec(`INSERT INTO users(id,username,full_name,password_hash,role) VALUES(1,'owner','Owner','unused','admin');
    INSERT INTO referrals(id,customer_name,created_by,status) VALUES(1,'Carla Vega',1,'Working');
    INSERT INTO wa_messages(id,chat,referral_id,kind) VALUES('existing-post','1203630@g.us',1,'lead');
    INSERT OR REPLACE INTO settings(key,value) VALUES('wa_new_lead_group','0');
    INSERT OR REPLACE INTO settings(key,value) VALUES('wa_enabled','1');
    INSERT OR REPLACE INTO settings(key,value) VALUES('wa_two_way','1');`);
  if (group) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('wa_group_id', group);
  if (version === 17) {
    db.exec('ALTER TABLE users DROP COLUMN notification_preferences; ALTER TABLE users DROP COLUMN comparepower_afuid; ALTER TABLE notifications DROP COLUMN event_type;');
  } else {
    db.prepare('UPDATE users SET notification_preferences=? WHERE id=1').run(JSON.stringify({events:{ordered:{whatsapp:false},owner_mention:{whatsapp:false}}}));
  }
  db.exec(`PRAGMA user_version=${version}`);
  db.close();
  return file;
}

test('v18 upgrade restores the selected dispatch group while preserving personal preferences and old reply mappings', (t) => {
  const file = fixture(t, 18, '1203630@g.us');
  let db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wa_new_lead_group'").get().value, '1');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wa_group_id'").get().value, '1203630@g.us');
  const prefs = JSON.parse(db.prepare('SELECT notification_preferences FROM users WHERE id=1').get().notification_preferences);
  assert.equal(prefs.events.ordered.whatsapp, false);
  assert.equal(prefs.events.owner_mention.whatsapp, false);
  assert.equal(db.prepare("SELECT referral_id FROM wa_messages WHERE id='existing-post'").get().referral_id, 1);
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id=1').get().status, 'Working');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // The one-time repair must not override a subsequent explicit admin choice.
  db.prepare("UPDATE settings SET value='0' WHERE key='wa_new_lead_group'").run();
  db.close();
  db = openDb(file);
  try { assert.equal(db.prepare("SELECT value FROM settings WHERE key='wa_new_lead_group'").get().value, '0'); }
  finally { db.close(); }
});

test('pre-v18 upgrades preserve an existing explicit group opt-out', (t) => {
  const db = openDb(fixture(t, 17, '1203630@g.us'));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='wa_new_lead_group'").get().value, '0');
  } finally { db.close(); }
});

test('v18 repair does not select or connect an unconfigured group', (t) => {
  const db = openDb(fixture(t, 18, ''));
  try {
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='wa_new_lead_group'").get().value, '0');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='wa_group_id'").get(), undefined);
  } finally { db.close(); }
});
