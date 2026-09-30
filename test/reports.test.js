'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { resolveRelativeDates, computeNextRun } = require('../src/scheduler');

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
      delete: (p) => call('DELETE', p),
      getCookie: () => cookie,
      async login(username, password, newPassword) {
        const r = await call('POST', '/login', { username, password });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        if (newPassword) assert.equal((await call('POST', '/me/password', { current: password, next: newPassword })).status, 200);
      },
    };
  };

  const a = client();
  await a.login(admin.username, admin.password, 'admin-pass-1');
  return { db, server, client, admin: a };
}

test('relative date resolution and next run calculations', () => {
  const res = resolveRelativeDates('today', '2026-10-15');
  assert.equal(res.from, '2026-10-15');
  assert.equal(res.to, '2026-10-15');

  const month = resolveRelativeDates('this_month', '2026-10-15');
  assert.equal(month.from, '2026-10-01');

  const qtd = resolveRelativeDates('qtd', '2026-10-15');
  assert.equal(qtd.from, '2026-10-01');

  const nextDaily = computeNextRun('daily', '09:00', 1, 1, new Date('2026-10-15T08:00:00Z'));
  assert.ok(nextDaily.startsWith('2026-10-15 09:00:00'));
});

test('custom report builder CRUD, execution, grouping, CSV export, and scheduling', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());

  // Insert test referrals
  await s.admin.post('/referrals', { text: 'Alice Smith\n512-555-9000\n100 Main St, Austin TX 78701\nServices: Internet, TV' });
  await s.admin.post('/referrals', { text: 'Bob Jones\n512-555-9001\n200 Oak St, Dallas TX 75201\nServices: Mobile' });

  // Create a custom report
  const reportRes = await s.admin.post('/reports', {
    name: 'Texas Sales Performance',
    description: 'Leads from Texas grouped by status',
    is_public: true,
    config: {
      data_source: 'referrals',
      group_by: 'status',
      columns: ['id', 'customer_name', 'phone', 'state', 'status'],
      filters: [{ field: 'state', value: 'TX' }],
    },
  });

  assert.equal(reportRes.status, 201);
  const reportId = reportRes.body.id;

  // Run custom report
  const runRes = await s.admin.post(`/reports/${reportId}/run`);
  assert.equal(runRes.status, 200);
  assert.equal(runRes.body.total_records, 2);
  assert.ok(runRes.body.summary);

  // CSV Export
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const exportRes = await fetch(`${base}/api/reports/${reportId}/export`, {
    headers: { Cookie: s.admin.getCookie() },
  });
  assert.equal(exportRes.status, 200);


  // Schedule report
  const schedRes = await s.admin.post(`/reports/${reportId}/schedules`, {
    cadence: 'daily',
    delivery_time: '08:00',
    recipients: ['admin@example.com'],
  });
  assert.equal(schedRes.status, 201);

  // Test schedule execution
  const testSchedRes = await s.admin.post(`/schedules/${schedRes.body.id}/test`);
  assert.equal(testSchedRes.status, 200);
  assert.equal(testSchedRes.body.status, 'success');

  // Check audit log
  const auditRes = await s.admin.get('/audit-logs');
  assert.equal(auditRes.status, 200);
  assert.ok(auditRes.body.some((a) => a.action === 'create_report'));
});
