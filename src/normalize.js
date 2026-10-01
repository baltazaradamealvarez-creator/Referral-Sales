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

// A WhatsApp number as stored on a profile: "+1 (512) 555-0142" for US numbers, "+<digits>"
// otherwise. '' for empty; null when it can't be a phone number.
function formatWhatsapp(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const d = s.replace(/\D/g, '');
  if (d.length < 10 || d.length > 15) return null;
  if (d.length === 10) return `+1 ${formatPhone(d)}`;
  if (d.length === 11 && d[0] === '1') return `+1 ${formatPhone(d.slice(1))}`;
  return `+${d}`;
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

// True when a whole cell looks like a street address ("123 Main St Apt 4"), used to
// pick addresses out of spreadsheets that have no header row.
function looksLikeStreet(text) {
  const t = String(text || '').trim();
  if (t.length < 6 || t.length > 150 || !/^\d{1,6}[A-Za-z]?\s+[A-Za-z0-9]/.test(t)) return false;
  const m = ADDRESS_IN_LINE_RE.exec(t);
  return !!m && m.index === 0;
}

const LABELS = {
  name: 'name', customer: 'name', 'customer name': 'name', client: 'name',
  phone: 'phone', cell: 'phone', mobile: 'phone', tel: 'phone', number: 'phone', 'phone number': 'phone', 'cell phone': 'phone',
  email: 'email', 'e-mail': 'email', 'email address': 'email',
  address: 'address', addr: 'address', 'service address': 'address', street: 'address',
  city: 'city', state: 'state', zip: 'zip', 'zip code': 'zip', zipcode: 'zip', apt: 'unit', unit: 'unit',
  note: 'notes', notes: 'notes', comment: 'notes', comments: 'notes',
  services: 'services', service: 'services', products: 'services', 'interested in': 'services', package: 'services',
  dob: 'dob', 'd.o.b': 'dob', 'd.o.b.': 'dob', 'date of birth': 'dob', 'birth date': 'dob', birthdate: 'dob', birthday: 'dob',
  'fecha de nacimiento': 'dob', nacimiento: 'dob', 'fecha nac': 'dob',
};
const LABEL_RE = new RegExp(`^\\s*(${Object.keys(LABELS).sort((a, b) => b.length - a.length).join('|')})\\s*[:=\\-]\\s*(.*)$`, 'i');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  ene: 1, abr: 4, ago: 8, dic: 12 };

// A date of birth in common US forms -> 'YYYY-MM-DD', or '' if it isn't a real, plausible one.
// 01/31/1980, 1-31-80, 1980-01-31, Jan 31 1980, 31 Jan 1980.
function parseDob(value) {
  const v = String(value || '').trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ');
  if (!v) return '';
  let y;
  let m;
  let d;
  let k;
  if ((k = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [y, m, d] = [+k[1], +k[2], +k[3]];
  else if ((k = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) [m, d, y] = [+k[1], +k[2], +k[3]];
  else if ((k = v.match(/^([a-z]{3,9})\.?\s+(\d{1,2})\s+(\d{4})$/)) && MONTHS[k[1].slice(0, 3)]) [m, d, y] = [MONTHS[k[1].slice(0, 3)], +k[2], +k[3]];
  else if ((k = v.match(/^(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{4})$/)) && MONTHS[k[2].slice(0, 3)]) [d, m, y] = [+k[1], MONTHS[k[2].slice(0, 3)], +k[3]];
  else return '';
  const now = new Date();
  if (y < 100) y += y > (now.getFullYear() % 100) ? 1900 : 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  const age = (now - dt) / (365.25 * 86400000);
  if (age < 16 || age > 110) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Pulls name / phone / email / address / services out of whatever the rep typed or pasted.
// Accepts labelled lines ("Name: Jane") or plain text in any order. Nothing is thrown away:
// anything it can't place ends up in notes.
function parseLeadText(text) {
  const result = { name: '', phone: '', email: '', address: '', notes: '', dob: '', services: [] };
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
  if (labelled.dob) {
    result.dob = parseDob(labelled.dob);
    if (!result.dob) extraNotes.push(`DOB: ${labelled.dob}`);
  } else {
    // An unlabelled full date with a birth-year-looking year is the date of birth.
    for (const m of remaining.match(/\b\d{1,2}[/-]\d{1,2}[/-](19|20)\d{2}\b/g) || []) {
      const dob = parseDob(m);
      if (dob) { result.dob = dob; remaining = remaining.replace(m, '  '); break; }
    }
  }
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

const STATE_MAP = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', PR: 'Puerto Rico',
};

const STATE_NAMES = Object.fromEntries(
  Object.entries(STATE_MAP).map(([code, name]) => [name.toLowerCase(), code])
);

function normalizeState(input) {
  if (!input) return null;
  const cleaned = String(input).trim().toLowerCase();
  if (STATE_MAP[cleaned.toUpperCase()]) {
    const code = cleaned.toUpperCase();
    return { code, name: STATE_MAP[code] };
  }
  if (STATE_NAMES[cleaned]) {
    const code = STATE_NAMES[cleaned];
    return { code, name: STATE_MAP[code] };
  }
  return null;
}

function extractStateFromAddress(address) {
  if (!address) return null;
  const str = String(address);
  // Match state code e.g. "Austin, TX 78701" or "Dallas TX"
  const codeMatch = str.match(/\b([A-Z]{2})\b(?:\s+\d{5})?/i);
  if (codeMatch && STATE_MAP[codeMatch[1].toUpperCase()]) {
    const code = codeMatch[1].toUpperCase();
    return { code, name: STATE_MAP[code] };
  }
  // Match state full name
  const lower = str.toLowerCase();
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(lower)) {
      return { code, name: STATE_MAP[code] };
    }
  }
  return null;
}

module.exports = {
  formatWhatsapp,
  parseDob,
  normalizeEmail,
  normalizePhone,
  formatPhone,
  addressKey,
  looksLikeStreet,
  parseLeadText,
  detectServices,
  normalizeState,
  extractStateFromAddress,
  STATE_MAP,
};

