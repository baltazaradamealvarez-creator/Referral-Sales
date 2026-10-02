'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { quietLead } = require('../public/waformat');
const DISPATCH = '1203630@g.us', QUIET = '1203631@g.us';

async function setup(t, { connected = true, ai } = {}) {
  const db = openDb(':memory:');
  const admin = ensureAdmin(db, () => {});
  const wa = { sent:[], reacts:[], handlers:null };
  const app = createApp(db, { ai, whatsappTransport: handlers => {
    wa.handlers = handlers;
    return { async start() {}, stop() {}, async logout() {}, async exists(d) { return `${d}@s.whatsapp.net`; },
      async sendText(jid,text) { const id = `out-${wa.sent.length + 1}`;wa.sent.push({id,jid,text});return id; },
      async react(jid,id,emoji) { wa.reacts.push({jid,id,emoji}); },
      async listGroups() { return [{id:DISPATCH,name:'Dispatch',size:4},{id:QUIET,name:'Spectrum',size:4}]; } };
  } });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => { app.locals.whatsapp.stop();server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const client = () => {
    let cookie = '';
    const call = async (method,route,body) => {
      const res = await fetch(base + route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body === undefined ? undefined : JSON.stringify(body)});
      if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      return { status:res.status,body:await res.json() };
    };
    return {get:route=>call('GET',route),post:(route,body={})=>call('POST',route,body),patch:(route,body)=>call('PATCH',route,body),delete:route=>call('DELETE',route,{})};
  };
  const a = client();
  assert.equal((await a.post('/login',{username:admin.username,password:admin.password})).status,200);
  assert.equal((await a.post('/me/password',{current:admin.password,next:'admin-pass-1'})).status,200);
  const team = (await a.post('/teams',{name:'North Team'})).body.id;
  const makeUser = async (username,role,phone,teamId=team) => {
    const created = await a.post('/users',{username,full_name:`${username} Person`,role,team_id:role === 'dispatch'?null:teamId,password:`${username}-pass-1`});
    const c = client();await c.post('/login',{username,password:`${username}-pass-1`});
    await c.post('/me/password',{current:`${username}-pass-1`,next:`${username}-pass-2`});
    if (phone) await c.patch('/me',{whatsapp:phone,whatsapp_alerts:false});
    return {id:created.body.id,c};
  };
  await a.post('/whatsapp/connect');
  if (connected) wa.handlers.onOpen({id:'15125550100@s.whatsapp.net',name:'Alerts'});
  await a.patch('/whatsapp/settings',{group_id:DISPATCH,group_name:'Dispatch'});
  const settle = async () => { await new Promise(resolve=>setTimeout(resolve,20));await app.locals.whatsapp.drain(); };
  let n = 0;
  const say = async (text,extras={}) => {
    const result = await app.locals.whatsapp.receive({id:`in-${++n}`,chat:QUIET,isGroup:true,senderJid:'external@lid',senderPhone:null,name:'Spectrum Partner',text,mentions:[],ts:Date.now(),...extras});
    await settle();return result;
  };
  return {db,app,a,wa,makeUser,settle,say};
}

test('quiet lead format contains only the requested customer fields and optional original notes', () => {
  const ref = { id:123, customer_name:'Omeir Curry', phone:'4143967206', address:'3806 N 39th St Miwaukee WI 53209',
    dob:'2000-11-28', email:'curryomeir@gmail.com', services:'Internet, TV', notes:'Internet and cable 80$ package\nWait for call', created_by_name:'Owner', status:'New' };
  const expected = '👤 *Name:* Omeir Curry\n📞 *Phone:* (414) 396-7206\n🏠 *Address:* 3806 N 39th St Miwaukee WI 53209\n🎂 *Date of birth:* 11/28/2000\n✉️ *Email:* curryomeir@gmail.com\n📦 *Services:* Internet, TV';
  assert.equal(quietLead(ref), expected + '\n📝 *Notes:* Internet and cable 80$ package\nWait for call');
  assert.equal(quietLead(ref,{includeNotes:false}), expected);
});

test('additional quiet group posts exact leads and captures external reply threads without messages or status permissions', async t => {
  const {db,app,a,wa,makeUser,settle,say} = await setup(t);
  const seller = await makeUser('seller','rep','15125550142');
  assert.equal((await a.patch('/whatsapp/settings',{quiet_group_id:QUIET,quiet_group_name:'Spectrum',quiet_enabled:true})).status,200);
  await a.patch('/settings',{whatsapp_template:'INTERNAL #{id}\n{name}\n{rep}\n{notes}'});
  const created = await seller.c.post('/referrals',{name:'Maria Lopez',phone:'5128675309',address:'1010 Ogden Ave, Dallas TX 75211',dob:'1985-03-14',email:'maria.lopez@gmail.com',services:['Internet','TV'],notes:'Internet package\nWait for call'});
  assert.equal(created.status,201,JSON.stringify(created.body));const lead=created.body;
  await settle();
  const post = wa.sent.find(message=>message.jid===QUIET);
  assert.equal(post.text,quietLead(lead));
  assert.ok(wa.sent.some(message=>message.jid===DISPATCH && message.text.includes('INTERNAL')),'existing dispatch formatting is preserved');
  assert.equal(db.prepare('SELECT referral_id FROM wa_messages WHERE id=? AND chat=?').get(post.id,QUIET).referral_id,lead.id);
  const count = wa.sent.length;
  assert.equal(await say('approved @owner — install Friday',{id:'external-reply',quotedId:post.id}),'quiet_external_comment');
  assert.equal(await say('Follow-up: call after 5',{quotedId:'external-reply'}),'quiet_external_comment');
  assert.equal(await say('approved @owner — install Friday',{id:'external-reply',quotedId:post.id}),'duplicate');
  for (const text of ['help','bot please answer','hello',`#${lead.id} cancelled`]) await say(text);
  await say('wrong group',{chat:'different@g.us',quotedId:post.id});
  assert.equal(wa.sent.length,count);assert.equal(wa.reacts.length,0);
  const updated = (await a.get(`/referrals/${lead.id}`)).body;
  assert.equal(updated.status,'New');assert.equal(updated.assigned_to,null);
  assert.equal(updated.comments.length,2);
  assert.equal(updated.comments[0].user_id,null);assert.equal(updated.comments[0].full_name,'Spectrum Partner');assert.equal(updated.comments[0].external,1);
  assert.equal(updated.comments[0].body,'approved @owner — install Friday');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE event_type='owner_mention'").get().n,0,'external text cannot trigger owner mention alerts');
  assert.ok((await a.get('/dashboard')).body.activity.some(event=>event.kind==='comment'&&event.actor==='Spectrum Partner'));
  const adminUser=db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
  assert.ok(app.locals.agent.runTool(adminUser,'get_lead',{lead_id:lead.id}).latest_notes.some(note=>note.includes('Spectrum Partner')),'the CRM assistant can read the captured comments with attribution');
  assert.equal(db.prepare("SELECT username FROM audit_logs WHERE action='whatsapp.quiet_reply' LIMIT 1").get().username,'system','external authors do not impersonate an admin');
  assert.equal(app.locals.whatsapp.reply(QUIET,'Any acknowledgment'),false);
  assert.equal(app.locals.whatsapp.react(QUIET,post.id,'✅'),false);
  assert.equal(app.locals.whatsapp.postToGroup('Forced briefing',null,{groupId:QUIET,force:true}),false);
  await settle();assert.equal(wa.sent.length,count);
  assert.equal((await a.delete(`/referrals/${lead.id}`)).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE referral_id=?').get(lead.id).n,0,'external comments participate in record cleanup');
});

test('quiet current group never runs the conversational assistant and preserves recognized CRM permissions', async t => {
  let aiCalls=0;
  const ai={enabled:()=>true,available:()=>true,model:'fixture',async interpretReply(){aiCalls++;throw new Error('Must not interpret quiet replies');},async answer(){aiCalls++;throw new Error('Must not answer in quiet groups');}};
  const {db,app,a,wa,makeUser,settle,say}=await setup(t,{ai});
  const seller=await makeUser('seller','rep','15125550142'),dispatcher=await makeUser('dispatch','dispatch','15125550199');
  await a.patch('/whatsapp/settings',{group_mode:'quiet',quiet_include_notes:false});
  const lead=(await seller.c.post('/referrals',{name:'Carla Vega',phone:'5128675309',notes:'Original note'})).body;
  await settle();const post=wa.sent.find(message=>message.jid===DISPATCH);
  assert.equal(post.text,quietLead(lead,{includeNotes:false}));
  const count=wa.sent.length;
  const sender={chat:DISPATCH,senderJid:'15125550199@s.whatsapp.net',senderPhone:'15125550199',quotedId:post.id};
  await say('Working',sender);await say('approved',sender);
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id=?').get(lead.id).status,'Ordered');
  assert.equal(db.prepare('SELECT assigned_to FROM referrals WHERE id=?').get(lead.id).assigned_to,dispatcher.id);
  await say('@owner call the customer',sender);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE event_type='owner_mention'").get().n,1,'recognized CRM users retain owner mention alerts');
  await say('approved then cancelled?',sender);
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id=?').get(lead.id).status,'Ordered','ambiguous replies become notes without a status guess');
  await say('cancelled',{...sender,senderPhone:'15125550142',senderJid:'15125550142@s.whatsapp.net'});
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id=?').get(lead.id).status,'Ordered','seller cannot change statuses');
  for (const text of ['help','bot how many leads?','please answer','@15125550100 hello']) await say(text,{...sender,quotedId:null,mentions:['15125550100@s.whatsapp.net']});
  assert.equal(wa.sent.length,count);assert.equal(wa.reacts.length,0);assert.equal(aiCalls,0);
  assert.equal((await a.post('/whatsapp/instructions')).status,409);
  assert.equal((await a.post('/whatsapp/test',{target:'group'})).status,409);
  assert.equal((await a.post('/assistant/briefing',{kind:'morning'})).status,409);
  assert.equal((await a.post('/reminders',{text:'Group reminder',at:new Date(Date.now()+3600000).toISOString(),for:'group'})).status,409);
  assert.equal((await a.get('/assistant/settings')).body.group_quiet,true);
  assert.equal(app.locals.whatsapp.postToGroup('A reminder or briefing',null,{force:true}),false);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM comments WHERE referral_id=?").get(lead.id).n>=4);
  // Private assistant chat still responds, using the existing no-key fallback.
  await a.patch('/whatsapp/settings',{ai_enabled:false});ai.enabled=()=>false;
  await say('hello',{isGroup:false,chat:'15125550199@s.whatsapp.net',senderJid:'15125550199@s.whatsapp.net',senderPhone:'15125550199'});
  assert.ok(wa.sent.some(message=>message.jid==='15125550199@s.whatsapp.net'));
});

test('external and out-of-scope replies must quote a lead shared in that exact quiet group', async t => {
  const {db,a,wa,makeUser,settle,say}=await setup(t);
  const seller=await makeUser('seller','rep','15125550142');
  const otherTeam=(await a.post('/teams',{name:'Other Team'})).body.id;
  const outsider=await makeUser('outsider','manager','15125550188',otherTeam);
  const lead=(await seller.c.post('/referrals',{name:'Maria Lopez',phone:'5128675309'})).body;
  await settle();const internalPost=wa.sent.find(message=>message.jid===DISPATCH);
  await a.patch('/whatsapp/settings',{quiet_group_id:QUIET,quiet_group_name:'Spectrum',quiet_enabled:true});
  await say('approved',{quotedId:internalPost.id});
  await say(`#${lead.id} approved`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE referral_id=?').get(lead.id).n,0,'no guessed number or cross-group quote can attach an external comment');
  const shared=(await seller.c.post('/referrals',{name:'Omar Diaz',phone:'5128675310'})).body;
  await settle();const post=wa.sent.find(message=>message.jid===QUIET&&message.text.includes('Omar'));
  await say('approved',{quotedId:post.id,senderPhone:'15125550188',senderJid:'15125550188@s.whatsapp.net',name:'Outsider'});
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id=?').get(shared.id).status,'New');
  assert.equal(db.prepare('SELECT user_id FROM comments WHERE referral_id=?').get(shared.id).user_id,null);
  assert.equal((await outsider.c.get(`/referrals/${shared.id}`)).status,404);
  const before=wa.sent.length;await say(`lead ${shared.id} cancelled`,{senderPhone:'15125550188',senderJid:'15125550188@s.whatsapp.net'});
  assert.equal(wa.sent.length,before);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE referral_id=?').get(shared.id).n,1);
});

test('queued lead posts are not sent to a quiet group after it is paused or removed', async t => {
  for (const remove of [false,true]) {
    const s=await setup(t,{connected:false});
    await s.a.patch('/whatsapp/settings',{quiet_group_id:QUIET,quiet_group_name:'Spectrum',quiet_enabled:true});
    await s.a.post('/referrals',{name:'Maria Lopez',phone:'5128675309'});
    await s.a.patch('/whatsapp/settings',remove?{quiet_group_id:''}:{quiet_enabled:false});
    s.wa.handlers.onOpen({id:'15125550100@s.whatsapp.net'});await s.settle();
    assert.ok(s.wa.sent.some(message=>message.jid===DISPATCH));
    assert.ok(s.wa.sent.every(message=>message.jid!==QUIET));
    assert.equal((await s.a.get('/whatsapp/status')).body.quiet_group.last_lead_post.status,'skipped');
  }
});

test('quiet mode blocks queued non-lead messages and reformats queued lead posts at send time', async t => {
  const {db,app,a,wa,settle}=await setup(t,{connected:false});
  app.locals.whatsapp.reply(DISPATCH,'Queued acknowledgment');
  app.locals.whatsapp.react(DISPATCH,'old-message','✅');
  app.locals.whatsapp.postToGroup('Queued briefing',null,{force:true});
  const lead=(await a.post('/referrals',{name:'Maria Lopez',phone:'5128675309',notes:'Original notes'})).body;
  await a.patch('/whatsapp/settings',{group_mode:'quiet',quiet_include_notes:false});
  wa.handlers.onOpen({id:'15125550100@s.whatsapp.net'});await settle();
  assert.equal(wa.sent.length,1);assert.equal(wa.reacts.length,0);
  assert.equal(wa.sent[0].text,quietLead(lead,{includeNotes:false}));
  assert.equal(db.prepare('SELECT referral_id FROM wa_messages WHERE id=?').get(wa.sent[0].id).referral_id,lead.id);
  assert.equal((await a.get('/whatsapp/status')).body.diagnostics.suppressed,3);
});

test('quiet group controls are admin-only, reject conflicts before mutations, and respect capture and posting switches', async t => {
  const {db,a,wa,makeUser,settle,say}=await setup(t);
  const seller=await makeUser('seller','rep','15125550142');
  assert.equal((await seller.c.patch('/whatsapp/settings',{quiet_enabled:true,quiet_group_id:QUIET})).status,403);
  assert.equal((await a.patch('/whatsapp/settings',{group_mode:'quiet',quiet_group_id:DISPATCH,quiet_enabled:true})).status,400);
  assert.equal((await a.get('/whatsapp/status')).body.group_mode,'interactive','invalid settings do not partially change behavior');
  assert.equal((await a.patch('/whatsapp/settings',{quiet_enabled:true})).status,400);
  await a.patch('/whatsapp/settings',{quiet_group_id:QUIET,quiet_group_name:'Spectrum',quiet_enabled:true,quiet_capture:false});
  const lead=(await seller.c.post('/referrals',{name:'Maria Lopez',phone:'5128675309'})).body;
  await settle();const post=wa.sent.find(message=>message.jid===QUIET);
  assert.equal(await say('Please call',{quotedId:post.id}),'quiet_capture_off');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE referral_id=?').get(lead.id).n,0);
  await a.patch('/whatsapp/settings',{quiet_capture:true});
  assert.equal(await say('Please call',{quotedId:post.id}),'quiet_external_comment');
  await a.patch('/whatsapp/settings',{quiet_enabled:false});
  const count=wa.sent.filter(message=>message.jid===QUIET).length;
  await seller.c.post('/referrals',{name:'Omar Diaz',phone:'5128675310'});await settle();
  assert.equal(wa.sent.filter(message=>message.jid===QUIET).length,count);
  assert.equal(await say('Follow-up after posts paused',{quotedId:post.id}),'quiet_external_comment','pausing new posts does not discard replies to earlier posts');
});

test('v21 preserves existing comments, indexes and group mappings while allowing attributed external authors', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-comment-migration-')),file=path.join(dir,'previous.db');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let db=openDb(file);
  db.exec(`INSERT INTO users(id,username,full_name,password_hash,role) VALUES(1,'owner','Owner','unused','admin');
    INSERT INTO referrals(id,customer_name,created_by) VALUES(1,'Maria Lopez',1);
    CREATE TABLE comments_previous(id INTEGER PRIMARY KEY,referral_id INTEGER NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),source TEXT NOT NULL DEFAULT 'app');
    INSERT INTO comments_previous VALUES(7,1,1,'Keep this note','2026-01-01 12:00:00','whatsapp');
    DROP TABLE comments; ALTER TABLE comments_previous RENAME TO comments;
    CREATE INDEX idx_comments_ref ON comments(referral_id); CREATE INDEX custom_comment_index ON comments(created_at);
    INSERT INTO wa_messages(id,chat,referral_id,kind) VALUES('existing-lead','${DISPATCH}',1,'lead');
    INSERT OR REPLACE INTO settings(key,value) VALUES('wa_group_id','${DISPATCH}'),('wa_new_lead_group','0');
    PRAGMA user_version=20;`);
  const before=db.prepare('SELECT * FROM comments').get();db.close();db=openDb(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,21);
    const after=db.prepare('SELECT * FROM comments WHERE id=7').get();
    for(const field of Object.keys(before))assert.equal(after[field],before[field],field);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='custom_comment_index'").get());
    assert.equal(db.prepare("SELECT referral_id FROM wa_messages WHERE id='existing-lead'").get().referral_id,1);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='wa_new_lead_group'").get().value,'0');
    db.prepare("INSERT INTO comments(referral_id,user_id,body,source,external_author,whatsapp_chat,whatsapp_message_id) VALUES(1,NULL,'Partner reply','whatsapp','Spectrum Partner',?,'incoming-1')").run(QUIET);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n,2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.throws(()=>db.prepare("INSERT INTO comments(referral_id,user_id,body) VALUES(999,NULL,'invalid')").run(),/FOREIGN KEY/);
  } finally {db.close();}
});
