'use strict';

// Reads uploaded spreadsheets (.xlsx or .csv) into plain rows of text, with no
// dependencies: an .xlsx file is a zip of XML files, and Node can inflate zip entries.

const zlib = require('node:zlib');

const MAX_ROWS = 200000;

// ---------- zip ----------

function unzip(buf) {
  // End of central directory: last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    files.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 200 * 1024 * 1024 }).toString('utf8');
      throw new Error('unsupported zip compression');
    });
  }
  return files;
}

// ---------- xlsx ----------

const unxml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k === 'lt') return '<';
  if (k === 'gt') return '>';
  if (k === 'amp') return '&';
  if (k === 'quot') return '"';
  if (k === 'apos') return "'";
  return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unxml(m[1]) : '';
};

// Text of an <si> or <is> element: all its <t> runs joined.
const runText = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

function colIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i);
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Numbers come back the way a person would read them (no "8.26e+15", no trailing ".0").
function numText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n)) return BigInt(Math.round(n)).toString();
  return String(n);
}

function readXlsx(buf) {
  const files = unzip(buf);
  const get = (name) => (files.has(name) ? files.get(name)() : '');
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]));
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [];
  let total = 0;
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(m[0], 'r:id')) || '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = get(path);
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (++total > MAX_ROWS) throw new Error(`too many rows (over ${MAX_ROWS.toLocaleString()})`);
      const row = [];
      let next = 0;
      for (const c of (r[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(`<c ${c[1]}>`, 'r');
        const idx = ref ? colIndex(ref) : next;
        next = idx + 1;
        const type = attr(`<c ${c[1]}>`, 't');
        const inner = c[2] || '';
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let text = '';
        if (type === 's') text = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') text = runText(inner);
        else if (type === 'str' || type === 'e') text = v != null ? unxml(v) : '';
        else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null) text = numText(unxml(v));
        if (idx >= 0 && idx < 500) row[idx] = text;
      }
      rows.push(Array.from(row, (x) => x ?? ''));
    }
    sheets.push({ name: attr(m[0], 'name'), rows });
  }
  return sheets;
}

// ---------- csv ----------

function readCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.slice(0, src.indexOf('\n') >>> 0);
  const sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t'
    : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length > MAX_ROWS) throw new Error(`too many rows (over ${MAX_ROWS.toLocaleString()})`);
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return [{ name: 'CSV', rows }];
}

// Returns [{ name, rows: [[text]] }]. Throws an Error with a readable message.
function readSpreadsheet(buf, fileName = '') {
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) {
    try {
      return readXlsx(buf);
    } catch (e) {
      throw new Error(`We couldn't read that Excel file (${e.message}). Try saving it as .xlsx or .csv.`);
    }
  }
  if (/\.xls$/i.test(fileName) || buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new Error('That’s an old .xls file. Open it in Excel and use Save As → .xlsx (or .csv), then upload again.');
  }
  return readCsv(buf.toString('utf8'));
}

module.exports = { readSpreadsheet, readCsv, unzip };
