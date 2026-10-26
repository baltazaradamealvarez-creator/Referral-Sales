'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {openDb}=require('../src/db');
const {ensureAdmin}=require('../src/app');
const {stageTiming}=require('../src/lead-stages');
const {executeReportQuery}=require('../src/scheduler');
function fixture(status='Ordered') {
  const db=openDb(':memory:');ensureAdmin(db,()=>{});
  db.prepare('INSERT INTO referrals(id,customer_name,created_by,status,created_at) VALUES(1,?,?,?,?)').run('Test customer',1,status,'2026-01-01 09:00:00');
  return db;
}
function history(db,from,to,at) {
  db.prepare('INSERT INTO status_history(referral_id,user_id,from_status,to_status,created_at) VALUES(1,1,?,?,?)').run(from,to,`2026-01-01 ${at}:00`);
}
test('stage clocks count repeat visits, use audit entries, and stop at closure',()=>{
  const db=fixture();
  history(db,null,'New','09:00');history(db,'New','Working','10:00');history(db,'Working','Passed','11:00');history(db,'Passed','Working','12:00');history(db,'Working','Ordered','13:00');
  const timing=stageTiming(db,db.prepare('SELECT * FROM referrals').get());
  assert.equal(timing.running,false);assert.equal(timing.partial,false);assert.equal(timing.current_minutes,0);
  const working=timing.stages.find(s=>s.status==='Working');assert.equal(working.visits,2);assert.ok(Math.abs(working.minutes-120)<0.001);
  const row=executeReportQuery(db,{role:'admin'},{})[0];
  assert.equal(row.new_minutes,60);assert.equal(row.working_minutes,120);assert.equal(row.passed_minutes,60);assert.equal(row.total_open_minutes,240);
  assert.equal(row.first_ordered_at,'2026-01-01 13:00:00');assert.equal(row.current_stage_started_at,'2026-01-01 13:00:00');assert.equal(row.history_incomplete,0);
  db.close();
});
test('legacy missing history remains unknown, while an initial from-stage is recoverable',()=>{
  const db=fixture('Working');let ref=db.prepare('SELECT * FROM referrals').get();
  let timing=stageTiming(db,ref);assert.equal(timing.partial,true);assert.equal(timing.current_started_at,null);assert.equal(timing.current_minutes,null);
  let row=executeReportQuery(db,{role:'admin'},{})[0];assert.equal(row.working_minutes,null);assert.equal(row.history_incomplete,1);
  history(db,'New','Working','10:00');timing=stageTiming(db,ref);
  assert.equal(timing.partial,false);assert.ok(Math.abs(timing.stages[0].minutes-60)<0.001);assert.equal(timing.running,true);
  db.exec("UPDATE referrals SET status='Passed'");timing=stageTiming(db,db.prepare('SELECT * FROM referrals').get());assert.equal(timing.partial,true);assert.equal(timing.running,false);
  db.close();
});
test('new leads without history use creation time; terminal-only history is flagged partial',()=>{
  const db=fixture('New');let timing=stageTiming(db,db.prepare('SELECT * FROM referrals').get());
  assert.equal(timing.current_started_at,'2026-01-01 09:00:00');assert.equal(timing.running,true);assert.equal(timing.partial,false);
  db.exec("UPDATE referrals SET status='Ordered'");history(db,null,'Ordered','13:00');timing=stageTiming(db,db.prepare('SELECT * FROM referrals').get());
  assert.equal(timing.partial,true);assert.equal(timing.running,false);assert.equal(timing.stages[0].visits,0);
  db.close();
});
test('same-second transitions never create negative durations',()=>{
  const db=fixture();history(db,null,'New','09:00');history(db,'New','Working','09:00');history(db,'Working','Ordered','09:00');
  const timing=stageTiming(db,db.prepare('SELECT * FROM referrals').get());assert.ok(timing.stages.every(s=>s.minutes===0));assert.equal(timing.partial,false);db.close();
});
