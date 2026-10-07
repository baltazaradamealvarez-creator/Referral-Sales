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
  assert.equal(testSchedRes.body.status, 'failed');
  assert.equal(testSchedRes.body.recipients, 0);
  assert.match(testSchedRes.body.error, /Email is not set up/);
  const history = await s.admin.get(`/schedules/${schedRes.body.id}/history`);
  assert.equal(history.body[0].status, 'failed');
  assert.match(history.body[0].error_message, /Email is not set up/);

  // Check audit log
  const auditRes = await s.admin.get('/audit-logs');
  assert.equal(auditRes.status, 200);
  assert.ok(auditRes.body.some((a) => a.action === 'create_report'));
});

test('scheduled reports await delivery, keep CSV attachments, and restrict test/history to the owner or admin', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const report = await s.admin.post('/reports', { name: 'Delivery test', config: { columns: ['id', 'customer_name'] } });
  const schedule = await s.admin.post(`/reports/${report.body.id}/schedules`, { recipients: ['admin@example.com'], skip_empty: false });
  const id = schedule.body.id;
  const team = await s.admin.post('/teams', { name: 'Other team' });
  const user = await s.admin.post('/users', { username: 'other', full_name: 'Other User', role: 'rep', team_id: team.body.id });
  const base = `http://127.0.0.1:${s.server.address().port}/api`;
  const login = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'other', password: user.body.temp_password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await fetch(base + '/me/password', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ current: user.body.temp_password, next: 'other-pass-123' }) });
  for (const [method, route] of [['POST', 'test'], ['GET', 'history']]) {
    const res = await fetch(`${base}/schedules/${id}/${route}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(res.status, 403);
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM schedule_deliveries').get().n, 0);
  const realFetch = globalThis.fetch;
  const previousKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  t.after(() => { globalThis.fetch = realFetch; if (previousKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previousKey; });
  let body;
  let response = 200;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      body = JSON.parse(init.body);
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify(response === 200 ? { id: 'sent' } : { message: 'Domain is not verified' }), { status: response });
    }
    return realFetch(url, init);
  };
  const success = await s.admin.post(`/schedules/${id}/test`);
  assert.equal(success.body.status, 'success');
  assert.equal(success.body.recipients, 1);
  assert.equal(body.attachments.length, 1);
  assert.match(Buffer.from(body.attachments[0].content, 'base64').toString(), /customer_name/);
  response = 403;
  const failure = await s.admin.post(`/schedules/${id}/test`);
  assert.equal(failure.body.status, 'failed');
  assert.equal(failure.body.recipients, 0);
  assert.match(failure.body.error, /Domain is not verified/);
});

test('all business report fields support filters, sorting, saved settings, and current-config exports', async(t)=>{
  const s=await setup();t.after(()=>s.server.close());
  const first=await s.admin.post('/referrals',{name:'Alice Smith',phone:'5125559000',address:'100 Main St Austin TX 78701',services:['Internet'],company:'Growth 100%_Company',est_monthly_value:0});
  const second=await s.admin.post('/referrals',{name:'Bob Jones',phone:'5125559001',address:'200 Oak St Austin TX 78701',services:['TV'],company:'Growth other Company',est_monthly_value:95});
  assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(second.status,201,JSON.stringify(second.body));
  const opts=await s.admin.get('/filter-options');
  assert.ok(opts.body.report_fields.length>50);assert.ok(opts.body.report_fields.some(f=>f.key==='working_minutes'));
  assert.ok(opts.body.report_fields.every(f=>!f.sql));
  const cfg={columns:['order_reference','customer_name','est_monthly_value','working_minutes','created_by_name','document_count'],sort_by:'est_monthly_value',sort_direction:'asc',filters:[{field:'est_monthly_value',op:'gte',value:0}]};
  let result=await s.admin.post('/reports/0/run',{config:cfg});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.rows[0].id,first.body.id);assert.equal(result.body.rows[1].id,second.body.id);
  result=await s.admin.post('/reports/0/run',{config:{...cfg,filters:[{field:'company',op:'contains',value:'100%_'}]}});
  assert.equal(result.body.total_records,1);assert.equal(result.body.rows[0].id,first.body.id);
  result=await s.admin.post('/reports/0/run',{config:{...cfg,filter_logic:'any',filters:[{field:'est_monthly_value',value:0},{field:'customer_name',value:'Bob Jones'}]}});assert.equal(result.body.total_records,2);
  result=await s.admin.post('/reports/0/run',{config:{...cfg,filters:[{field:'account_number',op:'empty'}]}});assert.equal(result.body.total_records,2);
  result=await s.admin.post('/reports/0/run',{config:{...cfg,group_by:'status',calc_field:'est_monthly_value',calc_function:'avg'}});
  assert.equal(result.body.totals.metric.value,47.5);assert.equal(result.body.totals.metric.sample_count,2);assert.equal(result.body.summary[0].metric.value,47.5);
  result=await s.admin.post('/reports/0/run',{config:{...cfg,group_by:'est_monthly_value'}});assert.deepEqual(result.body.summary.map(g=>g.group),['0','95']);
  const saved=await s.admin.post('/reports',{name:'Full field report',config:cfg});assert.equal(saved.status,201);
  const reloaded=await s.admin.get(`/reports/${saved.body.id}`);assert.deepEqual(reloaded.body.config,cfg);
  const base=`http://127.0.0.1:${s.server.address().port}`;
  const download=await fetch(base+'/api/reports/export',{method:'POST',headers:{Cookie:s.admin.getCookie(),'Content-Type':'application/json'},body:JSON.stringify({config:{...cfg,filters:[{field:'est_monthly_value',value:0}]}})});
  assert.equal(download.status,200);const csv=await download.text();assert.ok(csv.startsWith('"order_reference","customer_name","est_monthly_value","working_minutes","created_by_name","document_count"'));
  assert.ok(csv.includes('Alice Smith'));assert.ok(!csv.includes('Bob Jones'));
  const detail=await s.admin.get(`/referrals/${first.body.id}`);assert.ok(detail.body.stage_timing.running);const entered=detail.body.stage_timing.current_started_at;
  await s.admin.patch(`/referrals/${first.body.id}`,{notes:'Contact after 5'});assert.equal((await s.admin.get(`/referrals/${first.body.id}`)).body.stage_timing.current_started_at,entered);
});

test('report validation rejects unsafe identifiers and preserves scoping for any filters and public definitions',async(t)=>{
  const s=await setup();t.after(()=>s.server.close());
  const team=await s.admin.post('/teams',{name:'Scoped team'});
  const user=await s.admin.post('/users',{username:'scoped',full_name:'Scoped Seller',role:'rep',team_id:team.body.id});
  const rep=s.client();await rep.login('scoped',user.body.temp_password,'scoped-pass-123');
  const other=await s.admin.post('/referrals',{name:'Other customer',phone:'5125559100'});
  const own=await rep.post('/referrals',{name:'My customer',phone:'5125559101'});assert.equal(own.status,201);
  for(const config of [
    {data_source:'users'},{date_field:"created_at) OR 1=1 --"},{columns:['password_hash']},{sort_by:'raw_text'},
    {filters:[{field:'status',op:'sql',value:'New'}]},{filters:[{field:'working_minutes',value:'abc'}]},
    {calc_field:'customer_name'},{calc_field:'working_minutes',calc_function:'invalid'},
    {filters:[null]},{from:'2026-02-30'},{from:'2026-10-10',to:'2026-10-01'},
  ]){const res=await rep.post('/reports/0/run',{config});assert.equal(res.status,400,JSON.stringify(res.body));}
  const bad=await rep.post('/reports',{name:'Bad source',config:{data_source:'users'}});assert.equal(bad.status,400);
  const shared=await s.admin.post('/reports',{name:'Shared opportunities',is_public:true,config:{filter_logic:'any',filters:[{field:'customer_name',value:'Other customer'},{field:'customer_name',value:'My customer'}]}});
  const result=await rep.post(`/reports/${shared.body.id}/run`);assert.equal(result.status,200);assert.deepEqual(result.body.rows.map(r=>r.id),[own.body.id]);assert.ok(!result.body.rows.some(r=>r.id===other.body.id));
  const options=await rep.get('/filter-options');const all=await rep.post('/reports/0/run',{config:{columns:options.body.report_fields.map(f=>f.key)}});assert.equal(all.status,200);assert.equal(all.body.total_records,1);assert.ok(!('password_hash' in all.body.rows[0]));
});
