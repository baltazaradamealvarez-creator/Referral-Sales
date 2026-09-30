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

test('dispatch role: sees all, assignment, auto-assign, credit, board filters, CSV, duplicate log', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());

  const d1 = await (async () => {
    const r = await s.admin.post('/users', { username: 'disp1', full_name: 'Dee Spatch', role: 'dispatch' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = s.client();
    await c.login('disp1', r.body.temp_password, 'disp1-pass-1');
    return { c, id: r.body.id };
  })();
  const d2 = (await s.admin.post('/users', { username: 'disp2', full_name: 'Dos Patch', role: 'dispatch' })).body;
  // Dispatch can't manage users.
  assert.equal((await d1.c.get('/users')).status, 403);
  assert.equal((await d1.c.post('/users', { username: 'x1', full_name: 'X' })).status, 403);

  // Leads from both teams are visible to dispatch.
  const a = (await s.repA.c.post('/referrals', { text: 'Amy A 512-555-1000' })).body;
  const b = (await s.repB.c.post('/referrals', { text: 'Ben B 512-555-2000 wants tv' })).body;
  assert.deepEqual(b.services, 'TV');
  assert.equal((await d1.c.get('/referrals')).body.length, 2);
  assert.equal((await d1.c.get(`/referrals/${a.id}`)).status, 200);

  // Take it + assign; only dispatch/admin are valid assignees; managers can't assign.
  assert.equal((await d1.c.patch(`/referrals/${a.id}`, { assigned_to: d1.id })).body.assigned_name, 'Dee Spatch');
  assert.equal((await d1.c.patch(`/referrals/${b.id}`, { assigned_to: s.repA.id })).status, 400);
  assert.equal((await s.mgrB.c.patch(`/referrals/${b.id}`, { assigned_to: d1.id })).status, 403);
  assert.equal((await d1.c.patch(`/referrals/${b.id}`, { assigned_to: d2.id })).status, 200);
  assert.equal((await d1.c.get('/referrals?scope=assigned')).body.length, 1);
  assert.equal((await d1.c.get('/referrals?scope=unassigned')).body.length, 0);
  assert.equal((await d1.c.get('/me')).body.queue, 1);

  // Dispatch updates status, account #, install date.
  const upd = await d1.c.patch(`/referrals/${a.id}`, { status: 'Ordered', account_number: 'A-1', install_date: '2026-10-15' });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.install_date, '2026-10-15');
  assert.equal((await d1.c.patch(`/referrals/${a.id}`, { install_date: 'next tues' })).status, 400);

  // Auto-assign: least-busy dispatcher gets new leads.
  assert.equal((await d1.c.patch('/settings', { auto_assign: true })).status, 403);
  assert.equal((await s.admin.patch('/settings', { auto_assign: true, entry_template: 'Name:\nPhone:' })).body.auto_assign, '1');
  assert.equal((await s.repA.c.get('/settings')).body.entry_template, 'Name:\nPhone:');
  const c = (await s.repA.c.post('/referrals', { text: 'Cam C 512-555-3000' })).body;
  assert.equal(c.assigned_to, d1.id, 'd1 has 0 open (a is Ordered), d2 has 1');
  assert.ok((await d1.c.get('/notifications')).body.some((n) => n.message.includes('assigned to you')));
  // Reps can see leads assigned to... no: reps see their own; the assignee can comment and gets notified on comments.
  await s.repA.c.post(`/referrals/${c.id}/comments`, { body: 'is this one ok?' });
  assert.ok((await d1.c.get('/notifications')).body.some((n) => n.message.includes('commented')));

  // Credit to a rep: dispatch enters it for rep B; manager A can only credit own team.
  const cr = await d1.c.post('/referrals', { text: 'Dan D 512-555-4000', credit_to: s.repB.id });
  assert.equal(cr.status, 201);
  assert.equal(cr.body.created_by, s.repB.id);
  assert.equal(cr.body.entered_by, d1.id);
  assert.equal(cr.body.team_id, s.teamB);
  assert.ok((await s.repB.c.get('/notifications')).body.some((n) => n.message.includes('for you')));
  assert.equal((await s.mgrA.c.post('/referrals', { text: 'Eve E 512-555-5000', credit_to: s.repB.id })).status, 400);
  assert.equal((await s.repA.c.post('/referrals', { text: 'Fay F 512-555-6000', credit_to: s.repA2.id })).status, 403);
  const people = (await s.mgrA.c.get('/people')).body;
  assert.ok(people.credit.every((p) => p.team_id === s.teamA));
  assert.equal(people.dispatchers.length, 0);

  // Name is optional now; a contact method is still required.
  const noName = await s.repA.c.post('/referrals', { text: '77 Oak Ave Apt 2, Austin TX 78702' });
  assert.equal(noName.status, 201, JSON.stringify(noName.body));
  assert.equal(noName.body.customer_name, '');

  // Duplicate attempts are logged for dispatch/admin, but the rep still sees only the generic message.
  const dup = await s.repA2.c.post('/referrals', { text: 'Someone 512 555 2000' });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body, { error: DUPLICATE_MESSAGE });
  assert.equal((await s.mgrA.c.get('/duplicates')).status, 403);
  const log = (await d1.c.get('/duplicates')).body;
  assert.equal(log.length, 1);
  assert.equal(log[0].matched_on, 'phone');
  assert.equal(log[0].matched_referral_id, b.id);
  assert.equal(log[0].attempted_by_name, 'REPA2');

  // Board filter: closed leads older than N days are hidden; open ones always show.
  s.db.prepare("UPDATE referrals SET updated_at = datetime('now', '-60 days') WHERE id = ?").run(a.id);
  const board = (await d1.c.get('/referrals?closed_days=30')).body;
  assert.ok(!board.some((r) => r.id === a.id));
  assert.ok(board.some((r) => r.id === b.id));
  assert.equal((await d1.c.get('/referrals?service=TV')).body.length, 1);

  // CSV respects scope and neutralizes spreadsheet formulas.
  await s.repA.c.patch(`/referrals/${noName.body.id}`, { notes: '=HYPERLINK("x")' });
  const port = s.server.address().port;
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'repa', password: 'repa-pass-1' }),
  });
  const csvRes = await fetch(`http://127.0.0.1:${port}/api/referrals.csv`, { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
  const csv = await csvRes.text();
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  assert.ok(!csv.includes('Ben B'), 'rep A export excludes team B');
  assert.ok(csv.includes('Amy A'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));

  // Stats for dispatch include every team and dispatcher workload.
  const st = (await d1.c.get('/stats')).body;
  assert.equal(st.teams.length, 2);
  assert.ok(st.dispatchers.some((x) => x.username === 'disp1' && x.total === 3), JSON.stringify(st.dispatchers));
  assert.ok(st.dispatchers.some((x) => x.username === 'disp2' && x.total === 2), 'auto-assign balances the load');
  assert.equal(st.services.find((x) => x.service === 'TV').total, 1);
});

test('upgrades a database created by the first version without losing data', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { openDb, SCHEMA_V1 } = require('../src/db');
  const auth = require('../src/auth');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eo-mig-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec('PRAGMA foreign_keys = ON;');
  old.exec(SCHEMA_V1);
  old.exec("INSERT INTO teams (name) VALUES ('T')");
  old.prepare("INSERT INTO users (username, full_name, password_hash, role, team_id) VALUES ('boss', 'Boss', ?, 'admin', NULL)")
    .run(auth.hashPassword('pw-12345678'));
  old.prepare("INSERT INTO users (username, full_name, password_hash, role, team_id) VALUES ('r', 'R', ?, 'rep', 1)")
    .run(auth.hashPassword('pw-12345678'));
  old.exec(`INSERT INTO referrals (customer_name, phone, phone_key, created_by, team_id) VALUES ('Old Lead', '(512) 555-0000', '5125550000', 2, 1);
    INSERT INTO comments (referral_id, user_id, body) VALUES (1, 1, 'hi');
    INSERT INTO sessions (token, user_id, expires_at) VALUES ('tok', 2, 9999999999999);`);
  assert.throws(() => old.exec("INSERT INTO users (username, full_name, password_hash, role) VALUES ('d', 'D', 'x', 'dispatch')"));
  old.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  const ref = db.prepare('SELECT * FROM referrals').get();
  assert.equal(ref.customer_name, 'Old Lead');
  assert.equal(ref.assigned_to, null);
  assert.equal(ref.services, '');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  db.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('d', 'D', 'x', 'dispatch')").run();
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // Foreign keys are enforced again after the upgrade.
  assert.throws(() => db.prepare('INSERT INTO comments (referral_id, user_id, body) VALUES (999, 1, ?)').run('x'));
  db.close();

  // Opening again is a no-op.
  const again = openDb(file);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM referrals').get().n, 1);
  again.close();
});
