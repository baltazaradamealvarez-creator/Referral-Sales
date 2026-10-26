'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const prefs = require('../src/notification-preferences');
const { meter } = require('../src/energy');
const { provider } = require('./fixtures/energy-provider');

async function setup(t) {
  const db = openDb(':memory:'),
    admin = ensureAdmin(db, () => {}),
    energy = provider(),
    wa = { sent: [] };
  const app = createApp(db, {
    energyFetch: energy.fetch,
    whatsappTransport: (handlers) => {
      wa.handlers = handlers;
      return {
        async start() {},
        stop() {},
        async exists(d) {
          return d + '@s.whatsapp.net';
        },
        async sendText(jid, text) {
          wa.sent.push({ jid, text });
          return 'fixture-message';
        },
      };
    },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    app.locals.whatsapp.stop();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
      });
      if (res.headers.get('set-cookie'))
        cookie = res.headers.get('set-cookie').split(';')[0];
      return { status: res.status, body: await res.json() };
    };
    return {
      get: (p) => call('GET', p),
      post: (p, b) => call('POST', p, b),
      patch: (p, b) => call('PATCH', p, b),
    };
  };
  const a = client();
  await a.post('/login', {
    username: admin.username,
    password: admin.password,
  });
  await a.post('/me/password', {
    current: admin.password,
    next: 'fixture-admin-password',
  });
  const team = (await a.post('/teams', { name: 'North Team' })).body.id,
    otherTeam = (await a.post('/teams', { name: 'South Team' })).body.id;
  const make = async (username, role = 'rep', team_id = team) => {
    const r = await a.post('/users', {
      username,
      full_name: username.toUpperCase(),
      role,
      team_id,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = client();
    assert.equal(
      (await c.post('/login', { username, password: r.body.temp_password }))
        .status,
      200
    );
    await c.post('/me/password', {
      current: r.body.temp_password,
      next: 'fixture-person-password',
    });
    return { id: r.body.id, c };
  };
  const rep = await make('carla'),
    other = await make('maria', 'rep', otherTeam),
    manager = await make('manager', 'manager'),
    dispatch = await make('dispatch', 'dispatch', null);
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 30));
    await app.locals.whatsapp.drain();
  };
  const lead = (
    await rep.c.post('/referrals', {
      name: 'Jane Smith',
      phone: '512-867-5309',
      email: 'jane@email.com',
      address: '5900 Armstrong',
      zip: '75205',
    })
  ).body;
  assert.ok(lead.id, JSON.stringify(lead));
  await a.post('/whatsapp/connect');
  wa.handlers.onOpen({ id: '15125550100@s.whatsapp.net' });
  await settle();
  return {
    db,
    app,
    a,
    client,
    energy,
    wa,
    rep,
    other,
    manager,
    dispatch,
    lead,
    settle,
  };
}
async function comparison(c, id, lookup, usage) {
  const start = await c.post(`/energy/referrals/${id}/recommendations`, {
    lookup_id: lookup.lookup_id,
    esiid: lookup.meters[0].esiid,
    ...(usage ? { usage } : {}),
  });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  for (let n = 0; n < 150; n++) {
    const out = await c.get(
      `/energy/referrals/${id}/jobs/${start.body.job_id}`
    );
    assert.equal(out.status, 200);
    if (out.body.status !== 'working') return out.body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Fixture comparison did not finish');
}

test('notification preferences constrain WhatsApp, persist partial choices, and honor email independently', async (t) => {
  const mail = require('../src/email'),
    sent = [];
  t.mock.method(mail, 'emailConfig', () => ({
    enabled: true,
    appUrl: 'https://app.example.com',
  }));
  t.mock.method(mail, 'sendEmail', async (m) => {
    sent.push(m);
    return { ok: true };
  });
  const { db, a, rep, dispatch, lead, wa, settle } = await setup(t);
  await rep.c.patch('/me', {
    email: 'carla@example.com',
    email_alerts: true,
    whatsapp: '512-555-0142',
    whatsapp_alerts: true,
  });
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key='wa_new_lead_group'").get()
      .value,
    '1'
  );
  const initial = (await rep.c.get('/me')).body.notification_preferences;
  assert.equal(initial.automatic_coaching, false);
  assert.equal(initial.events.ordered.whatsapp, true);
  assert.equal(initial.events.comments.whatsapp, false);
  assert.equal(
    (
      await rep.c.patch('/me/notification-preferences', {
        events: { comments: { whatsapp: true } },
      })
    ).status,
    400
  );
  assert.equal(
    (await rep.c.patch('/me/notification-preferences', { events: [] })).status,
    400
  );
  assert.equal(
    (
      await rep.c.patch('/me/notification-preferences', {
        events: { unknown: { email: true } },
      })
    ).status,
    400
  );
  assert.equal(
    (
      await rep.c.patch(
        '/me/notification-preferences',
        JSON.parse('{"events":{"__proto__":{"email":true}}}')
      )
    ).status,
    400
  );
  await rep.c.patch('/me/notification-preferences', {
    events: { comments: { email: false, push: false } },
  });
  await rep.c.patch('/me/notification-preferences', {
    automatic_coaching: true,
  });
  assert.equal(
    (await rep.c.get('/me')).body.notification_preferences.events.comments
      .email,
    false,
    'PATCH preserves unrelated choices'
  );
  await settle();
  sent.length = 0;
  await a.patch(`/referrals/${lead.id}`, {
    assigned_to: dispatch.id,
    status: 'Working',
  });
  await a.post(`/referrals/${lead.id}/comments`, {
    body: 'Regular conversation with the owner',
  });
  await settle();
  assert.equal(
    wa.sent.length,
    0,
    'assignments, ordinary status changes and notes are not WhatsApp alerts'
  );
  assert.equal(
    sent.filter((m) => m.to === 'carla@example.com').length,
    1,
    'status email stays on while comment email is off'
  );
  sent.length = 0;
  await a.post(`/referrals/${lead.id}/comments`, {
    body: '@owner @carla please review this',
  });
  await settle();
  assert.equal(wa.sent.length, 1);
  assert.match(wa.sent[0].text, /mentioned you/);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND event_type='owner_mention'"
      )
      .get(rep.id).n,
    1,
    'owner alias and username do not duplicate delivery'
  );
  await a.post(`/referrals/${lead.id}/comments`, {
    body: '@dispatch routine handoff',
  });
  await settle();
  assert.equal(wa.sent.length, 1, 'mentioning a non-owner is not urgent');
  await a.patch(`/referrals/${lead.id}`, { status: 'Ordered' });
  await settle();
  assert.equal(wa.sent.length, 2);
  await rep.c.patch('/me/notification-preferences', {
    events: { owner_mention: { whatsapp: false, email: false } },
  });
  await a.post(`/referrals/${lead.id}/comments`, {
    body: '@owner a quiet follow-up',
  });
  await settle();
  assert.equal(wa.sent.length, 2);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND event_type='owner_mention'"
      )
      .get(rep.id).n,
    2,
    'the bell retains muted alerts'
  );
  assert.equal(prefs.allows('null', 'new_leads', 'whatsapp'), false);
});

test('opportunity profile walls retain ownership and expose only records the viewer can access', async (t) => {
  const { db, a, rep, other, manager, lead } = await setup(t);
  await a.patch(`/referrals/${lead.id}`, { status: 'Working' });
  await rep.c.post(`/referrals/${lead.id}/comments`, {
    body: 'Customer requested a call after lunch',
  });
  const privateLead = (
    await other.c.post('/referrals', {
      name: 'Omar Diaz',
      phone: '512-867-5310',
    })
  ).body;
  await other.c.post(`/referrals/${privateLead.id}/comments`, {
    body: 'Other-team private conversation',
  });
  const wall = await manager.c.get(`/people/${rep.id}`);
  assert.equal(wall.status, 200);
  assert.deepEqual(wall.body.summary, {
    opportunities: 1,
    open: 1,
    ordered: 0,
  });
  assert.ok(wall.body.activity.some((x) => x.body.includes('after lunch')));
  assert.equal(wall.body.leads[0].id, lead.id);
  for (const field of [
    'email',
    'whatsapp',
    'password_hash',
    'commission',
    'comparepower_afuid',
  ])
    assert.equal(wall.body.person[field], undefined, field);
  assert.equal((await rep.c.get(`/people/${other.id}`)).status, 404);
  assert.equal((await manager.c.get(`/people/${other.id}`)).status, 404);
  assert.equal(
    (await rep.c.get(`/people/${manager.id}`)).body.activity.length,
    0
  );
  const own = (await rep.c.get(`/people/${rep.id}`)).body;
  assert.ok(!JSON.stringify(own).includes('Other-team private'));
  assert.equal(
    (await a.get(`/people/${other.id}`)).body.leads[0].id,
    privateLead.id
  );
  // Existing entry-on-behalf semantics stay intact: owner is the credited seller.
  const onBehalf = await a.post('/referrals', {
    name: 'Luis Vega',
    phone: '512-867-5311',
    credit_to: rep.id,
  });
  assert.equal(onBehalf.status, 201);
  assert.equal(onBehalf.body.created_by, rep.id);
  assert.notEqual(onBehalf.body.entered_by, rep.id);
  assert.equal(
    db.prepare('SELECT created_by FROM referrals WHERE id=?').get(lead.id)
      .created_by,
    rep.id
  );
});

test('energy compares true annual bills, excludes missing math, preserves attribution and requires explicit contact prefill', async (t) => {
  const { db, a, rep, other, lead, energy, wa, settle } = await setup(t);
  const before = db.prepare('SELECT * FROM referrals WHERE id=?').get(lead.id);
  const root = `/energy/referrals/${lead.id}`;
  assert.equal(
    (
      await other.c.post(root + '/meters', {
        address: '5900 Armstrong',
        zip: '75205',
      })
    ).status,
    404
  );
  assert.equal(
    energy.calls.length,
    0,
    'unauthorized customers never reach the provider'
  );
  assert.equal(
    (await rep.c.post(root + '/meters', { zip: 'bad' })).status,
    400
  );
  const lookup = (
    await rep.c.post(root + '/meters', {
      address: '5900 Armstrong',
      zip: '75205',
    })
  ).body;
  assert.equal(
    new URL(energy.calls[0].url).searchParams.get('zip_code'),
    '75205'
  );
  const job = await comparison(rep.c, lead.id, lookup);
  assert.equal(job.status, 'done', job.error);
  assert.equal(
    job.plans[0].id,
    'steady-plan',
    'headline bill credit loses at most months of actual usage'
  );
  assert.equal(job.plans[0].annual_bill, 1488);
  assert.equal(job.plans[1].annual_bill, 1930);
  assert.equal(job.plans[0].monthly_bills.length, 12);
  assert.equal(
    job.plans[0].documents.length,
    1,
    'only HTTPS document snapshots are linked'
  );
  assert.ok(job.warnings[0].includes('1 plan'));
  assert.equal(job.plans.length, 2, 'null bill total is not a free plan');
  assert.ok(
    energy.calls.every(
      (c) => !JSON.stringify(c).includes('cp_live_') && !c.headers.Authorization
    )
  );
  assert.deepEqual(
    db.prepare('SELECT * FROM referrals WHERE id=?').get(lead.id),
    before,
    'read-only checks preserve the sale'
  );
  const plansCall = new URL(
    energy.calls.find((c) => c.url.includes('/plans/current')).url
  );
  assert.equal(plansCall.searchParams.get('tdsp_duns'), lookup.meters[0].duns);
  const body = { job_id: job.id, plan_id: job.plans[0].id };
  assert.equal(
    (await a.post(root + '/checkout', body)).status,
    404,
    'jobs belong to the person who requested them'
  );
  let url = new URL((await rep.c.post(root + '/checkout', body)).body.url);
  assert.equal(url.searchParams.get('cp_afid'), 'eiwhj899');
  assert.equal(url.searchParams.get('cp_afuid'), 'im3lwsos');
  assert.equal(url.searchParams.get('plan_id'), 'steady-plan');
  for (const key of ['first_name', 'last_name', 'email', 'phone_number'])
    assert.equal(url.searchParams.has(key), false);
  assert.equal(
    (await rep.c.patch('/me', { comparepower_afuid: 'https://bad.example' }))
      .status,
    400
  );
  await rep.c.patch('/me', { comparepower_afuid: 'carla123' });
  url = new URL(
    (
      await rep.c.post(root + '/checkout', {
        ...body,
        include_contact: true,
        selected_start_date: '2026-11-01',
      })
    ).body.url
  );
  assert.equal(url.searchParams.get('cp_afuid'), 'carla123');
  assert.equal(url.searchParams.get('first_name'), 'Jane');
  assert.equal(url.searchParams.get('last_name'), 'Smith');
  assert.equal(url.searchParams.get('email'), 'jane@email.com');
  assert.equal(url.searchParams.get('phone_number'), '5128675309');
  assert.equal(
    (
      await rep.c.post(root + '/checkout', {
        ...body,
        selected_start_date: '2026-02-30',
      })
    ).status,
    400
  );
  assert.equal(
    (await rep.c.patch('/energy/settings', { afid: 'other' })).status,
    403
  );
  await a.patch('/energy/settings', {
    afid: 'updated-org',
    default_afuid: 'default-member',
  });
  url = new URL((await rep.c.post(root + '/checkout', body)).body.url);
  assert.equal(url.searchParams.get('cp_afid'), 'updated-org');
  assert.equal(url.searchParams.get('cp_afuid'), 'carla123');
  assert.equal((await rep.c.post(root + '/save', body)).status, 200);
  await rep.c.post(root + '/save', body);
  assert.equal(
    db
      .prepare('SELECT COUNT(*) AS n FROM comments WHERE referral_id=?')
      .get(lead.id).n,
    1,
    'saving the same quote is idempotent'
  );
  assert.equal(
    db.prepare('SELECT status FROM referrals WHERE id=?').get(lead.id).status,
    'New'
  );
  // Provider text in a generated quote is not a user request to mention the owner.
  energy.mentionName = true;
  await rep.c.patch('/me', { whatsapp: '512-555-0142', whatsapp_alerts: true });
  const adminLookup = (await a.post(root + '/meters', { zip: '75205' })).body;
  const adminJob = await comparison(a, lead.id, adminLookup);
  assert.ok(adminJob.plans[0].name.includes('@owner'));
  await a.post(root + '/save', { job_id: adminJob.id, plan_id: 'steady-plan' });
  await settle();
  assert.equal(
    wa.sent.length,
    0,
    'generated energy notes do not trigger owner-mention WhatsApp'
  );
});

test('switch holds, unknown hold status and failed providers block recommendations; manual usage is a fallback', async (t) => {
  const { a, rep, lead, energy } = await setup(t),
    root = `/energy/referrals/${lead.id}`;
  const lookup = (await rep.c.post(root + '/meters', { zip: '75205' })).body;
  for (const m of lookup.meters.slice(1))
    assert.equal(
      (
        await rep.c.post(root + '/recommendations', {
          lookup_id: lookup.lookup_id,
          esiid: m.esiid,
        })
      ).status,
      409
    );
  assert.equal(
    energy.calls.length,
    1,
    'blocked meters never trigger plans or usage calls'
  );
  assert.equal(
    (
      await a.post(root + '/recommendations', {
        lookup_id: lookup.lookup_id,
        esiid: lookup.meters[0].esiid,
      })
    ).status,
    400,
    'lookup token cannot be transferred'
  );
  energy.missingUsage = true;
  const missing = await comparison(rep.c, lead.id, lookup);
  assert.equal(missing.status, 'failed');
  assert.match(missing.error, /Twelve monthly usage/);
  const manual = await comparison(rep.c, lead.id, lookup, Array(12).fill(700));
  assert.equal(manual.status, 'done');
  assert.equal(manual.usage_source, 'customer');
  energy.missingBill = true;
  const noMath = await comparison(rep.c, lead.id, lookup, Array(12).fill(701));
  assert.equal(noMath.status, 'failed');
  assert.match(noMath.error, /No plans could be fully calculated/);
  energy.fail = true;
  assert.equal(
    (await rep.c.post(root + '/meters', { zip: '75205' })).status,
    502
  );
  assert.equal(
    meter({
      esiid: Number('10443720002003539'),
      duns: '1039940674000',
      switch_hold_indicator: 'N',
    }),
    null,
    'unsafe numeric meter IDs are never rounded into another meter'
  );
});
