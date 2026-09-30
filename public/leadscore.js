// Lead quality score (0–100) and fake-detail checks, shared by the browser (live meter
// on New Referral) and the server (stored with each lead, and used to block obvious fakes).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LeadScore = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const PLACEHOLDER_NAMES = new Set([
    'test', 'testing', 'tester', 'test test', 'test user', 'test lead', 'test customer', 'fake', 'fake name', 'asdf', 'qwerty',
    'none', 'na', 'n/a', 'no name', 'noname', 'unknown', 'customer', 'client', 'anonymous', 'anon', 'nobody', 'xxx', 'xx',
    'abc', 'abc abc', 'blah', 'sample', 'dummy', 'name', 'full name', 'first last', 'firstname lastname', 'first name last name',
    'mickey mouse', 'minnie mouse', 'donald duck', 'bugs bunny', 'homer simpson', 'lead', 'new lead',
  ]);
  const SUSPICIOUS_NAMES = new Set(['john doe', 'jane doe']);
  const FAKE_WORDS = new Set(['test', 'testing', 'fake', 'asdf', 'qwerty', 'dummy', 'sample', 'xxx', 'blah']);
  const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

  const DISPOSABLE = new Set([
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com', '10minutemail.net',
    'tempmail.com', 'temp-mail.org', 'tempmail.net', 'tempmailo.com', 'throwawaymail.com', 'yopmail.com', 'yopmail.net',
    'trashmail.com', 'trashmail.net', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'mintemail.com',
    'fakeinbox.com', 'mailnesia.com', 'mohmal.com', 'emailondeck.com', 'spamgourmet.com', 'mytemp.email', 'tempr.email',
    'discard.email', 'burnermail.io', 'moakt.com', 'inboxkitten.com', 'tmpmail.org', 'mailcatch.com', 'spam4.me',
  ]);
  const TEST_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'fake.com', 'nomail.com', 'noemail.com', 'none.com', 'asdf.com', 'domain.com', 'email.test']);
  const FAKE_LOCALS = new Set(['test', 'testing', 'fake', 'none', 'noemail', 'nomail', 'no', 'na', 'asdf', 'abc', 'xxx', 'dummy', 'sample', 'null', 'noreply', 'no-reply', 'nobody', 'donotreply']);
  const DOMAIN_TYPOS = {
    'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com',
    'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmail.om': 'gmail.com',
    'hotmial.com': 'hotmail.com', 'hotmail.co': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmail.con': 'hotmail.com',
    'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com',
    'outlok.com': 'outlook.com', 'outlook.co': 'outlook.com', 'iclod.com': 'icloud.com', 'icloud.co': 'icloud.com', 'aol.co': 'aol.com',
  };
  const STREET_WORDS = /\b(st|street|ave|avenue|av|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|pl|place|pkwy|parkway|hwy|highway|ter|terrace|trl|trail|way|loop|sq|square|xing|crossing|pt|point|cv|cove|run|path|pike|expy|fwy|plz|plaza|row|walk|aly|alley)\b/i;

  const lower = (s) => String(s || '').trim().toLowerCase();

  function keyboardRun(word, n = 4) {
    const w = word.toLowerCase();
    for (const row of KEY_ROWS) {
      for (let i = 0; i + n <= row.length; i++) {
        const run = row.slice(i, i + n);
        if (w.includes(run) || w.includes([...run].reverse().join(''))) return true;
      }
    }
    return false;
  }

  // Each check returns { level: 'fake' | 'warn' | 'ok', msg }.
  function checkName(name) {
    const n = lower(name).replace(/\s+/g, ' ');
    if (!n) return { level: 'missing', msg: 'Add the customer’s name.' };
    if (PLACEHOLDER_NAMES.has(n.replace(/[.,]/g, ''))) return { level: 'fake', msg: `“${String(name).trim()}” isn’t a real name. Enter the customer’s real first and last name.` };
    if (/\d/.test(n)) return { level: 'fake', msg: 'Names don’t have numbers in them. Check the customer’s name.' };
    if (!/[a-zà-öø-ÿ]/i.test(n)) return { level: 'fake', msg: 'That doesn’t look like a name.' };
    const words = n.split(/[\s-]+/).filter(Boolean);
    if (words.some((w) => FAKE_WORDS.has(w.replace(/[^a-z]/g, '')))) return { level: 'fake', msg: 'That looks like a test or made-up name. Enter the customer’s real name.' };
    if (/(.)\1\1/.test(n.replace(/\s/g, ''))) return { level: 'fake', msg: 'That name has the same letter three times in a row. Check it.' };
    if (words.some((w) => w.length >= 5 && keyboardRun(w, 5))) return { level: 'fake', msg: 'That looks like keyboard mashing, not a name.' };
    if (words.some((w) => w.replace(/[^a-z]/g, '').length >= 5 && !/[aeiouyà-öø-ÿ]/.test(w))) return { level: 'fake', msg: 'That name has no vowels. Check the spelling.' };
    if (words.length < 2) return { level: 'warn', msg: 'Add the last name too.' };
    if (SUSPICIOUS_NAMES.has(n)) return { level: 'warn', msg: 'That’s a common placeholder name. Make sure it’s the customer’s real name.' };
    if (words.every((w) => w.replace(/[^a-z]/g, '').length <= 1)) return { level: 'warn', msg: 'Initials only. Add the full name.' };
    if (words[words.length - 1].replace(/[^a-z]/g, '').length <= 1) return { level: 'warn', msg: 'Add the full last name, not just the initial.' };
    if (words[0] === words[words.length - 1] && words.length === 2) return { level: 'warn', msg: 'First and last name are the same. Double-check it.' };
    return { level: 'ok', msg: 'Full name' };
  }

  function checkPhone(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (!d) return { level: 'missing', msg: 'Add a phone number.' };
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length !== 10) return { level: 'fake', msg: 'A phone number needs 10 digits.' };
    const area = d.slice(0, 3);
    const exch = d.slice(3, 6);
    if (/^(\d)\1{9}$/.test(d) || ['1234567890', '0123456789', '9876543210', '0987654321'].includes(d)) return { level: 'fake', msg: 'That phone number isn’t real. Enter the customer’s actual number.' };
    if (area[0] === '0' || area[0] === '1' || area === '555' || /^[2-9]11$/.test(area)) return { level: 'fake', msg: `${area} isn’t a real area code. Check the number.` };
    if (exch[0] === '0' || exch[0] === '1' || /^[2-9]11$/.test(exch)) return { level: 'fake', msg: 'That phone number isn’t valid (the middle 3 digits can’t start with 0 or 1). Check it.' };
    if (exch === '555' && /^01\d\d$/.test(d.slice(6))) return { level: 'warn', msg: '555-01xx numbers are reserved for TV and movies. Is it real?' };
    if (/^(\d)\1{6}$/.test(d.slice(3))) return { level: 'warn', msg: 'That number repeats one digit. Double-check it.' };
    return { level: 'ok', msg: 'Valid phone' };
  }

  function checkEmail(email) {
    const e = lower(email);
    if (!e) return { level: 'missing', msg: 'Add an email for a higher score.' };
    const m = e.match(/^([^\s@]+)@([^\s@]+\.[a-z]{2,})$/);
    if (!m) return { level: 'fake', msg: 'That email address isn’t complete.' };
    const [, local, domain] = m;
    if (DISPOSABLE.has(domain)) return { level: 'fake', msg: `${domain} is a throw-away email service. Ask for the customer’s real email.` };
    if (TEST_DOMAINS.has(domain)) return { level: 'fake', msg: `${domain} isn’t a real mailbox. Ask for the customer’s real email.` };
    if (FAKE_LOCALS.has(local.replace(/\d+$/, ''))) return { level: 'fake', msg: 'That looks like a placeholder email. Ask for the customer’s real one, or leave it blank.' };
    if (DOMAIN_TYPOS[domain]) return { level: 'warn', msg: `Did you mean @${DOMAIN_TYPOS[domain]}?`, fix: `${local}@${DOMAIN_TYPOS[domain]}` };
    if (local.length >= 5 && keyboardRun(local.replace(/[^a-z]/g, ''), 5)) return { level: 'warn', msg: 'That email looks like keyboard mashing. Double-check it.' };
    return { level: 'ok', msg: 'Valid email' };
  }

  function checkAddress(address, zip, city) {
    const a = String(address || '').trim();
    if (!a) return { level: 'missing', msg: 'Add the service address.' };
    const hasNumber = /^\s*\d{1,6}[a-z]?\b/i.test(a) || /\b\d{1,6}[a-z]?\s+\w+/i.test(a);
    const hasStreet = STREET_WORDS.test(a);
    const hasZip = /\b\d{5}(-\d{4})?\b/.test(`${a} ${zip || ''}`.replace(/^\s*\d{5}\b(?=\s+\D)/, ''));
    const afterStreet = a.split(STREET_WORDS).slice(-1)[0] || '';
    const hasCity = !!String(city || '').trim() || /,\s*[a-z .'-]{3,}/i.test(a) || /\b[a-z]{3,}\b/i.test(afterStreet.replace(/\b(apt|apartment|unit|ste|suite|lot|bldg|fl|floor|rm)\b\.?\s*#?\s*\w+/gi, ''));
    if (!hasNumber) return { level: 'warn', msg: 'Add the house or building number.', points: 0.3 };
    if (!hasStreet) return { level: 'warn', msg: 'Add the street type (St, Ave, Rd…).', points: 0.6 };
    if (!hasZip && !hasCity) return { level: 'warn', msg: 'Add the city or zip code.', points: 0.6 };
    if (!hasZip) return { level: 'warn', msg: 'Add the zip code.', points: 0.8 };
    return { level: 'ok', msg: 'Full address' };
  }

  const WEIGHTS = { name: 25, phone: 25, address: 25, email: 15, services: 10 };

  // lead: { name, phone, email, address, zip, city, services: [] }
  // Returns { score, band, color, checks: { name, phone, email, address, services }, fakes: [msg], tips: [msg] }
  function scoreLead(lead = {}) {
    const checks = {
      name: checkName(lead.name),
      phone: checkPhone(lead.phone),
      email: checkEmail(lead.email),
      address: checkAddress(lead.address, lead.zip, lead.city),
      services: (lead.services || []).length ? { level: 'ok', msg: 'Services picked' } : { level: 'missing', msg: 'Pick the services they want.' },
    };
    let score = 0;
    for (const [k, c] of Object.entries(checks)) {
      const w = WEIGHTS[k];
      if (c.level === 'ok') score += w;
      else if (c.level === 'warn') score += Math.round(w * (c.points ?? 0.5));
    }
    const fakes = Object.entries(checks).filter(([, c]) => c.level === 'fake').map(([field, c]) => ({ field, msg: c.msg }));
    // A lead with made-up details is low quality no matter what else is filled in.
    if (fakes.length) score = Math.min(score, 15);
    if (checks.phone.level !== 'ok' && checks.phone.level !== 'warn' && checks.email.level !== 'ok' && checks.email.level !== 'warn') score = Math.min(score, 45);
    score = Math.max(0, Math.min(100, score));
    const band = score >= 80 ? 'Strong' : score >= 60 ? 'Good' : score >= 35 ? 'Fair' : 'Weak';
    const tips = Object.values(checks).filter((c) => c.level === 'warn' || c.level === 'missing').map((c) => c.msg);
    return { score, band, color: scoreColor(score), checks, fakes, tips };
  }

  // Red (0) → amber → green (100).
  function scoreColor(score) {
    const hue = Math.round(Math.max(0, Math.min(100, score)) * 1.25);
    return `hsl(${hue}, 72%, 42%)`;
  }

  return { scoreLead, scoreColor, checkName, checkPhone, checkEmail, checkAddress };
}));
