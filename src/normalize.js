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

const SERVICE_PATTERNS = [
  ['Internet', /\b(internet|wi-?fi|broadband)\b/i],
  ['TV', /\b(tv|television|cable|spectrum tv)\b/i],
  ['Mobile', /\b(mobile|cell\s?phones?|wireless|phone lines?)\b/i],
  ['Voice', /\b(voice|home\s?phone|landline)\b/i],
];

function detectServices(text) {
  return SERVICE_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

// "<number> <1-4 words> <street suffix>", anywhere in a line.
const SUFFIX_WORDS = Object.keys(STREET_SUFFIXES).join('|');
const ADDRESS_IN_LINE_RE = new RegExp(`\\b\\d{1,6}[A-Za-z]?\\s+(?:[A-Za-z0-9'.-]+\\s+){1,4}?(?:${SUFFIX_WORDS})\\b\\.?`, 'i');

const LABELS = {
  name: 'name', customer: 'name', 'customer name': 'name', client: 'name',
  phone: 'phone', cell: 'phone', mobile: 'phone', tel: 'phone', number: 'phone', 'phone number': 'phone', 'cell phone': 'phone',
  email: 'email', 'e-mail': 'email', 'email address': 'email',
  address: 'address', addr: 'address', 'service address': 'address', street: 'address',
  city: 'city', state: 'state', zip: 'zip', 'zip code': 'zip', zipcode: 'zip', apt: 'unit', unit: 'unit',
  note: 'notes', notes: 'notes', comment: 'notes', comments: 'notes',
  services: 'services', service: 'services', products: 'services', 'interested in': 'services', package: 'services',
};
const LABEL_RE = new RegExp(`^\\s*(${Object.keys(LABELS).sort((a, b) => b.length - a.length).join('|')})\\s*[:=\\-]\\s*(.*)$`, 'i');

// Pulls name / phone / email / address / services out of whatever the rep typed or pasted.
// Accepts labelled lines ("Name: Jane") or plain text in any order. Nothing is thrown away:
// anything it can't place ends up in notes.
function parseLeadText(text) {
  const result = { name: '', phone: '', email: '', address: '', notes: '', services: [] };
  if (!text) return result;

  const labelled = {};
  const extraNotes = [];
  const bodyLines = [];
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const m = line.match(LABEL_RE);
    if (m && m[2].trim()) {
      const key = LABELS[m[1].toLowerCase()];
      labelled[key] = labelled[key] ? `${labelled[key]} ${m[2].trim()}` : m[2].trim();
    } else if (!m) {
      bodyLines.push(line);
    }
  }
  let remaining = bodyLines.join('\n');
  for (const k of ['name', 'phone', 'email', 'address', 'notes']) if (labelled[k]) result[k] = labelled[k];
  const addrParts = [labelled.unit && `Apt ${labelled.unit.replace(/^(apt|unit|#)\s*/i, '')}`, labelled.city,
    [labelled.state, labelled.zip].filter(Boolean).join(' ')].filter(Boolean);
  if (addrParts.length) result.address = [result.address, ...addrParts].filter(Boolean).join(', ');

  if (!result.email) {
    const m = remaining.match(EMAIL_RE);
    if (m) {
      result.email = m[0];
      remaining = remaining.replace(m[0], '  ');
    }
  }
  // First phone is the contact number; any others are kept as alternates.
  const phoneRe = new RegExp(PHONE_RE.source, 'g');
  for (const m of remaining.match(phoneRe) || []) {
    if (!result.phone) result.phone = m.trim();
    else extraNotes.push(`Alt phone: ${m.trim()}`);
    remaining = remaining.replace(m, '  ');
  }

  let lines = remaining
    .split(/\n|\s{2,}|\t|\|/)
    .map((l) => l.replace(/^[\s,;\-/]+|[\s,;\-/]+$/g, ''))
    .filter((l) => /[A-Za-z0-9]/.test(l));

  // Pass 1: an address with a street suffix anywhere in a line ("... at 123 Main St Austin TX 78701 ...")
  if (!result.address) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ADDRESS_IN_LINE_RE);
      if (!m) continue;
      const rest = lines[i].slice(m.index);
      const withZip = rest.match(/^.*?\b\d{5}(?:-\d{4})?\b/);
      result.address = (withZip ? withZip[0] : rest).trim();
      const before = lines[i].slice(0, m.index).replace(/\s+(at|@|address|lives at)\s*$/i, '');
      const after = withZip ? rest.slice(withZip[0].length) : '';
      lines.splice(i, 1, ...[before, after].map((x) => x.replace(/^[\s,;\-]+|[\s,;\-]+$/g, '')).filter(Boolean));
      break;
    }
  }

  const leftovers = [];
  for (const line of lines) {
    if (!result.address && /^\d+\s+[A-Za-z]/.test(line)) {
      result.address = line;
      continue;
    }
    if (!result.name && /^[A-Za-z][A-Za-z.'\- ]+$/.test(line) && line.split(/\s+/).length <= 4
      && !detectServices(line).length) {
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

  result.notes = [result.notes, ...extraNotes, ...leftovers].filter(Boolean).join('\n');
  result.services = detectServices([labelled.services || '', result.notes].join(' '));
  for (const k of ['name', 'phone', 'email', 'address', 'notes']) result[k] = String(result[k] || '').trim();
  if (result.name && result.name === result.name.toLowerCase()) {
    result.name = result.name.replace(/(^|[\s'-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
  }
  return result;
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  formatPhone,
  addressKey,
  parseLeadText,
  detectServices,
};
