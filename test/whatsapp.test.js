'use strict';

// WhatsApp alerts through a linked phone, with a fake connection standing in for WhatsApp.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { digitsOf } = require('../src/whatsapp');

// A stand-in for the phone link: records messages and lets tests drive connection events.
function fakeWhatsApp() {
  const fake = { sent: [], started: 0, loggedOut: 0, handlers: null, onWhatsApp: new Set(['15125550199', '15125550142']) };
  fake.factory = (handlers) => {
    fake.handlers = handlers;
    return {
      async start() { fake.started++; },
      stop() {},
      async logout() { fake.loggedOut++; },
      async sendText(jid, text) { if (fake.sendError) throw new Error(fake.sendError); fake.sent.push({ jid, text }); return fake.withoutMessageId ? undefined : `out-${fake.sent.length}`; },
      async listGroups() { return [{ id: '1203630@g.us', name: 'Dispatch Team', size: 5 }, { id: '999@g.us', name: 'Family', size: 4 }]; },
      async exists(d) { return fake.onWhatsApp.has(d) ? `${d}@s.whatsapp.net` : null; },
    };
  };
  return fake;
}

async function setup(t) {
  const db = openDb(':memory:');
  const admin = ensureAdmin(db, () => {});
  const wa = fakeWhatsApp();
  const app = createApp(db, { whatsappTransport: wa.factory });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { app.locals.whatsapp.stop(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const client = () => {
    let cookie = '';
    const call = async (method, p, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { base, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
  };
  const a = client();
  await a.post('/login', { username: admin.username, password: admin.password });
  await a.post('/me/password', { current: admin.password, next: 'admin-pass-1' });
  const team = (await a.post('/teams', { name: 'North Crew' })).body.id;
  const makeUser = async (username, role) => {
    const r = await a.post('/users', { username, full_name: `${username[0].toUpperCase()}${username.slice(1)} Person`, role, team_id: role === 'dispatch' ? null : team, password: `${username}-pass-1` });
    const c = client();
    await c.post('/login', { username, password: `${username}-pass-1` });
    await c.post('/me/password', { current: `${username}-pass-1`, next: `${username}-pass-2` });
    return { id: r.body.id, c };
  };
  const settle = async () => { await new Promise((r) => setTimeout(r, 30)); await app.locals.whatsapp.drain(); };
  return { db, app, a, wa, makeUser, settle };
}

test('numbers: US numbers get the country code', () => {
  assert.equal(digitsOf('(512) 555-0142'), '15125550142');
  assert.equal(digitsOf('+52 55 1234 5678'), '525512345678');
  assert.equal(digitsOf('+52 1 55 1234 5678'), '525512345678');
  assert.equal(digitsOf('+51 955 123 456'), '51955123456');
});

test('failed sends and missing recipients are visible in admin diagnostics, and successful sends are counted', async (t) => {
  const { a, wa, app, settle } = await setup(t);
  await a.post('/whatsapp/connect');
  wa.handlers.onOpen({ id: '15125550100@s.whatsapp.net' });
  await a.patch('/whatsapp/settings', { group_id: '1203630@g.us', group_name: 'Dispatch Team', new_lead_group:true });
  wa.sendError = 'Socket closed while sending';
  await a.post('/whatsapp/test', { target: 'group' });
  await settle();
  let dx = (await a.get('/whatsapp/status')).body.diagnostics;
  assert.equal(dx.failed, 1);
  assert.equal(dx.sent, 0);
  assert.match(dx.last_error, /Socket closed/);
  assert.equal(app.locals.whatsapp.queueLength(), 0);
  wa.sendError = '';
  await a.post('/whatsapp/test', { target: 'group' });
  await settle();
  dx = (await a.get('/whatsapp/status')).body.diagnostics;
  assert.equal(dx.sent, 1);
  assert.ok(dx.last_sent_at);
  await a.patch('/me', { whatsapp: '512-555-0111' });
  await a.post('/whatsapp/test-me');
  await settle();
  dx = (await a.get('/whatsapp/status')).body.diagnostics;
  assert.equal(dx.failed, 2);
  assert.match(dx.last_error, /not found on WhatsApp/);
});

test('the lockfile installs on Render (no SSH-only git dependencies)', () => {
  const lock = fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8');
  assert.ok(!lock.includes('git+ssh://'), 'a git+ssh:// URL would make `npm ci` fail without SSH keys');
});

test('dispatch readiness and persistent lead-post outcomes explain skipped, failed and accepted posts', async t => {
  const { a, wa, db, settle } = await setup(t);
  const add = phone => a.post('/referrals', { name: 'Sarah Lopez', phone });
  const off = (await add('5128675309')).body;
  let status = (await a.get('/whatsapp/status')).body;
  assert.equal(status.group_flow.posting_ready, false);
  assert.equal(status.group_flow.last_lead_post.status, 'skipped');
  assert.equal(status.group_flow.last_lead_post.referral_id, off.id);
  assert.match(status.group_flow.last_lead_post.error, /WhatsApp is off/);
  await a.post('/whatsapp/connect');
  wa.handlers.onOpen({ id: '15125550100@s.whatsapp.net' });
  await a.patch('/whatsapp/settings', { group_id: '1203630@g.us', group_name: 'Dispatch Team', new_lead_group: true, two_way: true });
  const sent = (await add('5128675310')).body;
  await settle();status = (await a.get('/whatsapp/status')).body;
  assert.equal(status.group_flow.posting_ready, true);assert.equal(status.group_flow.replies_ready, true);
  assert.equal(status.group_flow.last_lead_post.status, 'sent');
  assert.equal(status.group_flow.last_lead_post.referral_id, sent.id);
  assert.equal(db.prepare("SELECT referral_id FROM wa_messages WHERE id='out-1'").get().referral_id, sent.id);
  wa.sendError = 'Permission denied by group';
  const failed = (await add('5128675311')).body;
  await settle();status = (await a.get('/whatsapp/status')).body;
  assert.equal(status.group_flow.last_lead_post.status, 'failed');
  assert.equal(status.group_flow.last_lead_post.referral_id, failed.id);
  assert.match(status.group_flow.last_lead_post.error, /Permission denied/);
  wa.sendError = '';wa.withoutMessageId = true;
  const uncertain = (await add('5128675312')).body;
  await settle();status = (await a.get('/whatsapp/status')).body;
  assert.equal(status.group_flow.last_lead_post.status, 'unconfirmed');
  assert.equal(status.group_flow.last_lead_post.referral_id, uncertain.id);
  assert.match(status.group_flow.last_lead_post.error, /Check the group before reposting/);
  await a.patch('/whatsapp/settings', { new_lead_group: false });
  await add('5128675313');status = (await a.get('/whatsapp/status')).body;
  assert.equal(status.group_flow.posting_ready, false);assert.equal(status.group_flow.replies_ready, true);
  assert.equal(status.group_flow.last_lead_post.status, 'skipped');
  assert.match(status.group_flow.last_lead_post.error, /switched off/);
  const saved = db.prepare("SELECT value FROM settings WHERE key='wa_last_lead_post'").get().value;
  assert.equal(saved.includes('Sarah'), false);assert.equal(saved.includes('512867'), false);
  const count = wa.sent.length;
  await a.patch('/whatsapp/settings', { new_lead_group: true });await settle();
  assert.equal(wa.sent.length, count, 'enabling posts does not replay previous leads');
});

test('a restart exposes an unconfirmed queued lead post and disconnect reports a pending send as failed', async t => {
  const { a, wa, db, app } = await setup(t);
  await a.post('/whatsapp/connect'); // deliberately do not open the socket
  await a.patch('/whatsapp/settings', { group_id: '1203630@g.us', group_name: 'Dispatch Team', new_lead_group: true });
  const lead = (await a.post('/referrals', { name: 'Sarah Lopez', phone: '5128675310' })).body;
  assert.equal((await a.get('/whatsapp/status')).body.group_flow.last_lead_post.status, 'queued');
  app.locals.whatsapp.stop();
  const rebooted = createApp(db, { whatsappTransport: wa.factory });
  const server = rebooted.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { rebooted.locals.whatsapp.stop();server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-pass-1' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/whatsapp/status', { headers: { Cookie: cookie } });
  const status = await response.json();
  assert.equal(status.group_flow.last_lead_post.referral_id, lead.id);
  assert.equal(status.group_flow.last_lead_post.status, 'interrupted');
  assert.match(status.group_flow.last_lead_post.error, /server restarted/);
  assert.equal(wa.sent.length, 0, 'do not risk duplicate posts on startup');
  await a.post('/whatsapp/disconnect');
  const failed = (await a.get('/whatsapp/status')).body.group_flow.last_lead_post;
  assert.equal(failed.status, 'failed');assert.match(failed.error, /disconnected before/);
});

test('admin links WhatsApp by QR, picks the dispatch group, new leads are posted there', async (t) => {
  const { a, wa, makeUser, settle } = await setup(t);
  const rep = await makeUser('rep', 'rep');
  assert.equal((await rep.c.get('/whatsapp/status')).status, 403);
  assert.equal((await a.get('/whatsapp/status')).body.status, 'off');

  // Connect: the phone link shows a QR code to scan.
  await a.post('/whatsapp/connect');
  assert.equal(wa.started, 1);
  await wa.handlers.onQr('2@abc,def,ghi');
  let s = (await a.get('/whatsapp/status')).body;
  assert.equal(s.status, 'qr');
  assert.match(s.qr, /^data:image\/png;base64,/);
  assert.equal((await a.get('/whatsapp/groups')).status, 409, 'not connected yet');

  // Scanned.
  wa.handlers.onOpen({ id: '15125550100:12@s.whatsapp.net', name: 'E&O Alerts' });
  s = (await a.get('/whatsapp/status')).body;
  assert.equal(s.status, 'connected');
  assert.equal(s.qr, null);
  assert.deepEqual(s.me, { number: '15125550100', lid: '', name: 'E&O Alerts' });

  const groups = (await a.get('/whatsapp/groups')).body;
  assert.deepEqual(groups.map((g) => g.name), ['Dispatch Team', 'Family']);
  assert.equal((await a.patch('/whatsapp/settings', { group_id: 'not-a-group' })).status, 400);
  await a.patch('/whatsapp/settings', { group_id: '1203630@g.us', group_name: 'Dispatch Team', new_lead_group:true });
  await a.post('/whatsapp/test', { target: 'group' });
  await settle();
  assert.equal(wa.sent.length, 1);
  assert.equal(wa.sent[0].jid, '1203630@g.us');
  assert.match(wa.sent[0].text, /connected/);

  // A new lead is posted to the group in the Copy for WhatsApp format.
  const lead = (await rep.c.post('/referrals', { text: 'Maria Lopez 512-867-5309\nDOB: 03/14/1985\n1010 Ogden Ave, Dallas TX 75211' })).body;
  await settle();
  const post = wa.sent[1];
  assert.equal(post.jid, '1203630@g.us');
  assert.match(post.text, new RegExp(`\\*New referral #${lead.id}\\*`));
  assert.match(post.text, /\*Name:\* Maria Lopez/);
  assert.match(post.text, /\*Date of birth:\* 03\/14\/1985/);
  assert.match(post.text, /\*Email:\* —/);
  assert.match(post.text, /\*Rep:\* Rep Person/);

  // Switched off: nothing more is posted.
  await a.patch('/whatsapp/settings', { new_lead_group: false });
  await rep.c.post('/referrals', { name: 'Omar Diaz', phone: '512-867-5310' });
  await settle();
  assert.equal(wa.sent.length, 2);
});

test('only urgent orders go to WhatsApp; dispatchers still get new-lead alerts in the app', async (t) => {
  const { db, a, wa, makeUser, settle } = await setup(t);
  const rep = await makeUser('rep', 'rep');
  const disp = await makeUser('dee', 'dispatch');
  const disp2 = await makeUser('dan', 'dispatch');
  await a.post('/whatsapp/connect');
  wa.handlers.onOpen({ id: '15125550100@s.whatsapp.net' });

  // Profile: number + opt-in.
  assert.equal((await disp.c.patch('/me', { whatsapp_alerts: true })).status, 400, 'needs a number first');
  assert.equal((await disp.c.patch('/me', { whatsapp: '555' })).status, 400);
  await disp.c.patch('/me', { whatsapp: '(512) 555-0199', whatsapp_alerts: true });
  const me = (await disp.c.get('/me')).body;
  assert.equal(me.whatsapp, '+1 (512) 555-0199');
  assert.equal(me.whatsapp_alerts, true);
  assert.equal(me.whatsapp_ready, true);
  await disp2.c.patch('/me', { whatsapp: '(512) 555-0177' }); // number saved, alerts left off

  // A new lead: every dispatcher gets an in-app alert; routine leads do not go to WhatsApp.
  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  await settle();
  for (const d of [disp, disp2]) {
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '🆕 New lead: Maria Lopez%'").get(d.id));
  }
  const toDee = wa.sent.filter((m) => m.jid === '15125550199@s.whatsapp.net');
  assert.equal(toDee.length, 0);
  assert.ok(!wa.sent.some((m) => m.jid.startsWith('15125550177')), 'alerts off: nothing on WhatsApp');

  // Other alerts follow too (here: the lead is ordered → the rep, if opted in).
  await rep.c.patch('/me', { whatsapp: '+1 512 555 0142', whatsapp_alerts: true });
  await a.patch(`/referrals/${lead.id}`, { status: 'Ordered' });
  await settle();
  assert.ok(wa.sent.some((m) => m.jid === '15125550142@s.whatsapp.net' && /was Ordered/.test(m.text)));

  // A number without WhatsApp is skipped quietly.
  wa.onWhatsApp.delete('15125550199');
  await disp.c.patch('/me', { whatsapp: '(512) 555-0111', whatsapp_alerts: true });
  const before = wa.sent.length;
  await rep.c.post('/referrals', { name: 'Omar Diaz', phone: '512-867-5310' });
  await settle();
  assert.ok(!wa.sent.slice(before).some((m) => m.jid.startsWith('15125550111')));

  // Test to yourself.
  assert.equal((await rep.c.post('/whatsapp/test-me')).status, 200);
  await settle();
  assert.match(wa.sent[wa.sent.length - 1].text, /Your E&O Referrals alerts will come here/);

  // Instant new-lead alerts can be switched off.
  await a.patch('/settings', { new_lead_alert: false });
  await rep.c.post('/referrals', { name: 'Ann Lee', phone: '512-867-5312' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE message LIKE '🆕 New lead: Ann Lee%'").get().n, 0);
});

test('messages wait while the link is down; a logged-out phone tells admins to rescan', async (t) => {
  const { db, a, wa, makeUser, settle, app } = await setup(t);
  const rep = await makeUser('rep', 'rep');
  await a.post('/whatsapp/connect');
  wa.handlers.onOpen({ id: '15125550100@s.whatsapp.net' });
  await a.patch('/whatsapp/settings', { group_id: '1203630@g.us', group_name: 'Dispatch Team', new_lead_group:true });

  // Connection drops: the post waits in the queue, and goes out once it's back.
  wa.handlers.onClose({ code: 428, message: 'Connection Closed' });
  assert.equal((await a.get('/whatsapp/status')).body.status, 'reconnecting');
  await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' });
  await settle();
  assert.equal(wa.sent.length, 0);
  assert.equal(app.locals.whatsapp.queueLength(), 1);
  wa.handlers.onOpen({ id: '15125550100@s.whatsapp.net' });
  await settle();
  assert.equal(wa.sent.length, 1);

  // Logged out from the phone: admins are told to scan again.
  wa.handlers.onClose({ code: 401, loggedOut: true, message: 'logged out' });
  assert.equal((await a.get('/whatsapp/status')).body.status, 'logged_out');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE message LIKE '%Scan the QR code again%'").get());

  // Disconnect from the admin side clears everything.
  const off = (await a.post('/whatsapp/disconnect')).body;
  assert.equal(off.enabled, false);
  assert.equal(off.status, 'off');
  assert.ok(wa.loggedOut >= 1);
});

test('WhatsApp numbers for managers and reps: from their profile, from whoever manages them, and at sign-up', async (t) => {
  const { db, a, makeUser } = await setup(t);
  const mgr = await makeUser('mona', 'manager');
  const rep = await makeUser('rep', 'rep');
  const row = (id) => db.prepare('SELECT whatsapp, whatsapp_alerts FROM users WHERE id = ?').get(id);

  // Their own profile: saving a number switches alerts on unless they untick it.
  await rep.c.patch('/me', { whatsapp: '512.555.0142' });
  assert.deepEqual({ ...row(rep.id) }, { whatsapp: '+1 (512) 555-0142', whatsapp_alerts: 1 });
  await rep.c.patch('/me', { whatsapp: '+1 512 555 0142', whatsapp_alerts: false });
  assert.equal(row(rep.id).whatsapp_alerts, 0);

  // Their manager (same team) or an admin can set it for them.
  assert.equal((await mgr.c.patch(`/users/${rep.id}`, { whatsapp: '12' })).status, 400);
  assert.equal((await mgr.c.patch(`/users/${rep.id}`, { whatsapp: '+52 55 1234 5678' })).status, 200);
  assert.deepEqual({ ...row(rep.id) }, { whatsapp: '+525512345678', whatsapp_alerts: 1 });
  const listed = (await mgr.c.get('/users')).body.find((u) => u.id === rep.id);
  assert.equal(listed.whatsapp, '+525512345678');
  assert.equal((await rep.c.patch(`/users/${mgr.id}`, { whatsapp: '5125550100' })).status, 403);
  await a.patch(`/users/${mgr.id}`, { whatsapp: '(512) 555-0100' });
  assert.deepEqual({ ...row(mgr.id) }, { whatsapp: '+1 (512) 555-0100', whatsapp_alerts: 1 });
  await a.patch(`/users/${mgr.id}`, { whatsapp: '' });
  assert.deepEqual({ ...row(mgr.id) }, { whatsapp: '', whatsapp_alerts: 0 });

  // When adding a user.
  const team = db.prepare('SELECT id FROM teams LIMIT 1').get().id;
  const added = await a.post('/users', { username: 'nina', full_name: 'Nina Person', role: 'rep', team_id: team, whatsapp: '512 555 0177' });
  assert.equal(added.status, 201);
  assert.deepEqual({ ...row(added.body.id) }, { whatsapp: '+1 (512) 555-0177', whatsapp_alerts: 1 });

  // At sign-up with an invite link: "it has WhatsApp" uses the mobile number.
  const inv = (await a.post('/invites', { role: 'manager', team_id: team, max_uses: 5 })).body;
  const token = inv.url.split('/join/')[1];
  const join = (body) => fetch(`${a.base}/join/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const base = { full_name: 'Lia Gomez', email: 'lia@x.com', phone: '(512) 555-0188', username: 'lia', password: 'lia-pass-123', password_confirm: 'lia-pass-123' };
  assert.equal((await join({ ...base, phone_whatsapp: true })).status, 201);
  assert.deepEqual({ ...row(db.prepare("SELECT id FROM users WHERE username = 'lia'").get().id) }, { whatsapp: '+1 (512) 555-0188', whatsapp_alerts: 1 });
  assert.equal((await join({ ...base, email: 'leo@x.com', username: 'leo', phone_whatsapp: false })).status, 201);
  assert.deepEqual({ ...row(db.prepare("SELECT id FROM users WHERE username = 'leo'").get().id) }, { whatsapp: '', whatsapp_alerts: 0 });
});
