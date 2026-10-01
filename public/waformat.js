// Fills the admin's WhatsApp message template for a lead. Shared by the browser
// (Copy for WhatsApp) and the server (automatic posts to the dispatch group), so both
// always look the same.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WaFormat = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const DEFAULT_TEMPLATE = '*New referral #{id}*\n👤 *Name:* {name}\n📞 *Phone:* {phone}\n🏠 *Address:* {address}\n🎂 *Date of birth:* {dob}\n✉️ *Email:* {email}\n📦 *Services:* {services}\n📝 *Notes:* {notes}\n🙋 *Rep:* {rep}';
  const FIELDS = ['id', 'name', 'phone', 'alt_phone', 'address', 'dob', 'email', 'services', 'notes', 'rep', 'team', 'company', 'status'];
  const OPTIONAL = new Set(['notes', 'alt_phone', 'company', 'team', 'services']);
  const DISPATCH_NEEDS = [['name', 'name'], ['phone', 'phone'], ['address', 'address'], ['dob', 'date of birth'], ['email', 'email']];

  const usDate = (ymd) => (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}` : '');

  // r: a referral (customer_name, phone, address, city, zip, dob, email, services, notes, created_by_name, team_name …)
  // Lines with only optional, empty fields are left out; empty required ones show "—".
  function fill(r, template, fallbackRep) {
    const address = String(r.address || '');
    const extra = [
      r.city && !address.toLowerCase().includes(String(r.city).toLowerCase()) ? r.city : '',
      r.zip && !address.includes(r.zip) ? r.zip : '',
    ];
    const v = {
      id: r.id || '', name: r.customer_name || r.name || '', phone: r.phone || '', alt_phone: r.alt_phone || '',
      address: [address, ...extra].filter(Boolean).join(', '), dob: usDate(r.dob), email: r.email || '',
      services: r.services || '', notes: String(r.notes || '').trim(), company: r.company || '',
      rep: r.created_by_name || fallbackRep || '', team: r.team_name || '', status: r.status || '',
    };
    const lines = String(template || DEFAULT_TEMPLATE).split('\n').map((line) => {
      const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (keys.length && keys.every((k) => !v[k]) && keys.every((k) => OPTIONAL.has(k))) return null;
      return line.replace(/\{(\w+)\}/g, (all, k) => (k in v ? (v[k] || '—') : all));
    }).filter((l) => l !== null);
    const missing = DISPATCH_NEEDS.filter(([k]) => !v[k]).map(([, label]) => label);
    return { text: lines.join('\n'), missing };
  }

  return { fill, usDate, DEFAULT_TEMPLATE, FIELDS };
}));
