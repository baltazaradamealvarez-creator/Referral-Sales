'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, normalizeEmail, addressKey, parseLeadText } = require('../src/normalize');

test('phone normalizes common formats to the same 10 digits', () => {
  for (const p of ['(512) 555-0142', '512.555.0142', '+1 512 555 0142', '15125550142', '512-555-0142']) {
    assert.equal(normalizePhone(p), '5125550142', p);
  }
  assert.equal(normalizePhone('555-0142'), '');
});

test('email normalizes case and whitespace', () => {
  assert.equal(normalizeEmail('  Jane.Doe@Gmail.COM '), 'jane.doe@gmail.com');
});

test('address variants map to the same key', () => {
  const a = addressKey('123 North Main Street, Apt 4B, Austin, TX 78701');
  const b = addressKey('123 N. Main St #4b Austin TX 78701-1234');
  const c = addressKey('123 n main st apartment 4B');
  assert.equal(a.street, '123 n main st apt 4b');
  assert.equal(b.street, a.street);
  assert.equal(c.street, a.street);
  assert.equal(a.zip, '78701');
  assert.equal(b.zip, '78701');
  assert.equal(c.zip, '');
});

test('different units are different addresses', () => {
  assert.notEqual(addressKey('50 Oak Ave Apt 1').street, addressKey('50 Oak Ave Apt 2').street);
});

test('address without a house number yields no key', () => {
  assert.equal(addressKey('Main Street').street, '');
});

test('parses a free-form blob', () => {
  const p = parseLeadText('Jane Smith\n512-555-0142\njane@email.com\n123 Main St, Austin TX 78701\nwants internet + mobile');
  assert.equal(p.name, 'Jane Smith');
  assert.equal(p.phone, '512-555-0142');
  assert.equal(p.email, 'jane@email.com');
  assert.equal(p.address, '123 Main St, Austin TX 78701');
  assert.equal(p.notes, 'wants internet + mobile');
});

test('parses a single line', () => {
  const p = parseLeadText('John Doe 9725551234 john@x.com 45 Elm Rd Dallas TX 75001');
  assert.equal(p.email, 'john@x.com');
  assert.equal(normalizePhone(p.phone), '9725551234');
  assert.equal(p.name, 'John Doe');
  assert.equal(p.address, '45 Elm Rd Dallas TX 75001');
});

test('parses labelled lines', () => {
  const p = parseLeadText('Name: Ana Ruiz\nPhone: 214 555 7788\nAddress: 9 Pine Ct\nNotes: call after 5');
  assert.deepEqual(p, { name: 'Ana Ruiz', phone: '214 555 7788', email: '', address: '9 Pine Ct', city: '', state: '', zip: '', notes: 'call after 5', dob: '', services: [] });
});

test('date of birth: labelled (English or Spanish), or an unlabelled birth-year date', () => {
  const { parseDob } = require('../src/normalize');
  for (const [v, want] of [['01/31/1980', '1980-01-31'], ['1-31-80', '1980-01-31'], ['1980-01-31', '1980-01-31'], ['Jan 31, 1980', '1980-01-31'],
    ['31 Jan 1980', '1980-01-31'], ['March 5th 1975', '1975-03-05'], ['02/30/1980', ''], ['13/01/1980', ''], ['01/31/2020', ''], ['soon', '']]) {
    assert.equal(parseDob(v), want, v);
  }
  assert.equal(parseLeadText('Maria Lopez\nDOB: 03/14/1985\n512-867-5309').dob, '1985-03-14');
  assert.equal(parseLeadText('Fecha de nacimiento: 14 mar 1985\nMaria').dob, '1985-03-14');
  const p = parseLeadText('Maria Lopez 512-867-5309 born 03/14/1985 install 10/05/2026');
  assert.equal(p.dob, '1985-03-14');
  assert.match(p.notes, /install 10\/05\/2026/, 'a future date is not a birthday');
  const bad = parseLeadText('Maria Lopez\nDOB: sometime in May');
  assert.equal(bad.dob, '');
  assert.match(bad.notes, /DOB: sometime in May/, 'kept in the notes');
});

test('finds an address in the middle of a sentence and keeps the rest as notes', () => {
  const p = parseLeadText('jane smith 5125550142 wants internet and tv at 123 main st austin tx 78701 call after 5pm');
  assert.equal(p.name, 'Jane Smith');
  assert.equal(p.address, '123 main st austin tx 78701');
  assert.equal(p.notes, 'wants internet and tv\ncall after 5pm');
  assert.deepEqual(p.services, ['Internet', 'TV']);
});

test('keeps unknown labels, extra phones, and builds address from city/zip labels', () => {
  const p = parseLeadText('Name: Ana Ruiz\nPhone: 214 555 7788\nAddress: 9 Pine Ct\nCity: Plano\nZip: 75023\n'
    + 'Current provider: AT&T\nOther number 214-555-9999\nServices: internet, mobile');
  assert.equal(p.address, '9 Pine Ct, Plano, 75023');
  assert.match(p.notes, /Current provider: AT&T/);
  assert.match(p.notes, /Alt phone: 214-555-9999/);
  assert.deepEqual(p.services, ['Internet', 'Mobile']);
});

// ---------- lead score ----------
const { scoreLead, checkName, checkPhone, checkEmail } = require('../public/leadscore');

test('lead score: complete real lead is green, gaps lower it, fakes cap it', () => {
  const full = scoreLead({ name: 'Maria Lopez', phone: '512-867-5309', email: 'maria.lopez@gmail.com', address: '123 Main St, Austin TX 78701', services: ['Internet'] });
  assert.equal(full.score, 100);
  assert.equal(full.band, 'Strong');
  const partial = scoreLead({ name: 'Maria', phone: '512-867-5309' });
  assert.ok(partial.score > 20 && partial.score < 60, String(partial.score));
  assert.ok(partial.tips.includes('Add the last name too.'));
  const fake = scoreLead({ name: 'Test Test', phone: '512-867-5309', email: 'maria@gmail.com', address: '123 Main St, Austin TX 78701', services: ['TV'] });
  assert.ok(fake.score <= 15);
  assert.equal(fake.fakes[0].field, 'name');
});

test('fake detection: names, phones and emails', () => {
  for (const n of ['test', 'Fake Name', 'asdf', 'N/A', 'Unknown', 'Mickey Mouse', 'Jon 3', 'Qwerty Smith', 'Aaaa Bbbb', 'Xzkrtp Jones']) {
    assert.equal(checkName(n).level, 'fake', n);
  }
  for (const n of ['Maria Lopez', 'Nguyen Tran', 'José García', "Mary-Jane O'Neil", 'Xi Li', 'Albert Werth']) assert.equal(checkName(n).level, 'ok', n);
  assert.equal(checkName('John Doe').level, 'warn');
  assert.equal(checkName('Madonna').level, 'warn');
  for (const p of ['111-111-1111', '123-456-7890', '555-222-3333', '012-345-6789', '212-011-2222', '911-222-3333', '512-555']) assert.equal(checkPhone(p).level, 'fake', p);
  assert.equal(checkPhone('512-555-0142').level, 'warn');
  assert.equal(checkPhone('+1 (512) 867-5309').level, 'ok');
  for (const e of ['x@mailinator.com', 'test@gmail.com', 'none@yahoo.com', 'a@example.com', 'jane@']) assert.equal(checkEmail(e).level, 'fake', e);
  assert.deepEqual(checkEmail('jane@gmial.com'), { level: 'warn', msg: 'Did you mean @gmail.com?', fix: 'jane@gmail.com' });
  assert.equal(checkEmail('jane.doe@company.co.uk').level, 'ok');
});
