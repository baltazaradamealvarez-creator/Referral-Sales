'use strict';

// Speed to lead (alerts, escalation, auto-reassign, response times), call-back
// reminders, push notifications, and address suggestions.

const test = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { businessMinutes } = require('../src/speed');
const { fromPhoton, fromGeoapify } = require('../src/address');

async function setup(t) {
  const db = openDb(':memory:');
  const admin = ensureAdmin(db, () => {});
  const app = createApp(db);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b) };
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
  const notes = (userId) => db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id').all(userId).map((n) => n.message);
  return { db, app, a, makeUser, notes, adminId: db.prepare("SELECT id FROM users WHERE role = 'admin'").get().id };
}

const at = (iso) => Date.parse(iso);
const back = (db, id, iso) => db.prepare('UPDATE referrals SET created_at = ? WHERE id = ?').run(iso.replace('T', ' ').slice(0, 19), id);

test('working-hours clock', () => {
  const cfg = { hours: [8, 21], tz: 'America/Chicago' };
  assert.equal(businessMinutes(at('2026-09-30T15:00:00Z'), at('2026-09-30T15:20:00Z'), cfg), 20); // 10:00–10:20 CDT
  assert.equal(businessMinutes(at('2026-09-30T04:00:00Z'), at('2026-09-30T13:30:00Z'), cfg), 30); // 11pm → 8:30am
  assert.equal(businessMinutes(at('2026-10-01T01:50:00Z'), at('2026-10-01T13:10:00Z'), cfg), 20); // 8:50pm → 8:10am
  assert.equal(businessMinutes(at('2026-11-01T12:00:00Z'), at('2026-11-02T15:00:00Z'), cfg), 13 * 60 + 60); // Sun 6am CST (after the DST change) → Mon 9am: 13h + 1h
  assert.equal(businessMinutes(0, 90 * 60000), 90);
});

test('speed to lead: alert at 15 min, escalate + reassign at 60, touched leads stop the clock', async (t) => {
  const { db, app, a, makeUser, notes, adminId } = await setup(t);
  const rep = await makeUser('rep', 'rep');
  const d1 = await makeUser('dee', 'dispatch');
  const d2 = await makeUser('dan', 'dispatch');
  assert.equal((await a.patch('/speed/settings', { hours: '0-24', auto_reassign: true, minutes: 15, escalate: 60 })).status, 200);
  assert.equal((await a.patch('/speed/settings', { minutes: 90 })).status, 400, 'escalation must come after the alert');
  assert.equal((await rep.c.patch('/speed/settings', { minutes: 5 })).status, 403);

  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  const other = (await rep.c.post('/referrals', { name: 'Omar Diaz', phone: '512-867-5310' })).body;
  await a.patch(`/referrals/${lead.id}`, { assigned_to: d1.id });
  const now = at('2026-09-30T16:00:00Z');
  back(db, lead.id, '2026-09-30T15:50:00Z');
  back(db, other.id, '2026-09-30T15:50:00Z');

  // 10 minutes: nothing yet.
  assert.deepEqual(app.locals.speed.tick(now).alerted, []);

  // 16 minutes: the assigned dispatcher is alerted; unassigned leads alert every dispatcher.
  const r1 = app.locals.speed.tick(now + 6 * 60000);
  assert.deepEqual(r1.alerted.sort(), [lead.id, other.id].sort());
  assert.ok(notes(d1.id).some((m) => /Maria Lopez has been waiting 16 min/.test(m)));
  assert.ok(!notes(d2.id).some((m) => /Maria Lopez/.test(m)), 'only the assignee for an assigned lead');
  assert.ok(notes(d2.id).some((m) => /Omar Diaz has been waiting/.test(m)));
  assert.deepEqual(app.locals.speed.tick(now + 7 * 60000).alerted, [], 'alerts once');

  // Dan works Omar's lead (a comment counts), which stops its clock.
  await d2.c.post(`/referrals/${other.id}/comments`, { body: 'Left a voicemail' });
  assert.ok(db.prepare('SELECT first_touch_at FROM referrals WHERE id = ?').get(other.id).first_touch_at);

  // 61 minutes: Maria's lead escalates to admins and moves to Dan.
  const r2 = app.locals.speed.tick(now + 51 * 60000);
  assert.deepEqual(r2.escalated, [lead.id]);
  assert.deepEqual(r2.reassigned, [lead.id]);
  assert.equal(db.prepare('SELECT assigned_to FROM referrals WHERE id = ?').get(lead.id).assigned_to, d2.id);
  assert.ok(notes(adminId).some((m) => /no response for 61 min \(assigned to Dee Person\)\. Reassigned to Dan Person/.test(m)));
  assert.ok(notes(d2.id).some((m) => /reassigned to you/.test(m)));

  // A rep's own comment doesn't count as a response; a status change does.
  const third = (await rep.c.post('/referrals', { name: 'Tina Ruiz', phone: '512-867-5311' })).body;
  await rep.c.post(`/referrals/${third.id}/comments`, { body: 'She prefers evenings' });
  assert.equal(db.prepare('SELECT first_touch_at FROM referrals WHERE id = ?').get(third.id).first_touch_at, null);
  await d1.c.patch(`/referrals/${third.id}`, { status: 'Passed' });
  const detail = (await rep.c.get(`/referrals/${third.id}`)).body;
  assert.equal(typeof detail.response_minutes, 'number');
  assert.equal(detail.response_by, 'Dee Person');

  // Dashboard numbers.
  const dash = (await a.get('/dashboard')).body;
  assert.equal(dash.speed.target, 15);
  assert.equal(dash.speed.count, 2);
  assert.equal(dash.speed.waiting[0].customer_name, 'Maria Lopez');
  assert.ok(dash.speed.waiting[0].minutes > 60);

  // Switched off: no more alerts.
  await a.patch('/speed/settings', { enabled: false });
  const fresh = (await rep.c.post('/referrals', { name: 'Ann Lee', phone: '512-867-5312' })).body;
  back(db, fresh.id, '2026-09-30T15:00:00Z');
  assert.deepEqual(app.locals.speed.tick(now + 120 * 60000).alerted, []);
});

test('call-back reminders', async (t) => {
  const { db, app, makeUser, notes } = await setup(t);
  const rep = await makeUser('rep', 'rep');
  const other = await makeUser('otto', 'rep');
  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  assert.equal((await other.c.put(`/referrals/${lead.id}/follow-up`, { at: new Date(Date.now() + 3600e3).toISOString() })).status, 404, 'not their lead');
  assert.equal((await rep.c.put(`/referrals/${lead.id}/follow-up`, { at: '2020-01-01T10:00:00Z' })).status, 400);
  const when = Date.now() + 2 * 3600e3;
  const set = await rep.c.put(`/referrals/${lead.id}/follow-up`, { at: new Date(when).toISOString(), note: 'after 5pm' });
  assert.equal(set.status, 200);
  assert.equal((await rep.c.get('/dashboard')).body.followups[0].follow_up_note, 'after 5pm');
  assert.deepEqual(app.locals.speed.tick(when - 60000).reminders, []);
  assert.deepEqual(app.locals.speed.tick(when + 1000).reminders, [lead.id]);
  assert.ok(notes(rep.id).some((m) => m === '📞 Call back Maria Lopez at (512) 867-5309 now: after 5pm'));
  assert.deepEqual(app.locals.speed.tick(when + 60000).reminders, [], 'once');
  assert.equal((await rep.c.put(`/referrals/${lead.id}/follow-up`, { at: null })).body.follow_up_at, null);
  assert.equal(db.prepare('SELECT follow_up_at FROM referrals WHERE id = ?').get(lead.id).follow_up_at, null);
});

test('push notifications: subscribe, every notification is pushed, dead devices removed', async (t) => {
  const real = webpush.sendNotification;
  const sent = [];
  webpush.sendNotification = async (sub, payload) => {
    if (sub.endpoint.includes('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
    return {};
  };
  t.after(() => { webpush.sendNotification = real; });
  const { db, a, makeUser } = await setup(t);
  const rep = await makeUser('rep', 'rep');
  const key = (await rep.c.get('/push/key')).body;
  assert.match(key.key, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal(key.devices, 0);
  const sub = (endpoint) => ({ subscription: { endpoint, keys: { p256dh: 'BPk', auth: 'aa' } } });
  assert.equal((await rep.c.post('/push/subscribe', sub('http://insecure'))).status, 400);
  await rep.c.post('/push/subscribe', sub('https://push.example.com/phone'));
  await rep.c.post('/push/subscribe', sub('https://push.example.com/gone'));
  assert.equal((await rep.c.get('/push/key')).body.devices, 2);

  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  await a.patch(`/referrals/${lead.id}`, { status: 'Ordered' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, '🎉 Your lead Maria Lopez was Ordered! (Administrator)');
  assert.equal(sent[0].url, `/#/r/${lead.id}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1, 'expired device removed');

  assert.equal((await rep.c.post('/push/test')).status, 200);
  await rep.c.post('/push/unsubscribe', { endpoint: 'https://push.example.com/phone' });
  assert.equal((await rep.c.post('/push/test')).status, 400);
});

test('address suggestions: providers are parsed, cached, and failures never block', async (t) => {
  const photon = { features: [
    { properties: { housenumber: '1010', street: 'Ogden Avenue', city: 'Dallas', state: 'Texas', postcode: '75211', countrycode: 'US' } },
    { properties: { street: 'Ogden Avenue', city: 'Dallas', state: 'Texas', postcode: '75211', countrycode: 'US', type: 'street' } },
    { properties: { housenumber: '1010', street: 'Ogden Ave', city: 'Toronto', state: 'Ontario', countrycode: 'CA' } },
  ] };
  assert.deepEqual(fromPhoton(photon, '1010')[0], { line1: '1010 Ogden Avenue', city: 'Dallas', state: 'TX', zip: '75211' });
  assert.equal(fromPhoton(photon, '1010').length, 2, 'non-US dropped');
  assert.deepEqual(fromGeoapify({ results: [{ housenumber: '12', street: 'Oak Lane', city: 'Austin', state_code: 'TX', postcode: '78701' }] }, ''),
    [{ line1: '12 Oak Lane', city: 'Austin', state: 'TX', zip: '78701' }]);

  const real = globalThis.fetch;
  let calls = 0;
  let fail = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://photon.komoot.io/')) {
      calls++;
      if (fail) throw new Error('down');
      return new Response(JSON.stringify(photon), { status: 200 });
    }
    return real(url, init);
  };
  t.after(() => { globalThis.fetch = real; });
  const { makeUser } = await setup(t);
  const rep = await makeUser('rep', 'rep');
  const r = await rep.c.get('/address/suggest?q=' + encodeURIComponent('1010 ogden ave dallas'));
  assert.equal(r.body.suggestions[0].label, '1010 Ogden Avenue, Dallas, TX 75211');
  await rep.c.get('/address/suggest?q=' + encodeURIComponent('1010 ogden ave dallas'));
  assert.equal(calls, 1, 'cached');
  assert.deepEqual((await rep.c.get('/address/suggest?q=abc')).body.suggestions, [], 'too short: no lookup');
  fail = true;
  const down = await rep.c.get('/address/suggest?q=' + encodeURIComponent('55 elm st austin'));
  assert.equal(down.status, 200);
  assert.equal(down.body.unavailable, true);
});

test('date of birth on leads, WhatsApp settings, and settings never expose the push keys', async (t) => {
  const { a, makeUser } = await setup(t);
  const rep = await makeUser('rep', 'rep');
  const lead = await rep.c.post('/referrals', { text: 'Maria Lopez 512-867-5309\nDOB: 03/14/1985\n123 Main St, Austin TX 78701' });
  assert.equal(lead.status, 201);
  assert.equal(lead.body.dob, '1985-03-14');
  assert.equal((await rep.c.post('/referrals', { name: 'Omar Diaz', phone: '512-867-5310', dob: '02/30/1980' })).status, 400);
  const edited = await rep.c.patch(`/referrals/${lead.body.id}`, { dob: '1985-03-15' });
  assert.equal(edited.body.dob, '1985-03-15');

  await rep.c.get('/push/key'); // makes sure the push keys exist
  const s = (await rep.c.get('/settings')).body;
  assert.match(s.whatsapp_template, /\{dob\}/);
  assert.equal(s.vapid_private, undefined);
  assert.equal(s.vapid_public, undefined);
  assert.equal((await rep.c.patch('/settings', { whatsapp_number: '5125550142' })).status, 403);
  const saved = (await a.patch('/settings', { whatsapp_number: '(512) 555-0142', whatsapp_template: 'Lead {name} {dob}' })).body;
  assert.equal(saved.whatsapp_number, '15125550142');
  assert.equal(saved.whatsapp_template, 'Lead {name} {dob}');
  assert.equal(saved.vapid_private, undefined);
  assert.equal((await a.patch('/settings', { whatsapp_number: '123' })).status, 400);
  assert.match((await a.patch('/settings', { whatsapp_template: '  ' })).body.whatsapp_template, /New referral/, 'empty resets to the default');
});
