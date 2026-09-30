'use strict';

// Invite links: admin-only creation, role/team fixed by the invite, use limits,
// expiry, revoke, welcome email with the lead-entry guide.

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

async function setup(t) {
  const db = openDb(':memory:');
  const admin = ensureAdmin(db, () => {});
  const server = createApp(db).listen(0);
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
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
  };
  const a = client();
  await a.post('/login', { username: admin.username, password: admin.password });
  await a.post('/me/password', { current: admin.password, next: 'admin-pass-1' });
  const team = (await a.post('/teams', { name: 'North Crew' })).body.id;
  return { db, a, team, client };
}

function fakeResend(t) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) { sent.push(JSON.parse(init.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return real(url, init);
  };
  const key = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test';
  t.after(() => { globalThis.fetch = real; if (key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = key; });
  return sent;
}

const tokenOf = (url) => url.split('#/join/')[1];

test('invite links: admin-only, role and team fixed by the invite, one-time use, sign-in and welcome email', async (t) => {
  const sent = fakeResend(t);
  const { db, a, team, client } = await setup(t);

  // Only admins can create or list invites.
  const mgrPw = (await a.post('/users', { username: 'mgr', full_name: 'Mgr', role: 'manager', team_id: team })).body.temp_password;
  const m = client();
  await m.post('/login', { username: 'mgr', password: mgrPw });
  await m.post('/me/password', { current: mgrPw, next: 'mgr-pass-123' });
  assert.equal((await m.post('/invites', { role: 'rep', team_id: team })).status, 403);
  assert.equal((await m.get('/invites')).status, 403);

  // Validation
  assert.equal((await a.post('/invites', { role: 'rep' })).status, 400, 'reps need a team');
  assert.equal((await a.post('/invites', { role: 'rep', team_id: team, max_uses: 0 })).status, 400);
  assert.equal((await a.post('/invites', { role: 'rep', team_id: team, expires_days: 365 })).status, 400);

  const inv = await a.post('/invites', { role: 'rep', team_id: team, max_uses: 1, expires_days: 7, note: 'Oct hires' });
  assert.equal(inv.status, 201);
  assert.match(inv.body.url, /#\/join\/[A-Za-z0-9_-]{20,}$/);
  const token = tokenOf(inv.body.url);

  // Anyone with the link can look at it (no sign-in needed).
  const anon = client();
  const info = await anon.get(`/join/${token}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.role_label, 'rep');
  assert.equal(info.body.team_name, 'North Crew');
  assert.equal((await anon.get('/join/not-a-real-token')).status, 404);

  // Form validation; a role in the form is ignored.
  assert.equal((await anon.post(`/join/${token}`, { full_name: 'New Rep', username: 'x', email: 'n@x.com', password: 'longenough1' })).status, 400, 'short username');
  assert.equal((await anon.post(`/join/${token}`, { full_name: 'New Rep', username: 'newrep', email: 'n@x.com', password: 'short' })).status, 400);
  assert.equal((await anon.post(`/join/${token}`, { full_name: 'New Rep', username: 'newrep', email: 'n@x.com', password: 'longenough1', password_confirm: 'different1' })).status, 400);
  assert.equal((await anon.post(`/join/${token}`, { full_name: 'New Rep', username: 'mgr', email: 'n@x.com', password: 'longenough1' })).status, 409, 'username taken');

  const joined = await anon.post(`/join/${token}`, {
    full_name: 'New Rep', username: 'NewRep', email: 'New@X.com', phone: '(512) 555-0199',
    password: 'longenough1', password_confirm: 'longenough1', role: 'admin', team_id: 999,
  });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const me = (await anon.get('/me')).body;
  assert.equal(me.username, 'newrep');
  assert.equal(me.role, 'rep', 'role comes from the invite, not the form');
  assert.equal(me.team_name, 'North Crew');
  assert.equal(me.must_change_password, false);
  assert.equal(me.phone, '(512) 555-0199');
  assert.equal(me.email, 'new@x.com');

  // Welcome email: the lead-entry guide, no password.
  const w = sent.find((x) => x.to[0] === 'new@x.com');
  assert.ok(w, 'welcome email sent');
  assert.match(w.subject, /how to enter leads/);
  assert.match(w.text, /ENTERING A LEAD/);
  assert.match(w.text, /Send referral/);
  assert.doesNotMatch(w.text, /longenough1/);

  // One use only; now used up.
  const again = await client().post(`/join/${token}`, { full_name: 'Second', username: 'second', email: 's@x.com', password: 'longenough1' });
  assert.equal(again.status, 410);
  const list = (await a.get('/invites')).body;
  assert.equal(list[0].status, 'used');
  assert.equal(list[0].joined[0].username, 'newrep');

  // Admins are told; the audit log records it.
  const notes = db.prepare("SELECT message FROM notifications WHERE message LIKE '%signed up%'").all();
  assert.ok(notes.length >= 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'invite.join'").get());

  // Multi-use invites and revoke.
  const multi = (await a.post('/invites', { role: 'dispatch', max_uses: 5, expires_days: 1 })).body;
  const t2 = tokenOf(multi.url);
  assert.equal((await client().post(`/join/${t2}`, { full_name: 'Dee', username: 'dee', email: 'dee@x.com', password: 'longenough1' })).status, 201);
  assert.equal((await client().post(`/join/${t2}`, { full_name: 'Dee Two', username: 'dee2', email: 'dee@x.com', password: 'longenough1' })).status, 409, 'email already has an account');
  assert.equal((await a.del(`/invites/${multi.id}`)).status, 200);
  assert.equal((await client().get(`/join/${t2}`)).status, 410);
  assert.equal((await client().post(`/join/${t2}`, { full_name: 'Late', username: 'late', email: 'late@x.com', password: 'longenough1' })).status, 410);

  // Expired links are refused.
  const exp = (await a.post('/invites', { role: 'rep', team_id: team })).body;
  db.prepare("UPDATE invites SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(exp.id);
  assert.equal((await client().get(`/join/${tokenOf(exp.url)}`)).status, 410);
});

test('welcome email for admin-created users includes sign-in details and the lead guide', async (t) => {
  const sent = fakeResend(t);
  const { a, team } = await setup(t);
  const r = await a.post('/users', { username: 'tom', full_name: 'Tom', email: 'tom@x.com', role: 'manager', team_id: team, send_welcome: true });
  assert.equal(r.body.welcome.sent, true);
  const w = sent.find((x) => x.to[0] === 'tom@x.com');
  assert.ok(w.text.includes(r.body.temp_password));
  assert.match(w.text, /ENTERING A LEAD/);
  assert.match(w.text, /As a manager/);
});
