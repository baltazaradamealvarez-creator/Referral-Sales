'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');

test('Working migration preserves a populated previous-version record, dependent rows, indexes and cleanup drafts', (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'working-migration-'));const file=path.join(dir,'previous.db');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let db=openDb(file);
  db.exec(`INSERT INTO users(id,username,full_name,password_hash,role) VALUES (1,'owner','Owner','unused','admin');
    INSERT INTO referrals(id,customer_name,phone,email,address,created_by,entered_by,assigned_to,status,company,city,zip,alt_phone,services,lead_score,commission,first_touch_at,first_touch_by,follow_up_at,follow_up_note,follow_up_user,dob)
    VALUES (1,'Carla Vega','512-867-5309','carla@example.com','310 Oak Avenue',1,1,1,'Passed','North Office','Austin','78701','512-867-5310','Internet',85,170,'2026-09-30 15:00:00',1,'2026-10-02 15:00:00','Call after lunch',1,'1990-03-12');
    INSERT INTO comments(referral_id,user_id,body,source) VALUES(1,1,'Preserve this note','whatsapp');
    INSERT INTO status_history(referral_id,user_id,from_status,to_status) VALUES(1,1,'New','Passed');
    INSERT INTO wa_messages(id,chat,referral_id) VALUES('message-1','chat',1);
    INSERT INTO reminders(user_id,referral_id,text,due_at,created_by) VALUES(1,1,'Follow up','2026-10-02 15:00:00',1);
    INSERT INTO affiliate_earnings(referral_id,earner_id,seller_id,level,pct,base,amount) VALUES(1,1,1,1,15,170,25.5);
    INSERT INTO coach_drafts(seller_id,reviewer_id,question,draft,reason,status) VALUES(1,1,'Pricing?','Please check the current offer.','Needs review','rejected');`);
  const before=db.prepare('SELECT * FROM referrals WHERE id=1').get();
  const indexes=db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='referrals' AND type='index' AND sql IS NOT NULL ORDER BY name").all();
  // Recreate the exact pre-Working constraint and version, with all modern columns populated.
  const schema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='referrals'").get().sql;
  db.exec('PRAGMA foreign_keys=OFF; BEGIN;');
  db.exec(schema.replace(/CREATE TABLE\s+"?referrals"?/i,'CREATE TABLE previous_referrals').replace("'New','Working','Passed'","'New','Passed'"));
  db.exec('INSERT INTO previous_referrals SELECT * FROM referrals; DROP TABLE referrals; ALTER TABLE previous_referrals RENAME TO referrals;');
  for(const index of indexes)db.exec(index.sql);
  db.exec('ALTER TABLE coach_drafts DROP COLUMN hidden_at; PRAGMA user_version=15; COMMIT; PRAGMA foreign_keys=ON;');
  assert.throws(()=>db.exec("UPDATE referrals SET status='Working' WHERE id=1"),/CHECK constraint/);
  db.close();
  db=openDb(file);
  try {
    assert.deepEqual(db.prepare('SELECT * FROM referrals WHERE id=1').get(),before);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='referrals' AND type='index' AND sql IS NOT NULL ORDER BY name").all(),indexes);
    for(const table of ['comments','status_history','wa_messages','reminders','affiliate_earnings'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE referral_id=1`).get().n,1,table);
    assert.equal(db.prepare('SELECT hidden_at FROM coach_drafts').get().hidden_at,null);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.exec("UPDATE referrals SET status='Working' WHERE id=1");
    assert.equal(db.prepare('SELECT status FROM referrals WHERE id=1').get().status,'Working');
  } finally {db.close();}
});
