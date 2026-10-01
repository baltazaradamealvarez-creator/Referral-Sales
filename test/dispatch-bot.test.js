'use strict';

// The two-way WhatsApp dispatch group, with fake WhatsApp and a fake AI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { detectStatus, detectLang, instructions } = require('../src/dispatch-bot');

const GROUP = '1203630@g.us';

function fakeWhatsApp() {
  const fake = { sent: [], reacts: [], handlers: null, n: 0 };
  fake.factory = (handlers) => {
    fake.handlers = handlers;
    return {
      async start() {}, stop() {}, async logout() {},
      async sendText(jid, text, opts = {}) { const id = `out-${++fake.n}`; fake.sent.push({ id, jid, text, quotedId: opts.quotedId }); return id; },
      async react(jid, id, emoji) { fake.reacts.push({ jid, id, emoji }); },
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
        method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
  };
  const a = client();
  await a.post('/login', { username: admin.username, password: admin.password });
  await a.post('/me/password', { current: admin.password, next: 'admin-pass-1' });
  const team = (await a.post('/teams', { name: 'North Crew' })).body.id;
  const makeUser = async (username, role, whatsapp) => {
    const r = await a.post('/users', { username, full_name: `${username[0].toUpperCase()}${username.slice(1)} Person`, role, team_id: role === 'dispatch' ? null : team, password: `${username}-pass-1` });
    const c = client();
    await c.post('/login', { username, password: `${username}-pass-1` });
    await c.post('/me/password', { current: `${username}-pass-1`, next: `${username}-pass-2` });
    if (whatsapp) await c.patch('/me', { whatsapp, whatsapp_alerts: false }); // group tests: no private alerts
    return { id: r.body.id, c };
  };
  await a.post('/whatsapp/connect');
  wa.handlers.onOpen({ id: '15125550100:4@s.whatsapp.net', lid: '99887766@lid', name: 'E&O Alerts' });
  await a.patch('/whatsapp/settings', { group_id: GROUP, group_name: 'Dispatch' });
  const settle = async () => { await new Promise((r) => setTimeout(r, 20)); await app.locals.whatsapp.drain(); };
  let mid = 0;
  // A message in the group, as WhatsApp would hand it over.
  const say = async (from, text, extra = {}) => {
    await app.locals.whatsapp.receive({
      id: `in-${++mid}`, chat: GROUP, isGroup: true, senderJid: `${from}@s.whatsapp.net`, senderPhone: from, name: 'Someone',
      text, quotedId: null, mentions: [], ts: Date.now(), ...extra,
    });
    await settle();
  };
  return { db, app, a, wa, makeUser, settle, say };
}

test('keywords: statuses in English and Spanish, negation and ambiguity', () => {
  assert.deepEqual(detectStatus('Approved! install Friday'), { status: 'Ordered' });
  assert.deepEqual(detectStatus('approved', 'Passed'), { status: 'Passed' });
  assert.deepEqual(detectStatus('aprobado ✅'), { status: 'Ordered' });
  assert.deepEqual(detectStatus('no califica, crédito negado'), { status: 'DNQ' });
  assert.deepEqual(detectStatus('No pasó'), { status: 'DNQ' });
  assert.deepEqual(detectStatus('pasó, lo estoy trabajando'), { status: 'Passed' });
  assert.deepEqual(detectStatus('customer cancelled'), { status: 'Cancelled' });
  assert.deepEqual(detectStatus('ya no quiere el servicio'), { status: 'Cancelled' });
  assert.deepEqual(detectStatus('not approved yet, calling back'), {});
  assert.deepEqual(detectStatus('todavía no aprobado'), {});
  assert.deepEqual(detectStatus('left a voicemail'), {});
  assert.deepEqual(detectStatus('approved but then cancelled').options.sort(), ['Cancelled', 'Ordered']);
  assert.equal(detectLang('El cliente no contesta, llamo mañana'), 'es');
  assert.equal(detectLang('Customer did not answer, will call back'), 'en');
  const help = instructions('Ordered');
  assert.match(help, /how this group works/);
  assert.match(help, /cómo funciona este grupo/);
});

test('replies become notes; first dispatcher takes the lead; status words move it; @owner tells the rep', async (t) => {
  const { db, a, wa, makeUser, say, settle } = await setup(t);
  const rep = await makeUser('rita', 'rep', '+1 512 555 0142');
  const dee = await makeUser('dee', 'dispatch', '(512) 555-0199');
  const dan = await makeUser('dan', 'dispatch', '512-555-0188');

  // The lead is posted, with the reply hint, and remembered.
  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309', address: '1010 Ogden Ave, Dallas TX 75211' })).body;
  await settle();
  const post = wa.sent.find((m) => m.jid === GROUP && m.text.includes('Maria Lopez'));
  assert.match(post.text, /Reply to this message/);
  assert.match(post.text, /Responde a este mensaje/);
  assert.equal(db.prepare('SELECT referral_id FROM wa_messages WHERE id = ?').get(post.id).referral_id, lead.id);

  // Someone the app doesn't know: told how to register, nothing saved.
  await say('15125550000', 'I can take it', { quotedId: post.id });
  assert.match(wa.sent.at(-1).text, /don't recognise this number/);
  assert.match(wa.sent.at(-1).text, /Todavía no reconozco/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0);

  // Dee replies first: note saved, lead assigned to Dee, rep NOT pinged (no @owner).
  await say('15125550199', 'Called her, left a voicemail', { quotedId: post.id });
  let r = db.prepare('SELECT assigned_to, status, first_touch_at FROM referrals WHERE id = ?').get(lead.id);
  assert.equal(r.assigned_to, dee.id);
  assert.ok(r.first_touch_at, 'counts as the first response');
  const c1 = db.prepare('SELECT body, source, user_id FROM comments ORDER BY id DESC').get();
  assert.deepEqual({ ...c1 }, { body: 'Called her, left a voicemail', source: 'whatsapp', user_id: dee.id });
  assert.match(wa.sent.at(-1).text, new RegExp(`✅ #${lead.id} Maria Lopez · 👤 Dee`));
  assert.ok(!db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '%commented%'").get(rep.id));

  // Dan replies "approved @owner": no reassignment, status → Ordered, the rep is told.
  await say('15125550188', 'approved @owner install Friday 10am', { quotedId: post.id });
  r = db.prepare('SELECT assigned_to, status FROM referrals WHERE id = ?').get(lead.id);
  assert.equal(r.assigned_to, dee.id, 'first reply keeps the lead');
  assert.equal(r.status, 'Ordered');
  assert.match(wa.sent.at(-1).text, /\*Ordered\*/);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '%(WhatsApp) commented%install Friday%'").get(rep.id));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '%was Ordered%'").get(rep.id));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM status_history WHERE referral_id = ? AND to_status = 'Ordered'").get(lead.id).n, 1);

  // A WhatsApp @-mention of the rep works like @owner.
  await say('15125550199', 'can you confirm her email?', { quotedId: post.id, mentions: ['15125550142@s.whatsapp.net'] });
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '%confirm her email%'").get(rep.id));
  assert.equal(wa.reacts.at(-1).emoji, '📨');

  // The rep can add notes by number, but not change the status.
  await say('15125550142', `#${lead.id} she also wants TV`);
  assert.equal(db.prepare('SELECT body FROM comments ORDER BY id DESC').get().body, 'she also wants TV');
  assert.equal(wa.reacts.at(-1).emoji, '📝');
  await say('15125550142', `#${lead.id} cancelled`);
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id = ?').get(lead.id).status, 'Ordered');
  assert.match(wa.sent.at(-1).text, /Only dispatch, a manager or an admin/);

  // Unclear: the bot asks, quoting the message; replying to the question settles it.
  await say('15125550199', 'approved but then cancelled??', { quotedId: post.id });
  const q = wa.sent.at(-1);
  assert.match(q.text, /Which status should I set/);
  await settle();
  assert.equal(db.prepare('SELECT referral_id FROM wa_messages WHERE id = ?').get(q.id).referral_id, lead.id);
  await say('15125550199', 'cancelled', { quotedId: q.id });
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id = ?').get(lead.id).status, 'Cancelled');

  // Spanish.
  const lead2 = (await rep.c.post('/referrals', { name: 'Omar Diaz', phone: '512-867-5310' })).body;
  await say('15125550188', `#${lead2.id} no califica, crédito negado`);
  assert.equal(db.prepare('SELECT status, assigned_to FROM referrals WHERE id = ?').get(lead2.id).status, 'DNQ');
  await say('15125550188', '#99999 aprobado');
  assert.match(wa.sent.at(-1).text, /No encuentro el lead #99999/);

  // Same message twice (WhatsApp redelivery), old messages, other groups: ignored.
  const before = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
  await say('15125550199', `#${lead2.id} note A`, { id: 'same-1' });
  await say('15125550199', `#${lead2.id} note A`, { id: 'same-1' });
  await say('15125550199', `#${lead2.id} old`, { ts: Date.now() - 2 * 86400000 });
  await say('15125550199', `#${lead2.id} elsewhere`, { chat: 'other@g.us' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, before + 1);

  // Plain chat in the group is left alone.
  const sentBefore = wa.sent.length;
  await say('15125550199', 'good morning team!');
  assert.equal(wa.sent.length, sentBefore);

  // Help, in both languages, at most once every few minutes.
  await say('15125550199', 'ayuda');
  assert.match(wa.sent.at(-1).text, /cómo funciona este grupo/);
  const n = wa.sent.length;
  await say('15125550199', 'help');
  assert.equal(wa.sent.length, n);

  // Without AI, questions get a pointer to help.
  await say('15125550199', 'bot how many leads today?');
  assert.match(wa.sent.at(-1).text, /Type \*help\*/);

  // Admin can post the instructions.
  assert.equal((await a.post('/whatsapp/instructions')).status, 200);
  await settle();
  assert.match(wa.sent.at(-1).text, /how this group works/);
});

test('people are recognised by their privacy id (LID) once seen with their number', async (t) => {
  const { db, makeUser, say } = await setup(t);
  const rep = await makeUser('rita', 'rep');
  await makeUser('dee', 'dispatch', '(512) 555-0199');
  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  await say('15125550199', `#${lead.id} first`, { senderJid: '4455@lid' });
  await say(null, `#${lead.id} second`, { senderJid: '4455@lid', senderPhone: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE referral_id = ?').get(lead.id).n, 2);
});

test('Mexican accounts match legacy +521 sender ids and can then reply using their privacy id', async (t) => {
  const { db, makeUser, say } = await setup(t);
  const rep = await makeUser('rita', 'rep');
  const dee = await makeUser('dee', 'dispatch', '+52 81 5550 1668');
  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  await say('5218155501668', `#${lead.id} approved`, { senderJid: '4455@lid' });
  const updated = db.prepare('SELECT assigned_to, status FROM referrals WHERE id = ?').get(lead.id);
  assert.equal(updated.assigned_to, dee.id);
  assert.equal(updated.status, 'Ordered');
  await say(null, `#${lead.id} following up`, { senderJid: '4455@lid', senderPhone: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE referral_id = ?').get(lead.id).n, 2);
});

test('changing or removing a WhatsApp number invalidates learned privacy identities', async (t) => {
  const { db, a, wa, makeUser, say } = await setup(t);
  const rep = await makeUser('rita', 'rep');
  const dee = await makeUser('dee', 'dispatch', '(512) 555-0199');
  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  await say('15125550199', `#${lead.id} first`, { senderJid: '4455@lid' });
  assert.ok(db.prepare('SELECT 1 FROM wa_identities WHERE jid = ?').get('4455@lid'));
  await a.patch(`/users/${dee.id}`, { whatsapp: '(512) 555-0188' });
  assert.equal(db.prepare('SELECT 1 FROM wa_identities WHERE jid = ?').get('4455@lid'), undefined);
  await say(null, `#${lead.id} cancelled`, { senderJid: '4455@lid', senderPhone: null });
  assert.match(wa.sent.at(-1).text, /don't recognise/);
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id = ?').get(lead.id).status, 'New');
  await say('15125550188', `#${lead.id} second`, { senderJid: '5566@lid' });
  await dee.c.patch('/me', { whatsapp: '' });
  assert.equal(db.prepare('SELECT 1 FROM wa_identities WHERE jid = ?').get('5566@lid'), undefined);
  await say(null, `#${lead.id} cancelled`, { senderJid: '5566@lid', senderPhone: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE referral_id = ?').get(lead.id).n, 2);
});

test('resends during an assistant request keep conversation order; diagnostics explain ignored messages', async (t) => {
  const calls = [];
  const ai = { enabled: () => true, available: () => true, model: 'fake', async runAgent({ messages }) {
    calls.push(messages.map((m) => `${m.role}: ${m.content}`));
    await new Promise((r) => setTimeout(r, 20));
    return { text: `answer-${calls.length}`, steps: [] };
  } };
  const { app, a, makeUser, say } = await setup(t, { ai });
  await makeUser('dee', 'dispatch', '(512) 555-0199');
  await Promise.all([say('15125550199', 'bot first'), say('15125550199', 'bot second')]);
  assert.deepEqual(calls, [['user: first'], ['user: first', 'assistant: answer-1', 'user: second']]);
  await say('15125550199', 'ordinary conversation');
  let dx = (await a.get('/whatsapp/status')).body.diagnostics;
  assert.equal(dx.last_result, 'ordinary_chat');
  assert.ok(dx.last_received_at && dx.last_sent_at);
  await a.patch('/whatsapp/settings', { two_way: false });
  await say('15125550199', 'bot hello');
  assert.equal((await a.get('/whatsapp/status')).body.diagnostics.last_result, 'two_way_off');
  await a.patch('/whatsapp/settings', { two_way: true });
  await say('15125550199', 'bot hello', { id: 'repeat-id' });
  await say('15125550199', 'bot hello', { id: 'repeat-id' });
  assert.equal((await a.get('/whatsapp/status')).body.diagnostics.last_result, 'duplicate');
  assert.equal(app.locals.whatsapp.queueLength(), 0);
});

test('with the AI helper: replies are read by the AI; "bot …" talks to the assistant, and replies to it continue the chat', async (t) => {
  const calls = [];
  const ai = {
    model: 'fake',
    enabled: () => true,
    available: () => true,
    async interpretReply(x) { calls.push(['interpret', x.text]); return { status: x.text.includes('lista') ? 'Ordered' : 'none', sure: true, question: '', notify_owner: false, language: 'es' }; },
    async answer() { return ''; },
    // Stands in for Claude: looks at today's numbers and the open leads with the tools, then answers.
    async runAgent({ system, messages, tools, run }) {
      const stats = await run('team_stats', { period: 'today' });
      const open = await run('find_leads', { status: ['open'] });
      calls.push(['agent', system, messages.map((m) => `${m.role}: ${m.content}`), tools.map((x) => x.name), JSON.stringify([stats, open])]);
      return { text: `Hoy entraron *${stats.leads_entered}* leads y hay ${open.total} abiertos.`, steps: [] };
    },
  };
  const { db, wa, makeUser, say } = await setup(t, { ai });
  const rep = await makeUser('rita', 'rep');
  await makeUser('dee', 'dispatch', '(512) 555-0199');
  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309', address: '1010 Ogden Ave, Dallas TX 75211' })).body;
  await rep.c.post('/referrals', { name: 'Omar Diaz', phone: '512-867-5310' });

  await say('15125550199', `#${lead.id} la venta quedó lista para el viernes`);
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id = ?').get(lead.id).status, 'Ordered');
  assert.deepEqual(calls[0], ['interpret', 'la venta quedó lista para el viernes']);

  await say('15125550199', 'bot ¿cuántos leads entraron hoy?');
  const answer = wa.sent.at(-1);
  assert.equal(answer.text, 'Hoy entraron *2* leads y hay 1 abiertos.');
  const [, system, msgs, tools, seen] = calls.at(-1);
  assert.deepEqual(msgs, ['user: ¿cuántos leads entraron hoy?']);
  assert.match(system, /Dee Person, dispatch/);
  assert.match(system, /WhatsApp dispatch group/);
  assert.ok(tools.includes('update_lead') && tools.includes('set_reminder'));
  for (const text of [system, seen]) {
    assert.ok(!text.includes('867-5309') && !text.includes('Ogden'), 'no phone numbers or addresses in what the AI sees');
  }

  // Replying to the assistant's answer continues the same conversation (no "bot" needed).
  await say('15125550199', '¿y cuántos sin llamar?', { quotedId: answer.id });
  assert.deepEqual(calls.at(-1)[2], ['user: ¿cuántos leads entraron hoy?', 'assistant: Hoy entraron *2* leads y hay 1 abiertos.', 'user: ¿y cuántos sin llamar?']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 1, 'talking to the assistant adds no notes');

  // A private message to the alerts number goes to the assistant too.
  await say('15125550199', 'hola', { chat: '15125550199@s.whatsapp.net', isGroup: false });
  assert.equal(wa.sent.at(-1).jid, '15125550199@s.whatsapp.net');
  assert.match(calls.at(-1)[1], /private WhatsApp chat/);
});

test('admin settings: what "approved" means, two-way on/off', async (t) => {
  const { db, a, makeUser, say } = await setup(t);
  const rep = await makeUser('rita', 'rep');
  await makeUser('dee', 'dispatch', '(512) 555-0199');
  assert.equal((await a.patch('/whatsapp/settings', { approved_status: 'DNQ' })).status, 400);
  const s = (await a.patch('/whatsapp/settings', { approved_status: 'Passed' })).body;
  assert.equal(s.approved_status, 'Passed');
  assert.equal(s.ai_available, false);
  const lead = (await rep.c.post('/referrals', { name: 'Maria Lopez', phone: '512-867-5309' })).body;
  await say('15125550199', `#${lead.id} approved`);
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id = ?').get(lead.id).status, 'Passed');
  await a.patch('/whatsapp/settings', { two_way: false });
  await say('15125550199', `#${lead.id} cancelled`);
  assert.equal(db.prepare('SELECT status FROM referrals WHERE id = ?').get(lead.id).status, 'Passed');
});

test('the AI calls Claude Haiku 4.5: strict JSON for replies, a tool loop for the assistant (network stubbed)', async (t) => {
  const real = globalThis.fetch;
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.anthropic.com/')) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const text = body.output_config ? '{"status":"DNQ","sure":true,"question":"","notify_owner":true,"language":"es"}' : 'Hay 3 leads abiertos.';
      // The assistant: first asks for a tool, then answers once it has the result.
      const wantsTool = body.tools && !body.messages.some((m) => Array.isArray(m.content));
      const content = wantsTool ? [{ type: 'tool_use', id: 'toolu_1', name: 'team_stats', input: { period: 'today' } }] : [{ type: 'text', text }];
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content,
        stop_reason: wantsTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(url, init);
  };
  t.after(() => { globalThis.fetch = real; if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key; });
  const { createAi } = require('../src/ai');
  const ai = createAi({ getSettings: () => ({}) });
  assert.equal(ai.enabled(), true);
  const r = await ai.interpretReply({ lead: { id: 7, customer_name: 'Maria', status: 'New', created_by_name: 'Rita' }, text: 'no califica', senderName: 'Dee', approvedStatus: 'Ordered' });
  assert.deepEqual(r, { status: 'DNQ', sure: true, question: '', notify_owner: true, language: 'es' });
  assert.equal(bodies[0].model, 'claude-haiku-4-5-20251001');
  assert.equal(bodies[0].output_config.format.type, 'json_schema');
  assert.equal(bodies[0].output_config.format.schema.additionalProperties, false);
  assert.equal(await ai.answer({ question: '¿cuántos?', context: 'x', senderName: 'Dee' }), 'Hay 3 leads abiertos.');
  const ran = [];
  const out = await ai.runAgent({
    system: 'sys', messages: [{ role: 'user', content: '¿cuántos?' }], tools: [{ name: 'team_stats', description: 'x', input_schema: { type: 'object', properties: {} } }],
    run: (name, input) => { ran.push([name, input]); return { leads_entered: 3 }; },
  });
  assert.equal(out.text, 'Hay 3 leads abiertos.');
  assert.deepEqual(ran, [['team_stats', { period: 'today' }]]);
  const second = bodies.at(-1);
  assert.equal(second.model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(second.messages.at(-1).content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"leads_entered":3}' });
  assert.equal(createAi({ getSettings: () => ({ ai_enabled: '0' }) }).enabled(), false);
});
