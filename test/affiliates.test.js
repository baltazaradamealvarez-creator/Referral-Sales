'use strict';

// Affiliate program: personal links, sponsor chain, earnings on real sales only,
// reversals, approval of sign-ups, payouts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { parseLevels } = require('../src/affiliates');

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
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p, b) => call('DELETE', p, b) };
  };
  const a = client();
  await a.post('/login', { username: admin.username, password: admin.password });
  await a.post('/me/password', { current: admin.password, next: 'admin-pass-1' });
  const team = (await a.post('/teams', { name: 'North Crew' })).body.id;
  const makeUser = async (username, role = 'rep') => {
    const r = await a.post('/users', { username, full_name: `${username[0].toUpperCase()}${username.slice(1)} Person`, role, team_id: team, password: `${username}-pass-1` });
    const c = client();
    await c.post('/login', { username, password: `${username}-pass-1` });
    await c.post('/me/password', { current: `${username}-pass-1`, next: `${username}-pass-2` });
    return { id: r.body.id, c };
  };
  const join = async (code, username) => {
    const c = client();
    const r = await c.post(`/join-a/${code}`, { full_name: `${username[0].toUpperCase()}${username.slice(1)} Recruit`, username, email: `${username}@x.com`, password: 'longenough1', password_confirm: 'longenough1' });
    return { r, c };
  };
  return { db, a, team, client, makeUser, join };
}

test('levels parse and validate', () => {
  assert.deepEqual(parseLevels('15, 5'), [15, 5]);
  assert.deepEqual(parseLevels('15,5,2,0,0'), [15, 5, 2]);
  assert.equal(parseLevels('60'), null);
  assert.equal(parseLevels('abc'), null);
});

test('affiliate chain: 15% and 5% of the commission on real sales, reversed on cancel, paid out', async (t) => {
  const { db, a, makeUser, join } = await setup(t);
  const ana = await makeUser('ana');

  // Off by default.
  assert.equal((await ana.c.get('/me')).body.affiliate, false);
  assert.equal((await ana.c.get('/affiliate/me')).status, 403);
  assert.equal((await ana.c.patch('/affiliate/settings', { enabled: true })).status, 403, 'admins only');
  assert.equal((await a.patch('/affiliate/settings', { levels: '70' })).status, 400);
  const st = await a.patch('/affiliate/settings', { enabled: true, levels: '15,5', commission: 400, approval: false });
  assert.deepEqual(st.body, { enabled: true, levels: [15, 5], commission: 400, approval: false });

  const me = (await ana.c.get('/affiliate/me')).body;
  assert.match(me.link, /#\/join\/a\/[A-Za-z0-9_-]{8}$/);
  const anaCode = me.code;

  // Ben joins with Ana's link (no approval needed), Cal joins with Ben's.
  const info = await a.get(`/join-a/${anaCode}`);
  assert.equal(info.body.invited_by, 'Ana Person');
  assert.equal((await a.get('/join-a/nope')).status, 404);
  const ben = await join(anaCode, 'ben');
  assert.equal(ben.r.status, 201, JSON.stringify(ben.r.body));
  const benMe = (await ben.c.get('/me')).body;
  assert.equal(benMe.role, 'rep');
  assert.equal(benMe.team_name, 'North Crew');
  const benCode = (await ben.c.get('/affiliate/me')).body.code;
  const cal = await join(benCode, 'cal');
  assert.equal(cal.r.status, 201);
  const ids = Object.fromEntries(db.prepare('SELECT username, id, sponsor_id FROM users').all().map((u) => [u.username, u]));
  assert.equal(ids.ben.sponsor_id, ids.ana.id);
  assert.equal(ids.cal.sponsor_id, ids.ben.id);

  // Signing up earns nothing; only sales do.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM affiliate_earnings').get().n, 0);

  // Cal sells; the order gets the $400 default commission.
  const lead = (await cal.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  await a.patch(`/referrals/${lead.id}`, { status: 'Passed' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM affiliate_earnings').get().n, 0, 'not ordered yet');
  await a.patch(`/referrals/${lead.id}`, { status: 'Ordered' });
  assert.equal(db.prepare('SELECT commission FROM referrals WHERE id = ?').get(lead.id).commission, 400);
  const earned = db.prepare('SELECT earner_id, level, pct, amount, kind FROM affiliate_earnings ORDER BY level').all().map((r) => ({ ...r }));
  assert.deepEqual(earned, [
    { earner_id: ids.ben.id, level: 1, pct: 15, amount: 60, kind: 'sale' },
    { earner_id: ids.ana.id, level: 2, pct: 5, amount: 20, kind: 'sale' },
  ]);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '%You earned $60.00 (15%)%'").get(ids.ben.id));

  // Ana's page: network and earnings, without customer names.
  const anaView = (await ana.c.get('/affiliate/me')).body;
  assert.equal(anaView.stats.owed, 20);
  assert.deepEqual(anaView.stats.by_level, { 1: 1, 2: 1 });
  assert.equal(anaView.direct[0].full_name, 'Ben Recruit');
  assert.equal(anaView.earnings[0].seller_name, 'Cal Recruit');
  assert.ok(!JSON.stringify(anaView).includes('Maria'));

  // Only admins set the commission; a change adjusts earnings.
  assert.equal((await cal.c.patch(`/referrals/${lead.id}`, { commission: 9999 })).status, 403);
  await a.patch(`/referrals/${lead.id}`, { commission: 500 });
  assert.equal((await ben.c.get('/affiliate/me')).body.stats.owed, 75);

  // Admin pays Ben; changing the percentage later doesn't change sales already earned on.
  const pay = await a.post('/affiliate/payouts', { user_id: ids.ben.id, note: 'Zelle' });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.amount, 75);
  assert.equal((await a.post('/affiliate/payouts', { user_id: ids.ben.id })).status, 400, 'nothing owed now');
  await a.patch('/affiliate/settings', { levels: '10,5' });

  // Cancelled after being paid: the money is taken back from the next payout.
  await a.patch(`/referrals/${lead.id}`, { status: 'Cancelled' });
  const benAfter = (await ben.c.get('/affiliate/me')).body;
  assert.equal(benAfter.stats.owed, -75);
  assert.equal(benAfter.stats.paid, 75);
  assert.equal(benAfter.stats.lifetime, 0);
  assert.equal((await ana.c.get('/affiliate/me')).body.stats.owed, 0);

  // Re-ordered: earns again at the percentage locked in for this sale (15%, not 10%).
  await a.patch(`/referrals/${lead.id}`, { status: 'Ordered' });
  assert.equal((await ben.c.get('/affiliate/me')).body.stats.owed, 0);
  assert.equal((await ben.c.get('/affiliate/me')).body.stats.lifetime, 75);

  // Deleting the lead reverses what's unpaid.
  await a.del(`/referrals/${lead.id}`);
  assert.equal((await ana.c.get('/affiliate/me')).body.stats.owed, 0);

  // Admin overview.
  const adm = (await a.get('/affiliate/admin')).body;
  assert.ok(adm.members.find((m) => m.username === 'ben'));
  assert.equal(adm.payouts[0].amount, 75);
});

test('sign-ups can wait for admin approval; admins can set sponsors but not loops', async (t) => {
  const { db, a, makeUser, join } = await setup(t);
  const ana = await makeUser('ana');
  await a.patch('/affiliate/settings', { enabled: true });
  const code = (await ana.c.get('/affiliate/me')).body.code;

  const dee = await join(code, 'dee');
  assert.equal(dee.r.status, 201);
  assert.equal(dee.r.body.pending, true);
  assert.equal((await dee.c.get('/me')).status, 401, 'not signed in yet');
  const login = await dee.c.post('/login', { username: 'dee', password: 'longenough1' });
  assert.equal(login.status, 403);
  assert.match(login.body.error, /waiting for an admin/);
  assert.equal((await a.get('/affiliate/admin')).body.pending[0].sponsor_name, 'Ana Person');

  const deeId = db.prepare("SELECT id FROM users WHERE username = 'dee'").get().id;
  assert.equal((await a.post(`/affiliate/approve/${deeId}`, { approve: true })).status, 200);
  assert.equal((await dee.c.post('/login', { username: 'dee', password: 'longenough1' })).status, 200);

  const eve = await join(code, 'eve');
  const eveId = db.prepare("SELECT id FROM users WHERE username = 'eve'").get().id;
  await a.post(`/affiliate/approve/${eveId}`, { approve: false });
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(eveId), undefined);
  assert.equal(eve.r.status, 201);

  // Existing people: set who recruited whom; no loops.
  const anaId = db.prepare("SELECT id FROM users WHERE username = 'ana'").get().id;
  assert.equal((await a.patch(`/affiliate/sponsor/${anaId}`, { sponsor_id: deeId })).status, 400, 'dee is below ana');
  assert.equal((await a.patch(`/affiliate/sponsor/${anaId}`, { sponsor_id: anaId })).status, 400);
  const fay = await makeUser('fay');
  assert.equal((await a.patch(`/affiliate/sponsor/${fay.id}`, { sponsor_id: deeId })).status, 200);
  assert.equal(db.prepare('SELECT sponsor_id FROM users WHERE id = ?').get(fay.id).sponsor_id, deeId);

  // Program off: links stop working and new sales earn nothing.
  await a.patch('/affiliate/settings', { enabled: false });
  assert.equal((await a.get(`/join-a/${code}`)).status, 404);
});
