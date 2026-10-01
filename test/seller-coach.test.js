'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { zonedToUtc } = require('../src/speed');
const { containsComp } = require('../src/seller-policy');

async function setup(t) {
  const db = openDb(':memory:');
  const admin = ensureAdmin(db,()=>{});
  const wa={sent:[],n:0,handlers:null,error:''};
  const ai={enabled:()=>true,available:()=>true,model:'fake',calls:[],output:{action:'answer',reply:'Enter the customer information on New Referral, then select Send referral.',draft:'',reason:''},
    async coachReply(input){this.calls.push(input);return this.output;},
    async runAgent({system,run}){this.calls.push(system);const stats=await run('team_stats',{period:'today'});assert.equal(stats.commission,undefined);return {text:'Here are your leads.',steps:[]};},
    async answer(){return '';},
  };
  const app=createApp(db,{ai,whatsappTransport:(handlers)=>{
    wa.handlers=handlers;return {async start(){},stop(){},async logout(){},async exists(d){return `${d}@s.whatsapp.net`;},
      async sendText(jid,text){if(wa.error)throw new Error(wa.error);const id=`sent-${++wa.n}`;wa.sent.push({id,jid,text});return id;},async react(){},async listGroups(){return [];}};
  }});
  const server=app.listen(0);await new Promise((r)=>server.once('listening',r));
  t.after(()=>{app.locals.whatsapp.stop();server.close();});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const client=()=>{
    let cookie='';const call=async(method,path,body)=>{
      const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(method!=='GET'?{body:JSON.stringify(body||{})}:{})});
      if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,body:await res.json()};
    };
    return {get:(p)=>call('GET',p),post:(p,b)=>call('POST',p,b),patch:(p,b)=>call('PATCH',p,b)};
  };
  const a=client();await a.post('/login',{username:admin.username,password:admin.password});await a.post('/me/password',{current:admin.password,next:'admin-password-123'});
  const team=(await a.post('/teams',{name:'Sellers'})).body.id;
  let n=0;
  const make=async(role='rep',number)=>{
    const username=`person${++n}`;const u=(await a.post('/users',{username,full_name:`Person ${n}`,role,team_id:team})).body;
    const c=client();await c.post('/login',{username,password:u.temp_password});await c.post('/me/password',{current:u.temp_password,next:'seller-password-123'});
    if(number)await c.patch('/me',{whatsapp:number,whatsapp_alerts:true});
    return {id:u.id,c,u:db.prepare('SELECT * FROM users WHERE id=?').get(u.id)};
  };
  await a.post('/whatsapp/connect');wa.handlers.onOpen({id:'15125550100@s.whatsapp.net'});
  await a.patch('/coach/settings',{enabled:true,knowledge:'Internet: $30 per month for 12 months. Taxes and fees require owner confirmation.'});
  const settle=async()=>{await new Promise((r)=>setTimeout(r,20));await app.locals.whatsapp.drain();};
  return {db,app,a,wa,ai,make,settle};
}

test('coaching cadence: weekdays, inactivity, opt-in, cooldown; manual preview and queued sends',async(t)=>{
  const {db,app,a,wa,make,settle}=await setup(t);
  const inactive=await make('rep','512-555-0191');const recent=await make('rep','512-555-0192');const noAlerts=await make('rep','512-555-0193');
  await noAlerts.c.patch('/me',{whatsapp_alerts:false});const manager=await make('manager','512-555-0194');await make('dispatch','512-555-0195');
  const now=zonedToUtc(2026,10,5,11,'America/Chicago');
  const lead=(await recent.c.post('/referrals',{name:'Jane Smith',phone:'512-867-5309'})).body;
  db.prepare('UPDATE referrals SET created_at=? WHERE id=?').run(new Date(now-3600000).toISOString().slice(0,19).replace('T',' '),lead.id);
  assert.deepEqual(app.locals.coach.tick(zonedToUtc(2026,10,4,11,'America/Chicago')),[],'no Sunday check-ins');
  assert.deepEqual(app.locals.coach.tick(zonedToUtc(2026,10,5,10,'America/Chicago')),[],'not before scheduled time');
  assert.deepEqual(app.locals.coach.tick(now),[inactive.id,manager.id]);
  assert.deepEqual(app.locals.coach.tick(now+60000),[],'no duplicate tick sends');
  await settle();
  assert.ok(wa.sent.some((m)=>m.jid==='15125550191@s.whatsapp.net'&&m.text.includes('Have any customer leads ready?')));
  assert.ok(db.prepare('SELECT last_sent_at FROM coach_contacts WHERE user_id=?').get(inactive.id).last_sent_at);
  t.mock.method(Date,'now',()=>now);
  const preview=await a.get(`/coach/sellers/${recent.id}/preview`);assert.equal(preview.status,200);assert.ok(!containsComp(preview.body.text));
  const sent=await a.post(`/coach/sellers/${recent.id}/checkin`);assert.equal(sent.body.queued,true,'manual can contact a recently active seller');
  assert.equal((await a.post(`/coach/sellers/${recent.id}/checkin`)).status,409,'manual respects cooldown');
  assert.equal((await recent.c.post(`/coach/sellers/${inactive.id}/checkin`)).status,403);
  assert.equal((await a.patch('/coach/settings',{time:'25:00'})).status,400);
  assert.equal((await a.patch('/coach/settings',{knowledge:'Seller commission is $170'})).status,400);
});

test('difficult seller replies are private drafts; only the configured owner can approve; queued is not sent',async(t)=>{
  const {db,app,a,wa,ai,make,settle}=await setup(t);const rep=await make('rep','512-555-0191');const otherAdmin=await make('admin');
  ai.output={action:'review',reply:'',draft:'I’ll confirm availability and current terms before quoting an offer.',reason:'Address eligibility and an exception need verification'};
  const response=await app.locals.coach.handle(rep.u,'Can you guarantee free internet?',{chat:'15125550191@s.whatsapp.net',messageId:'question-1'});
  assert.match(response,/team lead for review/);assert.equal(wa.sent.length,0,'unapproved draft is not sent');
  let drafts=(await a.get('/coach/drafts')).body;assert.equal(drafts.length,1);const id=drafts[0].id;
  assert.equal((await rep.c.get('/coach/drafts')).status,403);
  assert.equal((await otherAdmin.c.post(`/coach/drafts/${id}/review`,{action:'approve'})).status,403);
  assert.equal((await a.post(`/coach/drafts/${id}/review`,{action:'approve',text:'You earn $170 per sale'})).status,400);
  assert.equal(wa.sent.length,0);
  assert.equal((await a.post(`/coach/drafts/${id}/review`,{action:'approve',text:'We can help confirm which offers are available. Please enter the lead for dispatch.'})).body.status,'queued');
  assert.equal((await a.post(`/coach/drafts/${id}/review`,{action:'approve'})).status,409,'no double approval/send');
  await settle();assert.equal(db.prepare('SELECT status FROM coach_drafts WHERE id=?').get(id).status,'sent');
  assert.ok(wa.sent.some((m)=>m.jid==='15125550191@s.whatsapp.net'&&m.text.startsWith('We can help')));
});

test('no compensation context or output; unknown prices need review; STOP is honored',async(t)=>{
  const {db,app,a,wa,ai,make,settle}=await setup(t);const rep=await make('rep','512-555-0191');
  const restricted=await app.locals.coach.handle(rep.u,'How much commission do I get?',{messageId:'comp',chat:'seller'});
  assert.match(restricted,/team lead for review/);assert.equal(ai.calls.length,0,'restricted question is not sent to AI');
  assert.ok(!containsComp(restricted));
  ai.output={action:'answer',reply:'You earn $170 per sale.',draft:'',reason:''};
  const blocked=await app.locals.coach.handle(rep.u,'Tell me something helpful',{chat:'seller',messageId:'unsafe'});
  assert.ok(!containsComp(blocked));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM coach_drafts').get().n,2);
  const rows=(await a.get('/coach/drafts')).body;assert.ok(rows.every((d)=>!containsComp(d.draft)));
  ai.output={action:'answer',reply:'Internet is $99 monthly.',draft:'',reason:''};
  assert.match(await app.locals.coach.handle(rep.u,'What is the price?',{chat:'seller',messageId:'unknown-price'}),/team lead for review/);
  ai.output={action:'answer',reply:'Internet is $30 per month for 12 months. Ask the team lead to confirm taxes and fees.',draft:'',reason:''};
  assert.match(await app.locals.coach.handle(rep.u,'What is the price?',{chat:'seller',messageId:'known-price'}),/\$30/);
  assert.match(await app.locals.coach.handle(rep.u,'STOP'),/won’t receive/);
  assert.equal(db.prepare('SELECT opted_out FROM coach_contacts WHERE user_id=?').get(rep.id).opted_out,1);
  assert.equal((await a.post(`/coach/sellers/${rep.id}/checkin`)).status,409);
  const draft=rows[0];assert.equal((await a.post(`/coach/drafts/${draft.id}/review`,{action:'approve'})).status,409,'no approved replies after STOP');
  await app.locals.coach.handle(rep.u,'START');assert.equal(db.prepare('SELECT opted_out FROM coach_contacts WHERE user_id=?').get(rep.id).opted_out,0);
  await settle();assert.ok(!wa.sent.some((m)=>containsComp(m.text)));
});

test('private WhatsApp seller questions use coach, with a safe acknowledgement and persistent owner review',async(t)=>{
  const {app,a,wa,ai,make,settle}=await setup(t);await make('rep','+52 81 5550 1668');
  ai.output={action:'review',reply:'',draft:'I’ll check that offer with the team lead.',reason:'Discount not in the approved FAQ'};
  await app.locals.whatsapp.receive({id:'dm1',chat:'5218155501668@s.whatsapp.net',isGroup:false,senderPhone:'5218155501668',senderJid:'5218155501668@s.whatsapp.net',text:'Could we make an exception?',ts:Date.now()});
  await settle();
  assert.ok(wa.sent.some((m)=>m.jid==='5218155501668@s.whatsapp.net'&&m.text.includes('team lead for review')));
  assert.equal((await a.get('/coach/drafts')).body.length,1);
  assert.equal((await a.get('/whatsapp/status')).body.diagnostics.last_result,'seller_coach');
});

test('approved send failure stays visible and retryable, never marked sent',async(t)=>{
  const {db,app,a,wa,make,settle}=await setup(t);const rep=await make('rep','512-555-0191');
  await app.locals.coach.handle(rep.u,'Tell me about commissions',{messageId:'failed1',chat:'seller'});
  const draft=(await a.get('/coach/drafts')).body[0];wa.error='Socket dropped';
  await a.post(`/coach/drafts/${draft.id}/review`,{action:'approve'});await settle();
  assert.equal(db.prepare('SELECT status FROM coach_drafts WHERE id=?').get(draft.id).status,'failed');
  assert.match(db.prepare('SELECT error FROM coach_drafts WHERE id=?').get(draft.id).error,/Socket dropped/);
  wa.error='';await a.post(`/coach/drafts/${draft.id}/review`,{action:'approve'});await settle();
  assert.equal(db.prepare('SELECT status FROM coach_drafts WHERE id=?').get(draft.id).status,'sent');
});

test('seller coaching extends existing WhatsApp operations without intercepting lead tools or reminders',async(t)=>{
  const {app,a,wa,ai,make,settle}=await setup(t);
  await make('rep','512-555-0191');
  for (const [id,text] of [['operations-1','bot show my leads'],['operations-2','bot remind me tomorrow to check internet pricing'],['operations-3','bot how did we do this week?']]) {
    await app.locals.whatsapp.receive({id,chat:'15125550191@s.whatsapp.net',isGroup:false,senderPhone:'15125550191',senderJid:'15125550191@s.whatsapp.net',text,ts:Date.now()});
    await settle();
    assert.equal((await a.get('/whatsapp/status')).body.diagnostics.last_result,'assistant');
  }
  assert.equal(ai.calls.length,3,'existing tool-enabled assistant handles operations');
  assert.ok(wa.sent.some((m)=>m.text==='Here are your leads.'));
  await app.locals.whatsapp.receive({id:'pricing-1',chat:'15125550191@s.whatsapp.net',isGroup:false,senderPhone:'15125550191',senderJid:'15125550191@s.whatsapp.net',text:'bot what is the internet price?',ts:Date.now()});
  await settle();
  assert.equal((await a.get('/whatsapp/status')).body.diagnostics.last_result,'seller_coach');
  assert.equal(typeof ai.calls.at(-1),'object','approved pricing uses coaching');
});

test('managers have manual coaching, owner approval, opt-out and existing operations',async(t)=>{
  const {db,app,a,wa,ai,make,settle}=await setup(t);
  const manager=await make('manager','512-555-0194');
  t.mock.method(Date,'now',()=>zonedToUtc(2026,10,5,11,'America/Chicago'));
  const listed=(await a.get('/coach/sellers')).body.find((u)=>u.id===manager.id);
  assert.equal(listed.role,'manager');assert.equal(listed.blocked,'');
  const preview=(await a.get(`/coach/sellers/${manager.id}/preview`)).body;
  assert.match(preview.text,/you and your team/);assert.ok(!containsComp(preview.text));
  assert.equal((await a.post(`/coach/sellers/${manager.id}/checkin`)).body.queued,true);
  await settle();assert.ok(wa.sent.some((m)=>m.jid==='15125550194@s.whatsapp.net'&&m.text.includes('help your sellers')));
  ai.output={action:'review',reply:'',draft:'We will check that offer with the team lead.',reason:'Exception needs review'};
  await app.locals.whatsapp.receive({id:'manager-price',chat:'15125550194@s.whatsapp.net',isGroup:false,senderPhone:'15125550194',senderJid:'15125550194@s.whatsapp.net',text:'Can my team offer a discount?',ts:Date.now()});
  await settle();assert.equal((await a.get('/whatsapp/status')).body.diagnostics.last_result,'seller_coach');
  assert.equal(ai.calls.at(-1).role,'manager');
  const draft=(await a.get('/coach/drafts')).body[0];assert.equal(draft.seller_id,manager.id);
  assert.equal((await manager.c.post(`/coach/drafts/${draft.id}/review`,{action:'approve'})).status,403);
  assert.equal((await a.post(`/coach/drafts/${draft.id}/review`,{action:'approve'})).body.status,'queued');
  await settle();assert.equal(db.prepare('SELECT status FROM coach_drafts WHERE id=?').get(draft.id).status,'sent');
  await app.locals.whatsapp.receive({id:'manager-tools',chat:'15125550194@s.whatsapp.net',isGroup:false,senderPhone:'15125550194',senderJid:'15125550194@s.whatsapp.net',text:'bot show my team leads',ts:Date.now()});
  await settle();assert.equal((await a.get('/whatsapp/status')).body.diagnostics.last_result,'assistant');
  const before=ai.calls.length;await app.locals.coach.handle(manager.u,'What is my commission?');assert.equal(ai.calls.length,before);
  await app.locals.coach.handle(manager.u,'STOP');assert.equal((await a.get(`/coach/sellers/${manager.id}/preview`)).body.blocked,'Seller stopped coaching');
});
