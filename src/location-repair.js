'use strict';

const { parseAddressLocation, parseLeadText, addressKey, normalizeZip, normalizeState } = require('./normalize');
const blank = value => /^(?:|n\/a|unknown|not provided)$/i.test(String(value || '').trim());
const cityKey = value => String(value || '').toLowerCase().replace(/[^\p{L}]/gu, '');

// Only fill missing fields using the current address or explicitly labelled
// source text whose street still matches. Never replace a meaningful value or
// infer a locality from a phone area code or a nearby lead.
function repairLocations(db) {
  const summary = { leads: 0, city: 0, state: 0, zip: 0, conflicts: 0 };
  const update = db.prepare('UPDATE referrals SET city=?, state=?, zip=?, address_zip=? WHERE id=?');
  const rows = db.prepare(`SELECT id,address,city,state,zip,address_zip,raw_text FROM referrals
    WHERE lower(trim(city)) IN ('','n/a','unknown','not provided')
      OR lower(trim(state)) IN ('','n/a','unknown','not provided')
      OR lower(trim(zip)) IN ('','n/a','unknown','not provided')`).all();
  for (const row of rows) {
    const inferred = parseAddressLocation(row.address);
    if ((!blank(row.city) && inferred.city && cityKey(row.city) !== cityKey(inferred.city))
      || (!blank(row.state) && inferred.state && normalizeState(row.state)?.code !== inferred.state)
      || (!blank(row.zip) && inferred.zip && normalizeZip(row.zip).slice(0, 5) !== inferred.zip.slice(0, 5))) {
      summary.conflicts++;
      continue;
    }
    if (row.raw_text) {
      const raw = parseLeadText(row.raw_text);
      const street = addressKey(row.address).street;
      const originalStreet = addressKey(raw.address).street;
      const currentZip = normalizeZip(row.zip) || inferred.zip;
      const currentState = normalizeState(row.state)?.code || inferred.state;
      const agrees = street && street === originalStreet
        && (blank(row.city) || !raw.city || cityKey(row.city) === cityKey(raw.city))
        && (!currentZip || !raw.zip || currentZip.slice(0, 5) === normalizeZip(raw.zip).slice(0, 5))
        && (!currentState || !raw.state || currentState === normalizeState(raw.state)?.code);
      if (agrees) for (const field of ['city', 'state', 'zip']) if (!inferred[field]) inferred[field] = raw[field];
    }
    const next = { city: row.city, state: row.state, zip: row.zip };
    for (const field of ['city', 'state', 'zip']) {
      const value = field === 'zip' ? normalizeZip(inferred.zip) : field === 'state' ? normalizeState(inferred.state)?.code || '' : inferred.city;
      if (blank(row[field]) && value) {
        next[field] = value;
        summary[field]++;
      }
    }
    if (next.city !== row.city || next.state !== row.state || next.zip !== row.zip) {
      // A newly recovered ZIP participates in duplicate checks using its first 5 digits.
      const keyZip = next.zip !== row.zip ? next.zip.slice(0, 5) : row.address_zip;
      update.run(next.city, next.state, next.zip, keyZip, row.id);
      summary.leads++;
    }
  }
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('location_repair_v20', JSON.stringify(summary));
  return summary;
}
module.exports = { repairLocations };
