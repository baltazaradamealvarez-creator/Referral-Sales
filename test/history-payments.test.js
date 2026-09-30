'use strict';

// Past-sales uploads (duplicate block list), emailed invite links, and payout details.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

process.env.PAYMENT_ENCRYPTION_KEY = 'test-payment-key-please-change';

const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { readSpreadsheet } = require('../src/sheets');
const { extractContacts } = require('../src/history');
const { ibanValid, routingValid } = require('../src/payments');

// ---------- helpers ----------

// Minimal .xlsx writer: enough for the reader to open (shared strings + one sheet per entry).
function makeXlsx(sheets) {
  const strings = [];
  const si = (v) => { let i = strings.indexOf(v); if (i < 0) { i = strings.length; strings.push(v); } return i; };
  const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = (i) => String.fromCharCode(65 + i);
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  sheets.forEach((s, n) => {
    files[`xl/worksheets/sheet${n + 1}.xml`] = `<worksheet><sheetData>${s.rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (v === null ? ''
      : typeof v === 'number' ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="s"><v>${si(v)}</v></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  });
  files['xl/sharedStrings.xml'] = `<sst>${strings.map((s) => `<si><t>${xesc(s)}</t></si>`).join('')}</sst>`;
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(zlib.crc32(raw), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nameBuf.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(zlib.crc32(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, nameBuf, data);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

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
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p, b) => call('DELETE', p, b) };
  };
  const a = client();
  await a.post('/login', { username: admin.username, password: admin.password });
  await a.post('/me/password', { current: admin.password, next: 'admin-pass-1' });
  const team = (await a.post('/teams', { name: 'North Crew' })).body.id;
  const makeUser = async (username, role) => {
    const pw = (await a.post('/users', { username, full_name: username.toUpperCase(), role, team_id: team, email: `${username}@x.com` })).body.temp_password;
    const c = client();
    await c.post('/login', { username, password: pw });
    await c.post('/me/password', { current: pw, next: `${username}-pass-1` });
    return c;
  };
  return { db, a, team, client, makeUser };
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

// ---------- spreadsheet parsing ----------

test('reads phones and addresses from headed sheets and from header-less pay reports', () => {
  const headed = makeXlsx([{ name: 'Usage', rows: [
    ['Agent', 'Customer - Account Number', 'Customer Full Name', 'SVC Unit - Address Line 1', 'SVC Unit - Address Line 2', 'SVC Unit - City', 'SVC Unit - State', 'SVC Unit - Zip Code', 'Confirmation #', 'Phone'],
    ['RTM1', '8260130110142802', 'DOE,JANE', '1010 OGDEN AVE', ' ', 'DALLAS', 'TX', 75211, 2157278852, '(512) 555-0142'],
    ['RTM1', '8260130110142803', 'ROE,RICK', '3939 ROSEMEADE PKWY', 'APT 7102', 'DALLAS', 'TX', 7030, 2157278853, null],
    [],
  ] }]);
  const r = extractContacts(readSpreadsheet(headed, 'u.xlsx'));
  assert.deepEqual([...r.phones], ['5125550142'], 'confirmation numbers are not phones');
  assert.deepEqual([...r.addresses.values()], [{ key: '1010 ogden ave', zip: '75211' }, { key: '3939 rosemeade pkwy apt 7102', zip: '07030' }]);

  const pay = makeXlsx([{ name: 'Combined', rows: [
    ['Email Date', 'Email Subject', 'File Name'],
    [46290.35, 'Pay 9/26', 'Pay.xlsx', 'Paid Out Orders'],
    [46290.35, 'Pay 9/26', 'Pay.xlsx', '8260130598037789', 'rtmstx1251', 400, 'LOPEZ,LISA', '326 E ILLINOIS AVE APT 222', '1 Gig'],
    [46290.35, 'Pay 9/26', 'Pay.xlsx', '8349300920966550', 'wrong address is 975 california st', 25, 'X,Y', '118 ANN ST', 'Mobil'],
    [46290.35, 'Pay 9/26', 'Pay.xlsx', 'Total Orders', 7550],
  ] }]);
  const p = extractContacts(readSpreadsheet(pay, 'p.xlsx'));
  assert.equal(p.phones.size, 0);
  assert.deepEqual([...p.addresses.values()].map((x) => x.key), ['326 e illinois ave apt 222', '118 ann st']);

  const csv = extractContacts(readSpreadsheet(Buffer.from('Name,Phone,Street Address,Zip\nA,512.555.0101,"12 Oak Ln, Apt 3",78701\n'), 'x.csv'));
  assert.deepEqual([...csv.phones], ['5125550101']);
  assert.deepEqual([...csv.addresses.values()], [{ key: '12 oak ln apt 3', zip: '78701' }]);

  assert.throws(() => readSpreadsheet(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), 'old.xls'), /Save As/);
});

test('past sales: admin-only upload with preview, blocks matching leads, never shown, removable', async (t) => {
  const { db, a, makeUser } = await setup(t);
  const rep = await makeUser('rep1', 'rep');
  const file = makeXlsx([{ name: 'Sales', rows: [
    ['Customer', 'Phone', 'Address', 'City', 'State', 'Zip'],
    ['Old Customer', '512-555-0199', '500 Elm St Apt 4', 'Austin', 'TX', '78701'],
    ['Other', '', '77 Pine Rd', 'Austin', 'TX', '78702'],
  ] }]);
  const body = { file_name: 'past.xlsx', data: file.toString('base64') };

  assert.equal((await rep.post('/history/import', body)).status, 403);

  const preview = await a.post('/history/import', body);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview, true);
  assert.equal(preview.body.phones, 1);
  assert.equal(preview.body.addresses, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history_contacts').get().n, 0, 'preview saves nothing');

  const saved = await a.post('/history/import', { ...body, commit: true, note: 'Summer 2026' });
  assert.equal(saved.status, 201);
  // No names, account numbers or raw rows are stored.
  assert.deepEqual(db.prepare('SELECT kind, key, zip FROM history_contacts ORDER BY id').all().map((x) => ({ ...x })), [
    { kind: 'phone', key: '5125550199', zip: '' },
    { kind: 'address', key: '500 elm st apt 4', zip: '78701' },
    { kind: 'address', key: '77 pine rd', zip: '78702' },
  ]);

  const dup = 'This lead is a duplicate and cannot be entered.';
  const byPhone = await rep.post('/referrals', { name: 'New Person', phone: '(512) 555-0199' });
  assert.equal(byPhone.status, 409);
  assert.equal(byPhone.body.error, dup);
  const byAddr = await rep.post('/referrals', { name: 'New Person', address: '500 Elm Street, Apt #4, Austin TX 78701' });
  assert.equal(byAddr.status, 409);
  assert.equal((await rep.post('/referrals', { name: 'Elsewhere', address: '500 Elm St Apt 4, Dallas TX 75201' })).status, 201, 'different zip is a different place');
  const ok = await rep.post('/referrals', { name: 'Fresh', phone: '512-555-0300' });
  assert.equal(ok.status, 201);

  // Not in the portal: customer lists and search don't include them.
  const list = (await a.get('/referrals?scope=all')).body;
  const rows = Array.isArray(list) ? list : list.rows || list.items || [];
  assert.ok(!JSON.stringify(rows).includes('Old Customer'));
  assert.ok(!JSON.stringify((await a.get('/search?q=Elm')).body).includes('500 Elm St Apt 4, Austin'));

  // The duplicates log says it hit a past sale.
  const attempts = (await a.get('/duplicates')).body;
  assert.equal(attempts[0].matched_on, 'address · past sale');
  assert.equal(attempts[0].matched_referral_id, null);

  // Editing an existing lead doesn't get blocked by its own unchanged phone...
  db.prepare("INSERT INTO history_contacts (import_id, kind, key) VALUES (?, 'phone', '5125550300')").run(saved.body.id);
  assert.equal((await rep.patch(`/referrals/${ok.body.id}`, { notes: 'called back' })).status, 200);
  // ...but changing the address to a past sale is.
  assert.equal((await rep.patch(`/referrals/${ok.body.id}`, { address: '77 Pine Rd, Austin TX 78702' })).status, 409);

  const imports = (await a.get('/history/imports')).body;
  assert.equal(imports.imports.length, 1);
  assert.equal(imports.imports[0].note, 'Summer 2026');
  assert.equal(imports.totals.addresses, 2);
  assert.equal(imports.totals.blocked, 3);

  assert.equal((await a.del(`/history/imports/${saved.body.id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history_contacts').get().n, 0);
  assert.equal((await rep.post('/referrals', { name: 'Now OK', phone: '(512) 555-0199' })).status, 201);

  assert.equal((await a.post('/history/import', { file_name: 'x.csv', data: Buffer.from('a,b\n1,2\n').toString('base64') })).status, 400);
});

// ---------- invites by email ----------

test('admins can email an invite link, and see who it went to', async (t) => {
  const sent = fakeResend(t);
  const { a, team } = await setup(t);
  const tooMany = await a.post('/invites', { role: 'manager', team_id: team, max_uses: 1, emails: 'm1@x.com, m2@x.com' });
  assert.equal(tooMany.status, 400);
  assert.equal((await a.post('/invites', { role: 'manager', team_id: team, emails: 'not-an-email' })).status, 400);

  const r = await a.post('/invites', { role: 'manager', team_id: team, max_uses: 5, emails: 'm1@x.com, M2@x.com; m1@x.com', message: 'Welcome aboard!' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.emailed.map((x) => [x.email, x.sent]), [['m1@x.com', true], ['m2@x.com', true]]);
  assert.equal(sent.length, 2);
  assert.match(sent[0].subject, /invited you/);
  assert.ok(sent[0].html.includes(r.body.url));
  assert.ok(sent[0].text.includes(r.body.url));
  assert.match(sent[0].text, /manager on North Crew/);
  assert.match(sent[0].text, /Welcome aboard!/);

  const more = await a.post(`/invites/${r.body.id}/email`, { emails: ['m3@x.com'] });
  assert.equal(more.status, 200);
  assert.equal((await a.post(`/invites/${r.body.id}/email`, { emails: 'a@x.com b@x.com c@x.com d@x.com e@x.com f@x.com' })).status, 400, 'only 5 sign-ups on this link');
  const list = (await a.get('/invites')).body;
  assert.deepEqual(list[0].emailed.map((e) => e.email), ['m1@x.com', 'm2@x.com', 'm3@x.com']);

  await a.del(`/invites/${r.body.id}`);
  assert.equal((await a.post(`/invites/${r.body.id}/email`, { emails: 'm4@x.com' })).status, 410);
});

test('emailing an invite needs email switched on', async (t) => {
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  t.after(() => { if (key !== undefined) process.env.RESEND_API_KEY = key; });
  const { a, team } = await setup(t);
  const r = await a.post('/invites', { role: 'manager', team_id: team, emails: 'm1@x.com' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Email isn’t switched on/);
});

// ---------- payments ----------

test('IBAN and routing number checks', () => {
  assert.equal(ibanValid('DE89370400440532013000'), '');
  assert.equal(ibanValid('GB82WEST12345698765432'), '');
  assert.match(ibanValid('DE89370400440532013001'), /typo/);
  assert.match(ibanValid('DE8937040044053201300'), /22 characters/);
  assert.ok(routingValid('021000021'));
  assert.ok(!routingValid('021000022'));
});

test('payments: managers and enabled reps save payout details; encrypted; admins reveal with an audit trail', async (t) => {
  const sent = fakeResend(t);
  const { db, a, makeUser } = await setup(t);
  const mgr = await makeUser('mgr', 'manager');
  const rep = await makeUser('rep2', 'rep');

  assert.equal((await mgr.get('/me')).body.payments, true);
  assert.equal((await rep.get('/me')).body.payments, false);
  assert.equal((await rep.get('/payments/me')).status, 403);
  assert.ok((await rep.get('/payments/meta')).body.countries.some((c) => c.code === 'MX' && c.name === 'Mexico'));

  const bank = { method: 'bank', country: 'DE', holder_name: 'Max Mustermann', bank_name: 'Commerzbank', format: 'iban', iban: 'DE89 3704 0044 0532 0130 00', swift: 'COBADEFFXXX' };
  assert.equal((await mgr.put('/payments/me', { ...bank, password: 'wrong' })).status, 400, 'needs their password');
  assert.match((await mgr.put('/payments/me', { ...bank, country: 'FR', password: 'mgr-pass-1' })).body.error, /from Germany/);
  assert.match((await mgr.put('/payments/me', { ...bank, iban: 'DE89370400440532013001', password: 'mgr-pass-1' })).body.error, /typo/);
  const saved = await mgr.put('/payments/me', { ...bank, password: 'mgr-pass-1' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.payout.summary, 'IBAN DE•• •••• 3000');
  assert.ok(!JSON.stringify(saved.body).includes('0532'), 'the user sees only the masked version');
  assert.ok(!JSON.stringify((await mgr.get('/payments/me')).body).includes('0532'));

  // Encrypted at rest.
  const row = db.prepare('SELECT * FROM payout_methods').get();
  assert.ok(!row.secret.includes('DE89'));
  assert.ok(!row.secret.includes('Commerzbank'));

  // Admin was told; the manager got a "details changed" email.
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE message LIKE '%added their payout details%'").get());
  assert.ok(sent.some((m) => m.to[0] === 'mgr@x.com' && /payout details were changed/.test(m.subject)));

  // US bank account: routing number required and checked.
  assert.match((await mgr.put('/payments/me', { method: 'bank', country: 'US', holder_name: 'M', bank_name: 'Chase', account_number: '123456789', routing_number: '021000022', password: 'mgr-pass-1' })).body.error, /routing/);
  const us = await mgr.put('/payments/me', { method: 'bank', country: 'US', holder_name: 'M', bank_name: 'Chase', account_number: '123456789', routing_number: '021000021', account_type: 'savings', password: 'mgr-pass-1' });
  assert.equal(us.body.payout.summary, 'Chase •••• 6789');

  // Admin switches payments on for a rep, who then adds Bit.
  assert.equal((await mgr.patch(`/users/${db.prepare("SELECT id FROM users WHERE username='rep2'").get().id}/payments`, { enabled: true })).status, 403);
  const repId = db.prepare("SELECT id FROM users WHERE username = 'rep2'").get().id;
  assert.equal((await a.patch(`/users/${repId}/payments`, { enabled: true })).status, 200);
  assert.equal((await rep.get('/me')).body.payments, true);
  const bit = await rep.put('/payments/me', { method: 'bit', country: 'IL', holder_name: 'Dana Levi', bit_phone: '+972 50-123-4567', password: 'rep2-pass-1' });
  assert.equal(bit.body.payout.summary, 'Bit •••• 4567');
  assert.equal((await rep.put('/payments/me', { method: 'bitcoin', country: 'US', holder_name: 'D', wallet: 'nope', password: 'rep2-pass-1' })).status, 400);

  // Only admins list and reveal.
  assert.equal((await mgr.get('/payments')).status, 403);
  assert.equal((await mgr.post(`/payments/${repId}/reveal`)).status, 403);
  const all = (await a.get('/payments')).body;
  assert.ok(all.find((x) => x.username === 'mgr').summary);
  assert.ok(!JSON.stringify(all).includes('123456789'));
  const shown = await a.post(`/payments/${repId}/reveal`);
  assert.equal(shown.status, 200);
  assert.equal(shown.body.details.bit_phone, '+972501234567');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment.reveal'").get());

  // Turned off again: the rep loses the tab.
  await a.patch(`/users/${repId}/payments`, { enabled: false });
  assert.equal((await rep.get('/payments/me')).status, 403);
});
