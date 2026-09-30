'use strict';

// Helpers that turn messy, free-typed lead info into comparable keys.
// Duplicate detection runs on these keys, never on the raw text.

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/;
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/g;

const STREET_SUFFIXES = {
  street: 'st', st: 'st', str: 'st',
  avenue: 'ave', ave: 'ave', av: 'ave',
  road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr', drv: 'dr',
  lane: 'ln', ln: 'ln',
  boulevard: 'blvd', blvd: 'blvd',
  court: 'ct', ct: 'ct',
  circle: 'cir', cir: 'cir',
  place: 'pl', pl: 'pl',
  parkway: 'pkwy', pkwy: 'pkwy',
  highway: 'hwy', hwy: 'hwy',
  terrace: 'ter', ter: 'ter',
  trail: 'trl', trl: 'trl',
  way: 'way',
  loop: 'loop',
  square: 'sq', sq: 'sq',
  crossing: 'xing', xing: 'xing',
  point: 'pt', pt: 'pt',
  cove: 'cv', cv: 'cv',
  run: 'run',
  path: 'path',
  pike: 'pike',
  expressway: 'expy', expy: 'expy',
  freeway: 'fwy', fwy: 'fwy',
};

const DIRECTIONS = {
  north: 'n', n: 'n', south: 's', s: 's', east: 'e', e: 'e', west: 'w', w: 'w',
  northeast: 'ne', ne: 'ne', northwest: 'nw', nw: 'nw',
  southeast: 'se', se: 'se', southwest: 'sw', sw: 'sw',
};

const UNIT_WORDS = new Set(['apt', 'apartment', 'unit', 'ste', 'suite', 'no', 'lot', 'bldg', 'building', 'rm', 'room', 'fl', 'floor']);

function normalizeEmail(email) {
  if (!email) return '';
  return String(email).trim().toLowerCase();
}

// Returns the 10-digit US number, or '' if there aren't enough digits.
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length === 10 ? digits : '';
}

function formatPhone(phone) {
  const d = normalizePhone(phone);
  return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(phone || '').trim();
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/#\s*/g, ' # ')
    .replace(/[.,;:'"()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Builds a key for "same physical address": house number + street + unit (+ zip when known).
// Example: "123 North Main Street, Apt #4B, Austin TX 78701" -> { street: "123 n main st apt 4b", zip: "78701" }
function addressKey(address) {
  if (!address) return { street: '', zip: '' };
  const raw = String(address);

  let zip = '';
  const zips = [...raw.matchAll(ZIP_RE)];
  if (zips.length) {
    const last = zips[zips.length - 1];
    // Ignore a 5-digit house number at the very start.
    if (last.index > 0 || zips.length > 1) zip = last[1];
  }

  // Use the first comma-separated segment that starts with a house number.
  const segments = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  let segIdx = segments.findIndex((s) => /^\d+[a-z]?\b/i.test(s));
  if (segIdx === -1) segIdx = 0;
  let tokens = tokenize(segments[segIdx] || '');
  // Unit is often in its own segment: "123 Main St, Apt 4"
  const next = segments[segIdx + 1];
  if (next && /^(apt|apartment|unit|ste|suite|#|lot|bldg|building|rm|room|fl|floor)\b/i.test(next.replace(/^#/, '# '))) {
    tokens = tokens.concat(tokenize(next));
  }

  const out = [];
  let i = 0;
  let sawSuffix = false;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (UNIT_WORDS.has(t) || t === '#') break;
    if (DIRECTIONS[t] && out.length > 0 && !sawSuffix) {
      out.push(DIRECTIONS[t]);
      continue;
    }
    if (STREET_SUFFIXES[t] && out.length >= 2) {
      out.push(STREET_SUFFIXES[t]);
      sawSuffix = true;
      i++;
      // trailing direction: "Main St NW"
      if (i < tokens.length && DIRECTIONS[tokens[i]]) {
        out.push(DIRECTIONS[tokens[i]]);
        i++;
      }
      break;
    }
    out.push(t);
  }

  // Unit, if any
  while (i < tokens.length) {
    const t = tokens[i];
    if ((UNIT_WORDS.has(t) || t === '#') && i + 1 < tokens.length) {
      let j = i + 1;
      while (j < tokens.length && (UNIT_WORDS.has(tokens[j]) || tokens[j] === '#')) j++;
      if (j < tokens.length) out.push('apt', tokens[j].replace(/^#/, ''));
      break;
    }
    if (/^#\w+/.test(t)) {
      out.push('apt', t.slice(1));
      break;
    }
    i++;
  }

  // Without a suffix we can't tell where the street ends, so drop a trailing zip/state guess.
  let street = out.join(' ');
  if (!sawSuffix) {
    street = street.replace(/\s+\d{5}(-\d{4})?$/, '').replace(/\s+[a-z]{2}$/, '');
  }
  if (!/\d/.test(street)) street = ''; // need a house number to be meaningful
  return { street, zip };
}

// Pulls name / phone / email / address out of whatever the rep typed or pasted.
// Accepts labelled lines ("Name: Jane") or plain text in any order.
function parseLeadText(text) {
  const result = { name: '', phone: '', email: '', address: '', notes: '' };
  if (!text) return result;
  let remaining = String(text).replace(/\r/g, '');

  const labelled = {};
  const labelRe = /^\s*(name|customer|phone|cell|mobile|tel|number|email|e-mail|address|addr|notes?|comments?)\s*[:\-]\s*(.+)$/gim;
  remaining = remaining.replace(labelRe, (_, label, value) => {
    const key = label.toLowerCase();
    const map = {
      name: 'name', customer: 'name',
      phone: 'phone', cell: 'phone', mobile: 'phone', tel: 'phone', number: 'phone',
      email: 'email', 'e-mail': 'email',
      address: 'address', addr: 'address',
      note: 'notes', notes: 'notes', comment: 'notes', comments: 'notes',
    };
    labelled[map[key]] = value.trim();
    return '';
  });
  Object.assign(result, labelled);

  if (!result.email) {
    const m = remaining.match(EMAIL_RE);
    if (m) {
      result.email = m[0];
      remaining = remaining.replace(m[0], ' ');
    }
  }
  if (!result.phone) {
    const m = remaining.match(PHONE_RE);
    if (m) {
      result.phone = m[0].trim();
      remaining = remaining.replace(m[0], ' ');
    }
  }

  const lines = remaining
    .split(/\n|\s{2,}|\t|\|/)
    .map((l) => l.replace(/^[\s,;\-]+|[\s,;\-]+$/g, ''))
    .filter(Boolean);

  const leftovers = [];
  for (const line of lines) {
    if (!result.address && /^\d+\s+\S+/.test(line)) {
      result.address = line;
      continue;
    }
    // Address that follows a name on the same line: "Jane Doe 123 Main St ..."
    const inline = line.match(/^([A-Za-z][A-Za-z.'\- ]*?)\s+(\d+\s+[A-Za-z].*)$/);
    if (!result.address && inline && !result.name) {
      result.name = inline[1].trim();
      result.address = inline[2].trim();
      continue;
    }
    if (!result.name && /^[A-Za-z][A-Za-z.'\- ]+$/.test(line) && line.split(/\s+/).length <= 5) {
      result.name = line;
      continue;
    }
    // City/state/zip continuation of an address on its own line
    if (result.address && /^[A-Za-z .'-]+,?\s+[A-Za-z]{2}\s*\d{5}(-\d{4})?$/.test(line)) {
      result.address += ', ' + line;
      continue;
    }
    leftovers.push(line);
  }

  if (leftovers.length) {
    result.notes = [result.notes, leftovers.join(' ')].filter(Boolean).join(' — ');
  }
  for (const k of Object.keys(result)) result[k] = String(result[k] || '').trim();
  return result;
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  formatPhone,
  addressKey,
  parseLeadText,
};
