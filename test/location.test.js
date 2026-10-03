'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { parseAddressLocation, parseLeadText, addressKey, extractStateFromAddress, normalizeZip } = require('../src/normalize');
const { fill } = require('../public/waformat');

test('postal locality parsing distinguishes state/ZIP from street, house and apartment numbers', () => {
  for (const [address, want] of [
    ['123 Main St, Austin TX 78701', { city: 'Austin', state: 'TX', zip: '78701' }],
    ['1010 Ogden Ave, Dallas, TX 75211', { city: 'Dallas', state: 'TX', zip: '75211' }],
    ['12345 Main St Austin TX 78701-1234', { city: 'Austin', state: 'TX', zip: '78701-1234' }],
    ['22 Ohio Road, Dallas, Texas 75211', { city: 'Dallas', state: 'TX', zip: '75211' }],
    ['1 Washington Ave, Boston MA 02110, USA', { city: 'Boston', state: 'MA', zip: '02110' }],
    ['5900 Armstrong, Dallas, TX 75205', { city: 'Dallas', state: 'TX', zip: '75205' }],
    ['12 Main St Apt #4 Austin TX 78701', { city: 'Austin', state: 'TX', zip: '78701' }],
    ['9 Pine Ct, Plano, 75023', { city: 'Plano', state: '', zip: '75023' }],
    ['77 Elm Rd, Puerto Rico 00901', { city: '', state: 'PR', zip: '00901' }],
  ]) assert.deepEqual(parseAddressLocation(address), want, address);
  for (const address of ['1 Texas Avenue', '22 Ohio Road', '123 Main St NW', '12345 Main St', '123 Main St Apt #12345']) {
    assert.deepEqual(parseAddressLocation(address), { city: '', state: '', zip: '' }, address);
    assert.equal(extractStateFromAddress(address), null, address);
    assert.equal(addressKey(address).zip, '', address);
  }
  assert.equal(parseAddressLocation('123 Texas 78701').state, '', 'a street name without a suffix is not reliable state evidence');
  assert.equal(parseAddressLocation('1 Main St CT 78701').state, '', 'CT could mean court');
  assert.equal(parseAddressLocation('123 Main Street Joseph Lane Austin TX 78701').city, '', 'multiple street suffixes make the city ambiguous');
  assert.equal(addressKey('12345 Main St Austin TX 78701-1234').zip, '78701');
  assert.equal(normalizeZip('021101234'), '02110-1234');
  assert.equal(normalizeZip('2110'), '', 'do not guess a missing leading digit');
});

test('pasted and labelled location information becomes separate fields without losing the street or notes', () => {
  const pasted = parseLeadText('12345 Main St\nAustin TX 78701\nJane Smith\n512-867-5309\nCall after 5');
  assert.equal(pasted.name, 'Jane Smith');
  assert.equal(pasted.address, '12345 Main St, Austin TX 78701');
  assert.equal(pasted.city, 'Austin');assert.equal(pasted.state, 'TX');assert.equal(pasted.zip, '78701');
  assert.match(pasted.notes, /Call after 5/);
  const labelled = parseLeadText('Name: Ana Ruiz\nAddress: 9 Pine Ct\nCity: Plano\nState: Texas\nZIP: 75023-1234');
  assert.equal(labelled.city, 'Plano');assert.equal(labelled.state, 'TX');assert.equal(labelled.zip, '75023-1234');
  const name = parseLeadText('Nina Mo\n123 Main St, Austin TX 78701');
  assert.equal(name.name, 'Nina Mo');assert.equal(name.city, 'Austin');assert.equal(name.state, 'TX');
  const text = fill({ customer_name: 'Ana Ruiz', address: '9 Pine Ct', city: 'Plano', state: 'TX', zip: '75023' }).text;
  assert.match(text, /9 Pine Ct, Plano, TX, 75023/);
  const complete = fill({ address: '9 Pine Ct, Plano TX 75023', city: 'Plano', state: 'TX', zip: '75023' }, '{address}').text;
  assert.equal(complete, '9 Pine Ct, Plano TX 75023', 'do not duplicate the same locality in group posts');
  assert.equal(fill({ address: '9 Pine Ct, Plano Texas 75023', city: 'Plano', state: 'TX', state_name: 'Texas', zip: '75023' }, '{address}').text, '9 Pine Ct, Plano Texas 75023');
  assert.equal(fill({ address: '1 Texas Avenue', city: 'Austin', state: 'TX', state_name: 'Texas', zip: '78701' }, '{address}').text, '1 Texas Avenue, Austin, TX, 78701');
});

async function setup(t) {
  const db = openDb(':memory:');
  const admin = ensureAdmin(db, () => {});
  const app = createApp(db);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { app.locals.whatsapp.stop();server.close(); });
  let cookie = '';
  const call = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call('POST', '/login', { username: admin.username, password: admin.password })).status, 200);
  assert.equal((await call('POST', '/me/password', { current: admin.password, next: 'admin-pass-1' })).status, 200);
  return { db, call };
}

test('CRM persists pasted, suggested and edited locality, validates changes and groups reports by the saved state', async t => {
  const { db, call } = await setup(t);
  const first = await call('POST', '/referrals', { text: 'Jane Smith\n512-867-5309\n22 Ohio Road, Dallas, Texas 75211' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.city, 'Dallas');assert.equal(first.body.state, 'TX');assert.equal(first.body.zip, '75211');
  const second = await call('POST', '/referrals', { name: 'Ana Ruiz', phone: '5128675310', address: '9 Pine Ct', city: 'Plano', state: 'Texas', zip: '750231234' });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.state, 'TX');assert.equal(second.body.zip, '75023-1234');
  assert.equal(db.prepare('SELECT address_zip FROM referrals WHERE id=?').get(second.body.id).address_zip, '75023');
  assert.equal((await call('POST', '/referrals', { name: 'Another Customer', phone: '5128675311', address: '9 Pine Court', zip: '75023' })).status, 409, 'ZIP+4 still matches a five-digit duplicate ZIP');
  let updated = await call('PATCH', `/referrals/${second.body.id}`, { address: '45 Oak Avenue, Boston MA 02110' });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.city, 'Boston');assert.equal(updated.body.state, 'MA');assert.equal(updated.body.zip, '02110');
  updated = await call('PATCH', `/referrals/${second.body.id}`, { state: 'New York', zip: '10001-1234' });
  assert.equal(updated.body.state, 'NY');assert.equal(updated.body.zip, '10001-1234');
  assert.equal((await call('PATCH', `/referrals/${second.body.id}`, { state: 'XX' })).status, 400);
  assert.equal((await call('PATCH', `/referrals/${second.body.id}`, { zip: '1000' })).status, 400);
  const overridden = await call('POST', '/referrals', { text: 'Name: Omar Diaz\nPhone: 5128675312\nAddress: 1 Old St\nCity: Austin\nState: TX\nZIP: 78701', address: '99 New Rd, Phoenix AZ 85001' });
  assert.equal(overridden.status, 201, JSON.stringify(overridden.body));
  assert.equal(overridden.body.city, 'Phoenix');assert.equal(overridden.body.state, 'AZ');assert.equal(overridden.body.zip, '85001');
  // Imported full state names should filter correctly too, without mistaking Ohio Road for Ohio.
  db.prepare('UPDATE referrals SET state=? WHERE id=?').run('Texas', first.body.id);
  const report = await call('POST', '/reports', { name: 'Regional test', config: { group_by: 'state', filters: [{ field: 'state', value: 'Texas' }] } });
  const rows = await call('POST', `/reports/${report.body.id}/run`, {});
  assert.equal(rows.body.total_records, 1, JSON.stringify(rows.body));
  assert.equal(rows.body.rows[0].state, 'TX');
});

test('v20 repairs only missing, unambiguous historical fields and preserves lead history and existing values', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'location-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  let db = openDb(file);
  db.exec("INSERT INTO users(id,username,full_name,password_hash,role) VALUES(1,'owner','Owner','unused','admin');");
  const add = db.prepare(`INSERT INTO referrals(id,customer_name,created_by,status,address,city,state,zip,raw_text,updated_at,first_touch_at)
    VALUES(?,'Historical Customer',1,'Ordered',?,?,?,?,?,'2026-01-02 12:00:00','2026-01-02 13:00:00')`);
  add.run(1, '12345 Main St, Austin TX 78701-1234', '', '', '', '');
  add.run(2, '9 Pine Ct', '', '', '', 'Name: Ana Ruiz\nAddress: 9 Pine Ct\nCity: Plano\nState: Texas\nZIP: 75023');
  add.run(3, '1 Main St, Boston MA 02110', '', '', '', '');
  add.run(4, '45 New Rd', '', '', '', 'Address: 99 Old St\nCity: Austin\nState: TX\nZIP: 78701');
  add.run(5, '9 Pine Ct, Plano TX 75023', 'Dallas', '', '75211', '');
  add.run(6, '1 Texas Avenue Apt 12345', '', '', '', '');
  add.run(7, '8 Oak Street, Austin TX 78701', 'Austin', 'Texas', '78701', '');
  add.run(8, '77 Elm Rd, San Juan PR 00901', 'San Juan', '', '', '');
  add.run(9, '4 Main Street, Boston MA 02110', 'Unknown', 'N/A', 'Not provided', '');
  db.exec(`INSERT INTO comments(referral_id,user_id,body,source) VALUES(1,1,'Keep this note','whatsapp');
    INSERT INTO wa_messages(id,chat,referral_id,kind) VALUES('old-post','1203630@g.us',1,'lead');
    INSERT INTO status_history(referral_id,user_id,from_status,to_status) VALUES(1,1,'Working','Ordered');
    INSERT INTO notifications(user_id,referral_id,message) VALUES(1,1,'Existing alert');
    INSERT OR REPLACE INTO settings(key,value) VALUES('wa_new_lead_group','0'); PRAGMA user_version=19;`);
  const before = db.prepare('SELECT * FROM referrals ORDER BY id').all();
  db.close();db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
  const rows = db.prepare('SELECT * FROM referrals ORDER BY id').all();
  const locality = id => Object.fromEntries(['city','state','zip'].map(field => [field, rows[id - 1][field]]));
  assert.deepEqual(locality(1), { city: 'Austin', state: 'TX', zip: '78701-1234' });
  assert.equal(rows[0].address_zip, '78701');
  assert.deepEqual(locality(2), { city: 'Plano', state: 'TX', zip: '75023' });
  assert.deepEqual(locality(3), { city: 'Boston', state: 'MA', zip: '02110' });
  assert.deepEqual(locality(4), { city: '', state: '', zip: '' }, 'edited street cannot use an obsolete pasted address');
  assert.deepEqual(locality(5), { city: 'Dallas', state: '', zip: '75211' }, 'conflicting address must be reviewed');
  assert.deepEqual(locality(6), { city: '', state: '', zip: '' }, 'do not guess from a street name or apartment number');
  assert.deepEqual(locality(7), { city: 'Austin', state: 'Texas', zip: '78701' }, 'keep existing values');
  assert.deepEqual(locality(8), { city: 'San Juan', state: 'PR', zip: '00901' });
  assert.deepEqual(locality(9), { city: 'Boston', state: 'MA', zip: '02110' }, 'explicit placeholders count as missing fields');
  for (let i = 0; i < before.length; i++) for (const field of Object.keys(before[i]).filter(field => !['city','state','zip','address_zip'].includes(field))) {
    assert.equal(rows[i][field], before[i][field], `lead ${i + 1}: ${field}`);
  }
  for (const table of ['comments','wa_messages','status_history','notifications']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);
  const summary = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='location_repair_v20'").get().value);
  assert.equal(summary.leads, 5);assert.equal(summary.conflicts, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wa_new_lead_group'").get().value, '0', 'location repair never changes messaging preferences');
  db.close();db = openDb(file);
  try { assert.deepEqual(db.prepare('SELECT * FROM referrals ORDER BY id').all(), rows, 'restart is idempotent'); }
  finally { db.close(); }
});
