'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin, DUPLICATE_MESSAGE } = require('../src/app');

async function setup() {
  const db = openDb(':memory:');
  const admin = ensureAdmin(db, () => {});
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return {
      get: (p) => call('GET', p),
      post: (p, b = {}) => call('POST', p, b),
      patch: (p, b) => call('PATCH', p, b),
      async login(username, password, newPassword) {
        const r = await call('POST', '/login', { username, password });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        if (newPassword) assert.equal((await call('POST', '/me/password', { current: password, next: newPassword })).status, 200);
      },
    };
  };

  const a = client();
  await a.login(admin.username, admin.password, 'admin-pass-1');
  const teamA = (await a.post('/teams', { name: 'Team A' })).body.id;
  const teamB = (await a.post('/teams', { name: 'Team B' })).body.id;

  const mk = async (actor, username, role, team_id) => {
    const r = await actor.post('/users', { username, full_name: username.toUpperCase(), role, team_id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = client();
    await c.login(username, r.body.temp_password, `${username}-pass-1`);
    return { c, id: r.body.id };
  };
  const mgrA = await mk(a, 'mgra', 'manager', teamA);
  const repA = await mk(mgrA.c, 'repa', 'rep', null);
  const repA2 = await mk(mgrA.c, 'repa2', 'rep', null);
  const mgrB = await mk(a, 'mgrb', 'manager', teamB);
  const repB = await mk(mgrB.c, 'repb', 'rep', null);

  return { db, server, client, admin: a, teamA, teamB, mgrA, repA, repA2, mgrB, repB };
}

test('referral flow, duplicates, permissions, comments, stats', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());

  // Temp-password users are locked out until they change it.
  const fresh = await s.mgrA.c.post('/users', { username: 'newbie', full_name: 'Newbie' });
  const nb = s.client();
  await nb.login('newbie', fresh.body.temp_password);
  assert.equal((await nb.get('/referrals')).status, 403);

  // Manager-created users are forced into the manager's team as reps.
  const me = await s.repA.c.get('/me');
  assert.equal(me.body.team_id, s.teamA);
  assert.equal(me.body.role, 'rep');

  // Enter from a free-form blob.
  const r1 = await s.repA.c.post('/referrals', { text: 'Jane Smith\n512-555-0142\njane@email.com\n123 N Main Street Apt 4, Austin TX 78701' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.status, 'New');
  assert.equal(r1.body.phone, '(512) 555-0142');
  assert.equal(r1.body.phone_key, undefined, 'internal keys are not exposed');

  // Duplicates are blocked across teams, by phone, email and address — with a generic message.
  for (const [who, text] of [
    [s.repA2, 'Other Person 5125550142'],
    [s.repB, 'Someone Else JANE@email.com'],
    [s.repB, 'Third Person\n123 North Main St #4\nAustin TX'],
    [s.mgrB, 'Fourth Person\n123 north main st, apt 4, austin tx 78701-0000'],
  ]) {
    const r = await who.c.post('/referrals', { text });
    assert.equal(r.status, 409, text);
    assert.deepEqual(r.body, { error: DUPLICATE_MESSAGE });
  }
  // Different unit is fine.
  assert.equal((await s.repB.c.post('/referrals', { text: 'Neighbor 123 N Main St Apt 5 Austin TX 78701' })).status, 201);

  // Missing contact info
  assert.equal((await s.repA.c.post('/referrals', { text: 'Just A Name' })).status, 400);

  // Visibility: rep A2 and team B cannot see rep A's lead; manager A can.
  const id = r1.body.id;
  assert.equal((await s.repA2.c.get(`/referrals/${id}`)).status, 404);
  assert.equal((await s.mgrB.c.get(`/referrals/${id}`)).status, 404);
  assert.equal((await s.mgrA.c.get(`/referrals/${id}`)).status, 200);
  assert.equal((await s.repB.c.get('/referrals?scope=all')).body.length, 1, 'rep only sees own');
  assert.equal((await s.mgrB.c.get('/referrals?scope=all')).body.length, 1, 'manager limited to team');
  assert.equal((await s.admin.get('/referrals?scope=all')).body.length, 2);

  // Status: only managers.
  assert.equal((await s.repA.c.patch(`/referrals/${id}`, { status: 'Ordered' })).status, 403);
  assert.equal((await s.mgrB.c.patch(`/referrals/${id}`, { status: 'Ordered' })).status, 404);
  const upd = await s.mgrA.c.patch(`/referrals/${id}`, { status: 'Ordered', account_number: '8347-1' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.status, 'Ordered');
  assert.equal((await s.mgrA.c.patch(`/referrals/${id}`, { status: 'Bogus' })).status, 400);

  // Rep can't edit details once it's no longer New.
  assert.equal((await s.repA.c.patch(`/referrals/${id}`, { notes: 'x' })).status, 403);

  // Editing into a duplicate is blocked.
  const other = (await s.repA.c.post('/referrals', { text: 'Bob Jones 469-555-1111' })).body;
  assert.equal((await s.repA.c.patch(`/referrals/${other.id}`, { phone: '(512) 555-0142' })).status, 409);
  assert.equal((await s.repA.c.patch(`/referrals/${other.id}`, { phone: '469 555 2222' })).status, 200);

  // Comments with @mentions: manager A is notified; manager B (can't see the lead) is not.
  const c = await s.repA.c.post(`/referrals/${id}/comments`, { body: '@mgra @mgrb the address does not match' });
  assert.equal(c.status, 201);
  const nA = (await s.mgrA.c.get('/notifications')).body;
  assert.ok(nA.some((n) => n.message.includes('mentioned you')));
  const nB = (await s.mgrB.c.get('/notifications')).body;
  assert.equal(nB.length, 0);
  // Rep A got notified of the status change.
  assert.ok((await s.repA.c.get('/notifications')).body.some((n) => n.message.includes('Ordered')));

  const detail = (await s.repA.c.get(`/referrals/${id}`)).body;
  assert.equal(detail.comments.length, 1);
  assert.equal(detail.history.length, 2);

  // Stats
  const st = (await s.mgrA.c.get('/stats')).body;
  assert.equal(st.team.totals.total, 2);
  assert.equal(st.team.totals.Ordered, 1);
  assert.equal(st.team.users.find((u) => u.username === 'repa').total, 2);
  const adminStats = (await s.admin.get('/stats')).body;
  assert.equal(adminStats.all.total, 3);
  assert.equal(adminStats.teams.length, 2);

  // User management boundaries
  assert.equal((await s.mgrB.c.post(`/users/${s.repA.id}/reset-password`)).status, 404);
  assert.equal((await s.mgrA.c.post(`/users/${s.mgrB.id}/reset-password`)).status, 404);
  assert.equal((await s.repA.c.post('/users', { username: 'x', full_name: 'X' })).status, 403);
  const reset = await s.mgrA.c.post(`/users/${s.repA2.id}/reset-password`);
  assert.equal(reset.status, 200);
  assert.equal((await s.repA2.c.get('/me')).status, 401, 'old sessions are signed out');
  const again = s.client();
  await again.login('repa2', reset.body.temp_password, 'brand-new-pass');

  // Deactivate
  assert.equal((await s.mgrA.c.patch(`/users/${s.repA2.id}`, { active: false })).status, 200);
  assert.equal((await again.get('/me')).status, 401);
  const blocked = await s.client().post('/login', { username: 'repa2', password: 'brand-new-pass' });
  assert.equal(blocked.status, 401);

  // CSRF guard: non-JSON posts are rejected
  const port = s.server.address().port;
  const form = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', body: 'username=a&password=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
});

test('health check and admin-only backup', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const base = `http://127.0.0.1:${s.server.address().port}`;
  assert.equal((await fetch(base + '/healthz')).status, 200);

  await s.repA.c.post('/referrals', { text: 'Backup Person 214-555-3030' });
  assert.equal((await s.repA.c.get('/admin/backup')).status, 403);
  assert.equal((await s.mgrA.c.get('/admin/backup')).status, 403);

  // Fetch raw bytes as admin and open the file as a database.
  const cookie = (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-1' }),
  })).headers.get('set-cookie').split(';')[0];
  const res = await fetch(base + '/api/admin/backup', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /eo-referrals-backup-\d{4}-\d{2}-\d{2}\.db/);
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eo-test-')), 'b.db');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(file);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM referrals').get().n, 1);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 6);
  copy.close();
});
