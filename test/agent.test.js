'use strict';

// The assistant's tools (as each role), reminders, the daily briefing, and the chat page,
// with a fake WhatsApp and a fake AI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { zonedToUtc } = require('../src/speed');

const GROUP = '1203630@g.us';

function fakeWhatsApp() {
  const fake = { sent: [], handlers: null, n: 0 };
  fake.factory = (handlers) => {
    fake.handlers = handlers;
    return {
      async start() {}, stop() {}, async logout() {},
      async sendText(jid, text) { const id = `out-${++fake.n}`; fake.sent.push({ id, jid, text }); return id; },
      async react() {},
      async listGroups() { return [{ id: GROUP, name: 'Dispatch', size: 5 }]; },
      async exists(d) { return `${d}@s.whatsapp.net`; },
    };
  };
  return fake;
}

async function setup(t, { ai } = {}) {
  const db = openDb(':memory:');
  const admin = ensureAdmin(db, () => {});
  const wa = fakeWhatsApp();
  const app = createApp(db, { whatsappTransport: wa.factory, ai });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { app.locals.whatsapp.stop(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const client = () => {
    let cookie = '';
    const call = async (method, p, body) => {
      const res = await fetch(base + p, {
        method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), patch: (p, b) => call('PATCH', p, b || {}), del: (p) => call('DELETE', p, {}) };
  };
  const a = client();
  await a.post('/login', { username: admin.username, password: admin.password });
  await a.post('/me/password', { current: admin.password, next: 'admin-pass-1' });
  const north = (await a.post('/teams', { name: 'North Crew' })).body.id;
  const south = (await a.post('/teams', { name: 'South Crew' })).body.id;
  const makeUser = async (username, role, team = north) => {
    const r = await a.post('/users', { username, full_name: `${username[0].toUpperCase()}${username.slice(1)} Person`, role, team_id: role === 'dispatch' ? null : team, password: `${username}-pass-1` });
    const c = client();
    await c.post('/login', { username, password: `${username}-pass-1` });
    await c.post('/me/password', { current: `${username}-pass-1`, next: `${username}-pass-2` });
    return { id: r.body.id, c, u: db.prepare('SELECT * FROM users WHERE id = ?').get(r.body.id) };
  };
  const settle = async () => { await new Promise((r) => setTimeout(r, 20)); await app.locals.whatsapp.drain(); };
  const run = (who, name, input) => app.locals.agent.runTool(who.u, name, input, 'app');
  return { db, app, a, wa, makeUser, settle, run, north, south };
}

test('the assistant\'s tools act as the person asking, with their permissions', async (t) => {
  const { db, makeUser, run, south } = await setup(t);
  const rita = await makeUser('rita', 'rep');
  const sam = await makeUser('sam', 'rep', south);
  const dee = await makeUser('dee', 'dispatch');
  const mia = await makeUser('mia', 'manager');
  db.prepare("INSERT INTO settings (key, value) VALUES ('affiliate_commission', '170')").run();
  const maria = (await rita.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309', address: '1010 Ogden Ave, Dallas TX 75211', dob: '03/14/1985' })).body;
  const omar = (await sam.c.post('/referrals', { name: 'Omar Diaz', phone: '512-867-5310' })).body;

  // Reps see only their own leads; no lead-changing tool at all.
  const mine = run(rita, 'find_leads', {});
  assert.deepEqual(mine.leads.map((l) => l.name), ['Maria Lopez']);
  assert.throws(() => run(rita, 'get_lead', { lead_id: omar.id }), /doesn't exist or you can't see it/);
  assert.throws(() => run(rita, 'update_lead', { lead_id: maria.id, status: 'Ordered' }), /Only a manager or dispatch/);
  // A manager sees their team only.
  assert.deepEqual(run(mia, 'find_leads', { status: ['open'] }).leads.map((l) => l.id), [maria.id]);

  // Dispatch: everything. Details never include contact info.
  const all = run(dee, 'find_leads', { not_called_yet: true });
  assert.equal(all.total, 2);
  assert.equal(all.leads[0].id, maria.id, 'oldest waiting first');
  const detail = run(dee, 'get_lead', { lead_id: maria.id });
  const blob = JSON.stringify(detail);
  for (const secret of ['867-5309', 'Ogden', '1985']) assert.ok(!blob.includes(secret), `no ${secret} in what the AI sees`);
  assert.equal(detail.rep, 'Rita Person');

  const up = run(dee, 'update_lead', { lead_id: maria.id, status: 'Ordered', assign_to: 'me' });
  assert.equal(up.after.status, 'Ordered');
  assert.equal(up.after.assigned_to, 'Dee Person');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '🎉 Your lead Maria Lopez was Ordered!%'").get(rita.id));
  assert.throws(() => run(dee, 'update_lead', { lead_id: omar.id, assign_to: 'Rita' }), /only be assigned to dispatch or admins/);
  assert.throws(() => run(dee, 'find_leads', { assigned: 'Person' }), /could be/);

  run(dee, 'add_note', { lead_id: omar.id, text: 'Left a voicemail, calling back at 4' });
  const note = db.prepare('SELECT body, source, user_id FROM comments WHERE referral_id = ?').get(omar.id);
  assert.deepEqual({ ...note }, { body: 'Left a voicemail, calling back at 4', source: 'assistant', user_id: dee.id });
  assert.ok(!db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '%commented%'").get(sam.id), 'owner not pinged unless asked');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'assistant.update' AND resource_id = ?").get(String(maria.id)));

  // Numbers: orders, commission ($170 default), by rep / closer / team.
  const s = run(dee, 'team_stats', { period: 'today' });
  assert.equal(s.leads_entered, 2);
  assert.equal(s.orders, 1);
  assert.equal(s.commission, 170);
  assert.deepEqual(s.orders_by_rep, [{ name: 'Rita Person', n: 1 }]);
  assert.deepEqual(s.orders_by_closer, [{ name: 'Dee Person', n: 1 }]);
  assert.deepEqual(s.orders_by_team, [{ name: 'North Crew', n: 1 }]);
  assert.equal(run(sam, 'team_stats', { period: 'today' }).orders, 0, 'a rep only counts their own');
  assert.equal(run(dee, 'team_stats', { period: 'yesterday' }).leads_entered, 0);

  const people = run(rita, 'list_people', {}).people.map((p) => p.name);
  assert.ok(people.includes('Dee Person') && !people.includes('Sam Person'), 'reps see dispatch and their own team');
});

test('reminders: for yourself, a teammate or the group; once or repeating; delivered by the minute tick', async (t) => {
  const { db, app, a, wa, makeUser, run, settle } = await setup(t);
  const rita = await makeUser('rita', 'rep');
  const dee = await makeUser('dee', 'dispatch');
  await a.post('/whatsapp/connect');
  wa.handlers.onOpen({ id: '15125550100@s.whatsapp.net' });
  await a.patch('/whatsapp/settings', { group_id: GROUP, group_name: 'Dispatch' });
  const lead = (await rita.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;

  // From the page.
  const soon = new Date(Date.now() + 3600000).toISOString();
  const r1 = await rita.c.post('/reminders', { text: 'Ask Maria about TV', at: soon, referral_id: lead.id });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.for, 'you');
  assert.equal((await rita.c.post('/reminders', { text: 'x', at: soon, for: 'group' })).status, 403, 'reps can\'t post to the group');
  assert.equal((await rita.c.post('/reminders', { text: 'x', at: new Date(Date.now() - 3600000).toISOString() })).status, 400);
  assert.equal((await rita.c.post('/reminders', { text: 'x', at: soon, for: 'Dee' })).status, 403);

  // From the assistant: local time in the business time zone (America/Chicago by default).
  // A Tuesday a week or more ahead, 9:00 local.
  const day = new Date(Date.now() + 7 * 86400000);
  while (day.getUTCDay() !== 2) day.setUTCDate(day.getUTCDate() + 1);
  const ymd = (d, plus = 0) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + plus)); return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()]; };
  const nineAt = (plus) => { const [y, m, d] = ymd(day, plus); return zonedToUtc(y, m, d, 9, 'America/Chicago'); };
  const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const [ty, tm, td] = ymd(day);
  const r2 = run(dee, 'set_reminder', { text: 'Morning huddle', when: `${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')} 09:00`, for: 'group', repeat: 'weekdays' });
  assert.equal(r2.for, 'the WhatsApp group');
  assert.equal(db.prepare('SELECT due_at FROM reminders WHERE id = ?').get(r2.id).due_at, sql(nineAt(0)), '9:00 in Chicago');
  const r3 = run(dee, 'set_reminder', { text: 'Call back Maria', in_minutes: 30, for: 'Rita', lead_id: lead.id });
  assert.equal(r3.for, 'Rita Person');
  assert.deepEqual(run(rita, 'list_reminders', {}).reminders.map((r) => r.text).sort(), ['Ask Maria about TV', 'Call back Maria']);
  assert.throws(() => run(rita, 'cancel_reminder', { id: r2.id }), /can't find reminder/);

  // The tick sends what's due.
  let out = app.locals.agent.tick(Date.now() + 31 * 60000);
  assert.deepEqual(out.reminders, [r3.id]);
  const n = db.prepare('SELECT message, referral_id FROM notifications WHERE user_id = ? ORDER BY id DESC').get(rita.id);
  assert.equal(n.message, '⏰ Reminder: Call back Maria — #' + lead.id + ' Maria Lopez (from Dee Person)');
  assert.equal(n.referral_id, lead.id);
  // Group reminder on Tuesday 9:00 → posted (with the 9:00 morning briefing); next one Wednesday 9:00; Friday's → Monday.
  out = app.locals.agent.tick(nineAt(0));
  assert.ok(out.reminders.includes(r2.id));
  await settle();
  assert.ok(wa.sent.some((m) => m.jid === GROUP && m.text === '⏰ Reminder: Morning huddle (from Dee Person)'));
  assert.ok(wa.sent.some((m) => m.jid === GROUP && /^☀️ \*Good morning/.test(m.text)), 'the default 9:00 briefing went out too');
  assert.equal(db.prepare('SELECT due_at FROM reminders WHERE id = ?').get(r2.id).due_at, sql(nineAt(1)));
  db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(sql(nineAt(3)), r2.id);
  app.locals.agent.tick(nineAt(3));
  assert.equal(db.prepare('SELECT due_at FROM reminders WHERE id = ?').get(r2.id).due_at, sql(nineAt(6)));

  // Delivered ones are gone from the list; pending ones can be cancelled.
  assert.equal((await rita.c.del(`/reminders/${r1.body.id}`)).status, 404, 'already sent');
  const r4 = await rita.c.post('/reminders', { text: 'Weekly review', at: soon, repeat: 'weekly' });
  assert.deepEqual((await rita.c.get('/reminders')).body.map((r) => r.text), ['Weekly review']);
  assert.equal((await rita.c.del(`/reminders/${r4.body.id}`)).status, 200);
  assert.equal((await rita.c.get('/reminders')).body.length, 0);
});

test('the daily briefing: numbers in English and Spanish, posted once at its time', async (t) => {
  const { db, app, a, wa, makeUser, settle } = await setup(t);
  const rita = await makeUser('rita', 'rep');
  await makeUser('dee', 'dispatch');
  db.prepare("INSERT INTO settings (key, value) VALUES ('affiliate_commission', '170')").run();
  const l1 = (await rita.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  await rita.c.post('/referrals', { name: 'Omar Diaz', phone: '512-867-5310' });
  await a.patch(`/referrals/${l1.id}`, { status: 'Ordered' });

  const evening = (await a.get('/assistant/briefing?kind=evening')).body.text;
  assert.match(evening, /End of day · Cierre del día/);
  assert.match(evening, /\*Today · Hoy:\* 2 leads · 1 order 🎉 · \$170/);
  assert.match(evening, /🏆 Reps: Rita 1/);
  assert.match(evening, /Not called yet · Sin llamar:\* 1/);
  assert.match(evening, /Omar Diaz/);
  assert.equal((await rita.c.get('/assistant/briefing')).status, 403);

  // Posted by the tick at its time (once), only with WhatsApp linked to a group.
  await a.patch('/assistant/settings', { briefing_time: '', recap_time: '' });
  const now = Date.now();
  const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(now - 5 * 60000));
  assert.equal((await a.patch('/assistant/settings', { briefing_time: '25:00' })).status, 400);
  await a.patch('/assistant/settings', { briefing_time: local });
  assert.deepEqual(app.locals.agent.tick(now).briefings, [], 'not without a group');
  await a.post('/whatsapp/connect');
  wa.handlers.onOpen({ id: '15125550100@s.whatsapp.net' });
  await a.patch('/whatsapp/settings', { group_id: GROUP, group_name: 'Dispatch' });
  assert.deepEqual(app.locals.agent.tick(now).briefings, ['morning']);
  assert.deepEqual(app.locals.agent.tick(now + 60000).briefings, [], 'once a day');
  await settle();
  assert.ok(wa.sent.some((m) => m.jid === GROUP && /Good morning · Buenos días/.test(m.text)));
});

test('the Assistant page: chat goes through the AI with the tools; admins set what it knows', async (t) => {
  const seen = [];
  const ai = {
    model: 'claude-haiku-4-5-20251001',
    enabled: () => true,
    available: () => true,
    async interpretReply() { return { status: 'none', sure: true, question: '', notify_owner: false, language: 'en' }; },
    async answer() { return ''; },
    async runAgent({ system, messages, run }) {
      seen.push({ system, messages });
      const r = await run('set_reminder', { text: 'Check open leads', in_minutes: 60 });
      return { text: `✅ I'll remind you ${r.due}.`, steps: [{ name: 'set_reminder', ok: true }] };
    },
  };
  const { a, makeUser } = await setup(t, { ai });
  const rita = await makeUser('rita', 'rep');
  await a.patch('/assistant/settings', { brief: 'We sell Spectrum in Texas. Promo: $30 internet for 12 months.' });
  assert.equal((await rita.c.patch('/assistant/settings', { brief: 'x' })).status, 403);

  const r = await rita.c.post('/assistant/chat', { messages: [{ role: 'user', content: 'remind me in an hour to check open leads' }] });
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /I'll remind you/);
  assert.deepEqual(r.body.actions, ['set_reminder']);
  assert.match(seen[0].system, /Promo: \$30 internet/);
  assert.match(seen[0].system, /Rita Person, rep on team North Crew/);
  assert.match(seen[0].system, /Local time: \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(America\/Chicago\)/);
  assert.equal((await rita.c.get('/assistant')).body.reminders.length, 1);
  assert.equal((await rita.c.post('/assistant/chat', { messages: [] })).status, 400);
});

test('without an API key the chat is off but reminders work', async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (key !== undefined) process.env.ANTHROPIC_API_KEY = key; });
  const { a, makeUser } = await setup(t);
  const rita = await makeUser('rita', 'rep');
  const info = (await rita.c.get('/assistant')).body;
  assert.equal(info.ai, false);
  assert.equal((await rita.c.post('/assistant/chat', { messages: [{ role: 'user', content: 'hi' }] })).status, 503);
  assert.equal((await rita.c.post('/reminders', { text: 'x', at: new Date(Date.now() + 60000).toISOString() })).status, 201);
  const s = (await a.get('/assistant/settings')).body;
  assert.equal(s.available, false);
  assert.equal(s.model, 'claude-haiku-4-5-20251001');
  assert.match(s.brief, /E&O Spectrum Referrals/);
});
