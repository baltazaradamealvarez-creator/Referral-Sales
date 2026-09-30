'use strict';

// Past sales: an admin uploads old sales spreadsheets, and every phone number and
// address in them blocks new leads as duplicates. The rows are never shown anywhere:
// only the normalized phone/address keys are kept, never names or account numbers.

const { readSpreadsheet } = require('./sheets');
const { normalizePhone, addressKey, looksLikeStreet } = require('./normalize');

const MAX_BYTES = 10 * 1024 * 1024;

const H = {
  phone: /\b(phone|mobile|cell|telephone|tel|contact ?(number|#|no)|btn)\b/i,
  notPhone: /confirm|account|acct|order|ext\b/i,
  addr1: /(address|street|addr\b)/i,
  addr2: /(line ?2|addr(ess)? ?2)|^\s*(apt|apartment|unit|suite)\s*(#|no\.?|number)?\s*$/i,
  notAddr: /e-?mail|\bip\b|mac|web|url/i,
  city: /\bcity\b/i,
  state: /^\s*(state|st)\s*$|\bstate\b/i,
  zip: /\bzip|postal/i,
};

// Finds a header row (within the first rows of a sheet) that names phone or address columns.
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const row = rows[r];
    const cols = { phone: [], addr1: -1, addr2: -1, city: -1, state: -1, zip: -1 };
    row.forEach((raw, i) => {
      const h = String(raw || '').trim();
      if (!h || h.length > 40 || /\d{2,}/.test(h)) return; // headers are short labels, not data
      if (H.phone.test(h) && !H.notPhone.test(h)) cols.phone.push(i);
      else if (H.city.test(h)) { if (cols.city < 0) cols.city = i; } else if (H.zip.test(h)) { if (cols.zip < 0) cols.zip = i; } else if (H.state.test(h)) { if (cols.state < 0) cols.state = i; } else if (H.addr2.test(h) && !H.notAddr.test(h)) { if (cols.addr2 < 0) cols.addr2 = i; } else if (H.addr1.test(h) && !H.notAddr.test(h) && cols.addr1 < 0) cols.addr1 = i;
    });
    if (cols.phone.length || cols.addr1 >= 0) return { row: r, cols, header: row.map((x) => String(x || '').trim().toLowerCase()).join('|') };
  }
  return null;
}

const cellText = (v) => String(v ?? '').trim();
const zip5 = (v) => {
  const d = cellText(v).replace(/\.0+$/, '');
  if (/^\d{3,4}$/.test(d)) return d.padStart(5, '0'); // Excel drops leading zeros
  const m = d.match(/^(\d{5})(-\d{4})?$/);
  return m ? m[1] : '';
};
// Phones written like one ("(512) 555-0142", "512-555-0142"), not bare 10-digit numbers,
// which in sales sheets are usually confirmation or order numbers.
const FORMATTED_PHONE = /^\+?1?[\s.-]*\(?\d{3}\)?[\s.-]+\d{3}[\s.-]\d{4}$/;

// Returns { phones: Map(key -> ''), addresses: Map('key|zip' -> {key, zip}), rows, sheets: [...] }
function extractContacts(sheets) {
  const phones = new Set();
  const addresses = new Map();
  const summary = [];
  let rowsRead = 0;
  const addAddress = (text, zipHint = '') => {
    const k = addressKey(text);
    if (!k.street) return false;
    const zip = zipHint || k.zip || '';
    addresses.set(`${k.street}|${zip}`, { key: k.street, zip });
    return true;
  };
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows);
    let p = 0;
    let a = 0;
    const start = header ? header.row + 1 : 0;
    for (let r = start; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      if (!row.some((c) => cellText(c))) continue;
      rowsRead++;
      if (header) {
        // Combined files repeat the header row; skip those.
        if (row.map((x) => String(x || '').trim().toLowerCase()).join('|') === header.header) continue;
        const { cols } = header;
        for (const i of cols.phone) {
          const k = normalizePhone(row[i]);
          if (k) { phones.add(k); p++; }
        }
        if (cols.addr1 >= 0 && cellText(row[cols.addr1])) {
          const line1 = cellText(row[cols.addr1]);
          const line2 = cols.addr2 >= 0 ? cellText(row[cols.addr2]) : '';
          const zip = cols.zip >= 0 ? zip5(row[cols.zip]) : '';
          const full = [`${line1}${line2 ? ` ${line2}` : ''}`, cols.city >= 0 ? cellText(row[cols.city]) : '', `${cols.state >= 0 ? cellText(row[cols.state]) : ''} ${zip}`.trim()]
            .filter(Boolean).join(', ');
          if (addAddress(full, zip)) a++;
        }
      } else {
        // No header: pick out cells that look like a street address or a formatted phone number.
        for (const c of row) {
          const t = cellText(c);
          if (!t) continue;
          if (looksLikeStreet(t)) { if (addAddress(t)) a++; } else if (FORMATTED_PHONE.test(t)) {
            const k = normalizePhone(t);
            if (k) { phones.add(k); p++; }
          }
        }
      }
    }
    summary.push({ name: sheet.name, rows: sheet.rows.length, phones: p, addresses: a, mode: header ? 'columns' : 'scan' });
  }
  return { phones, addresses, rows: rowsRead, sheets: summary };
}

function mount(app, db, { requireRole, wrap, HttpError, logAudit }) {
  app.post('/api/history/import', wrap((req, res) => {
    const u = requireRole(req, 'admin');
    const b = req.body || {};
    const fileName = String(b.file_name || 'upload').slice(0, 200);
    const data = String(b.data || '');
    if (!data) throw new HttpError(400, 'Choose a file to upload.');
    const buf = Buffer.from(data, 'base64');
    if (buf.length > MAX_BYTES) throw new HttpError(413, 'That file is over 10 MB. Split it into smaller files.');
    let sheets;
    try {
      sheets = readSpreadsheet(buf, fileName);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const found = extractContacts(sheets);
    const result = {
      file_name: fileName, rows: found.rows, phones: found.phones.size, addresses: found.addresses.size, sheets: found.sheets,
    };
    if (!found.phones.size && !found.addresses.size) {
      throw new HttpError(400, 'We didn’t find any phone numbers or street addresses in that file. Make sure it has a Phone or Address column.');
    }
    // Preview: counts plus how many are new (not already blocked).
    const phoneKnown = db.prepare("SELECT 1 FROM history_contacts WHERE kind = 'phone' AND key = ? LIMIT 1");
    const addrKnown = db.prepare("SELECT 1 FROM history_contacts WHERE kind = 'address' AND key = ? AND zip = ? LIMIT 1");
    result.new_phones = [...found.phones].filter((k) => !phoneKnown.get(k)).length;
    result.new_addresses = [...found.addresses.values()].filter((x) => !addrKnown.get(x.key, x.zip)).length;
    if (!b.commit) return { preview: true, ...result };

    db.exec('BEGIN IMMEDIATE');
    let id;
    try {
      const r = db.prepare('INSERT INTO history_imports (file_name, note, uploaded_by, rows_read, phones, addresses) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fileName, String(b.note || '').trim().slice(0, 200), u.id, found.rows, found.phones.size, found.addresses.size);
      id = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT OR IGNORE INTO history_contacts (import_id, kind, key, zip) VALUES (?, ?, ?, ?)');
      for (const k of found.phones) ins.run(id, 'phone', k, '');
      for (const x of found.addresses.values()) ins.run(id, 'address', x.key, x.zip);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    logAudit(req, 'history.import', 'history_import', id, `${fileName}: ${found.phones.size} phones, ${found.addresses.size} addresses`);
    res.status(201);
    return { id, ...result };
  }));

  app.get('/api/history/imports', wrap((req) => {
    requireRole(req, 'admin');
    const imports = db.prepare(`SELECT h.id, h.file_name, h.note, h.rows_read, h.phones, h.addresses, h.created_at, u.full_name AS uploaded_by_name
      FROM history_imports h LEFT JOIN users u ON u.id = h.uploaded_by ORDER BY h.id DESC`).all();
    const totals = db.prepare(`SELECT
        (SELECT COUNT(DISTINCT key) FROM history_contacts WHERE kind = 'phone') AS phones,
        (SELECT COUNT(*) FROM (SELECT DISTINCT key, zip FROM history_contacts WHERE kind = 'address')) AS addresses,
        (SELECT COUNT(*) FROM duplicate_attempts WHERE matched_on LIKE '%past sale%') AS blocked`).get();
    return { imports, totals };
  }));

  app.delete('/api/history/imports/:id', wrap((req) => {
    requireRole(req, 'admin');
    const row = db.prepare('SELECT * FROM history_imports WHERE id = ?').get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Upload not found.');
    db.prepare('DELETE FROM history_imports WHERE id = ?').run(row.id);
    logAudit(req, 'history.delete', 'history_import', row.id, row.file_name);
    return { ok: true };
  }));
}

// Used by the duplicate check. which: { phone: bool, address: bool } says which keys to test.
function historyMatch(db, keys, which = { phone: true, address: true }) {
  if (which.phone && keys.phone && db.prepare("SELECT 1 FROM history_contacts WHERE kind = 'phone' AND key = ? LIMIT 1").get(keys.phone)) {
    return 'phone · past sale';
  }
  if (which.address && keys.address && db.prepare(`SELECT 1 FROM history_contacts WHERE kind = 'address' AND key = ?
      AND (? = '' OR zip = '' OR zip = ?) LIMIT 1`).get(keys.address, keys.zip || '', keys.zip || '')) {
    return 'address · past sale';
  }
  return null;
}

module.exports = { mount, extractContacts, historyMatch, MAX_BYTES };
