'use strict';

// Admin-only snapshot import for active customers in the Usage worksheet.
const { readSpreadsheet } = require('./sheets');

const MAX_BYTES = 10 * 1024 * 1024;
const cell = (value) => String(value ?? '').trim();
const accountKey = (value) => cell(value).toUpperCase().replace(/[^A-Z0-9]/g, '');

function headerIndex(headers, predicate) {
  return headers.findIndex((value) => predicate(cell(value).toLowerCase().replace(/[^a-z0-9]/g, '')));
}

function isoDate(value) {
  const raw = cell(value);
  if (!raw) return '';
  // Excel stores dates as the number of days since 1899-12-30.
  if (/^\d{4,6}(?:\.\d+)?$/.test(raw)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Number(raw) * 86400000);
    if (Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1901) return date.toISOString().slice(0, 10);
    return '';
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() <= 1901) return '';
  return parsed.toISOString().slice(0, 10);
}

function activeRows(sheets, fileName) {
  const csv = /\.csv$/i.test(fileName);
  const sheet = csv ? sheets[0] : sheets.find((s) => String(s.name).trim().toLowerCase() === 'usage');
  if (!sheet) throw new Error('This workbook needs a sheet named “Usage”.');
  const headers = sheet.rows[0] || [];
  const acctCol = headerIndex(headers, (h) => h.includes('accountnumber'));
  const connectCol = headerIndex(headers, (h) => h === 'dateconnect' || h.endsWith('dateconnect'));
  const usageDateCol = headerIndex(headers, (h) => h === 'internetusagedate');
  const usageCol = headerIndex(headers, (h) => h === 'internetusage');
  if (acctCol < 0 || connectCol < 0 || usageDateCol < 0 || usageCol < 0) {
    throw new Error('The Usage sheet needs Customer - Account Number, Date - Connect, Internet Usage, and Internet Usage Date columns.');
  }

  const records = new Map();
  let rows = 0;
  let duplicateRows = 0;
  for (const row of sheet.rows.slice(1)) {
    const account = cell(row[acctCol]);
    const key = accountKey(account);
    if (!key || cell(row[usageCol]).toUpperCase() !== 'Y') continue;
    rows++;
    if (records.has(key)) duplicateRows++;
    records.set(key, {
      account_number: account,
      account_key: key,
      customer_name: cell(row[headerIndex(headers, (h) => h.includes('customerfullname'))]) || '',
      active_date: isoDate(row[connectCol]),
      usage_date: isoDate(row[usageDateCol]),
    });
  }
  if (!records.size) throw new Error('No active rows with Internet Usage marked Y were found on the Usage sheet.');
  return { records: [...records.values()], rows, duplicateRows, sheet: sheet.name };
}

function matchRecords(db, parsed) {
  const byAccount = new Map();
  for (const row of db.prepare("SELECT id, customer_name, account_number FROM referrals WHERE account_number <> ''").all()) {
    const key = accountKey(row.account_number);
    if (!key) continue;
    const list = byAccount.get(key) || [];
    list.push(row);
    byAccount.set(key, list);
  }
  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  for (const row of parsed.records) {
    const candidates = byAccount.get(row.account_key) || [];
    if (candidates.length === 1) matched.push({ ...row, referral_id: candidates[0].id, record_name: candidates[0].customer_name });
    else if (candidates.length > 1) ambiguous.push(row);
    else unmatched.push(row);
  }
  return { matched, unmatched, ambiguous };
}

function readUpload(body) {
  const fileName = String(body.file_name || 'usage-upload').slice(0, 200);
  if (!body.data) throw Object.assign(new Error('Choose a file to upload.'), { status: 400 });
  const buf = Buffer.from(String(body.data), 'base64');
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('That file is over 10 MB. Split it into smaller files.'), { status: 413 });
  try {
    const parsed = activeRows(readSpreadsheet(buf, fileName), fileName);
    return { fileName, parsed };
  } catch (error) {
    throw Object.assign(new Error(error.message), { status: 400 });
  }
}

function mount(app, db, { requireRole, wrap, HttpError, logAudit }) {
  app.post('/api/usage/import', wrap((req, res) => {
    const admin = requireRole(req, 'admin');
    let upload;
    try { upload = readUpload(req.body || {}); }
    catch (error) { throw new HttpError(error.status || 400, error.message); }
    const matches = matchRecords(db, upload.parsed);
    const summary = {
      file_name: upload.fileName,
      sheet: upload.parsed.sheet,
      rows: upload.parsed.rows,
      unique_accounts: upload.parsed.records.length,
      duplicate_rows: upload.parsed.duplicateRows,
      matched: matches.matched.length,
      unmatched: matches.unmatched.length,
      ambiguous: matches.ambiguous.length,
      unmatched_samples: matches.unmatched.slice(0, 8).map((r) => ({ customer_name: r.customer_name, account_last4: r.account_number.slice(-4) })),
      ambiguous_samples: matches.ambiguous.slice(0, 8).map((r) => ({ account_last4: r.account_number.slice(-4) })),
    };
    if (!req.body.commit) return { preview: true, ...summary };
    if (!matches.matched.length) throw new HttpError(400, 'No rows matched existing customers. Check that their account numbers are saved on the customer records.');

    db.exec('BEGIN IMMEDIATE');
    try {
      const update = db.prepare(`UPDATE referrals SET customer_active = 1, active_date = ?, usage_date = ?, updated_at = datetime('now') WHERE id = ?`);
      for (const row of matches.matched) update.run(row.active_date, row.usage_date, row.referral_id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    logAudit(req, 'usage.import', 'usage_import', null, `${upload.fileName}: ${matches.matched.length} customers marked active`);
    res.status(201);
    return { ...summary, updated: matches.matched.length };
  }));
}

module.exports = { mount, activeRows, matchRecords, isoDate, accountKey, MAX_BYTES };
