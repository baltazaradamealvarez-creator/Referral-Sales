'use strict';

// Address suggestions while a rep types. Uses Geoapify when GEOAPIFY_API_KEY is set
// (free tier: 3,000 lookups a day), otherwise the free Photon service (OpenStreetMap).
// Requests go through the server so they can be cached and rate-limited.

const { normalizeState } = require('./normalize');

const CACHE_MAX = 1000;
const CACHE_MS = 24 * 3600 * 1000;

function provider() {
  return process.env.GEOAPIFY_API_KEY ? 'geoapify' : 'photon';
}

const clean = (s) => String(s || '').trim();
const stateCode = (s) => {
  const st = normalizeState(s);
  return st ? st.code : clean(s);
};

// Every suggestion: { line1, city, state, zip, label }.
function fromGeoapify(json, houseNumber) {
  return (json.results || []).map((r) => {
    const num = clean(r.housenumber) || houseNumber;
    const street = clean(r.street);
    if (!street) return null;
    return { line1: `${num ? `${num} ` : ''}${street}`, city: clean(r.city || r.town || r.village), state: clean(r.state_code) || stateCode(r.state), zip: clean(r.postcode).slice(0, 5) };
  }).filter(Boolean);
}

function fromPhoton(json, houseNumber) {
  return (json.features || []).map((f) => {
    const p = f.properties || {};
    if (p.countrycode && p.countrycode !== 'US') return null;
    const street = clean(p.street || (p.type === 'street' ? p.name : ''));
    if (!street) return null;
    const num = clean(p.housenumber) || houseNumber;
    return { line1: `${num ? `${num} ` : ''}${street}`, city: clean(p.city || p.town || p.village || p.district), state: stateCode(p.state), zip: clean(p.postcode).slice(0, 5) };
  }).filter(Boolean);
}

function mount(app, db, { requireUser, wrap, HttpError, rateLimit }) {
  const cache = new Map();
  const hits = new Map();

  async function suggest(q) {
    const key = `${provider()}|${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
    const houseNumber = (q.match(/^\s*(\d{1,6}[a-z]?)\b/i) || [])[1] || '';
    let url;
    if (provider() === 'geoapify') {
      url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(q)}&filter=countrycode:us&format=json&limit=5&apiKey=${encodeURIComponent(process.env.GEOAPIFY_API_KEY)}`;
    } else {
      url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en&layer=house&layer=street`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'EO-Spectrum-Referrals/1.0' } });
      if (!res.ok) throw new Error(`lookup returned ${res.status}`);
      const json = await res.json();
      const raw = provider() === 'geoapify' ? fromGeoapify(json, houseNumber) : fromPhoton(json, houseNumber);
      const seen = new Set();
      const list = [];
      for (const s of raw) {
        s.label = [s.line1, s.city, `${s.state} ${s.zip}`.trim()].filter(Boolean).join(', ');
        if (seen.has(s.label.toLowerCase())) continue;
        seen.add(s.label.toLowerCase());
        list.push(s);
        if (list.length >= 5) break;
      }
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), list });
      return list;
    } finally {
      clearTimeout(timer);
    }
  }

  app.get('/api/address/suggest', async (req, res, next) => {
    try {
      const u = requireUser(req);
      const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 150);
      if (q.length < 6 || !/\d/.test(q) || !/[a-z]{2}/i.test(q)) return res.json({ suggestions: [] });
      if (!rateLimit(hits, `u:${u.id}`, 60, 60 * 1000)) throw new HttpError(429, 'Slow down a little.');
      try {
        res.json({ suggestions: await suggest(q), provider: provider() });
      } catch (e) {
        // Never block entering a lead because the lookup is down.
        res.json({ suggestions: [], unavailable: true, error: e.name === 'AbortError' ? 'timeout' : e.message });
      }
    } catch (e) { next(e); }
  });

  return { suggest, provider };
}

module.exports = { mount, fromPhoton, fromGeoapify, provider };
