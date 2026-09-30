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
  assert.deepEqual(p, { name: 'Ana Ruiz', phone: '214 555 7788', email: '', address: '9 Pine Ct', notes: 'call after 5', services: [] });
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
