'use strict';

const crypto = require('node:crypto');
const ERCOT = 'https://ercot.api.comparepower.com';
const PRICING = 'https://pricing.api.comparepower.com';
const TTL = 15 * 60000;
const rows = (value, keys) => {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  if (value?.data && value.data !== value) return rows(value.data, keys);
  return [];
};
const safeUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function meter(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    (typeof (raw.esiid ?? raw._id) === 'number' &&
      !Number.isSafeInteger(raw.esiid ?? raw._id))
  )
    return null;
  const esiid = String(raw.esiid ?? raw._id ?? '');
  const duns = String(raw.duns ?? raw.tdsp_duns ?? '');
  if (!/^\d{14,22}$/.test(esiid) || !/^\d{9,15}$/.test(duns)) return null;
  const hold = raw.switch_hold_indicator;
  const clear =
    hold === false ||
    hold === 0 ||
    ['n', 'no', 'false', '0'].includes(String(hold).toLowerCase());
  return {
    esiid,
    duns,
    status: String(raw.status ?? 'Not provided'),
    address: String(raw.address ?? raw.service_address ?? ''),
    switch_hold: !clear,
    hold_known: hold !== undefined && hold !== null,
  };
}
function docs(plan) {
  const raw = plan.document_links || [];
  return (
    Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([type, value]) =>
          typeof value === 'string'
            ? { type, snapshot_url: value }
            : { ...value, type }
        )
  )
    .filter((d) => d && typeof d === 'object')
    .map((d) => ({
      label: String(
        d.type || d.name || d.document_type || 'Plan document'
      ).slice(0, 80),
      url: safeUrl(d.snapshot_url),
    }))
    .filter((d) => d.url);
}
function mount(
  app,
  db,
  {
    requireUser,
    requireRole,
    wrap,
    awrap,
    HttpError,
    getReferral,
    canViewReferral,
    getSettings,
    addComment,
    logAudit,
    fetchImpl = globalThis.fetch,
  }
) {
  const lookups = new Map(),
    jobs = new Map(),
    cache = new Map();
  function prune(map, max = 100) {
    const now = Date.now();
    for (const [key, v] of map)
      if (now - v.at > TTL && v.status !== 'working') map.delete(key);
    while (map.size > max) {
      const key = [...map.keys()].find((k) => map.get(k).status !== 'working');
      if (!key) break;
      map.delete(key);
    }
  }
  const settings = () => {
    const s = getSettings();
    return {
      afid: s.comparepower_afid ?? 'eiwhj899',
      default_afuid: s.comparepower_default_afuid ?? 'im3lwsos',
    };
  };
  function access(req) {
    const u = requireUser(req),
      r = getReferral(req.params.id);
    if (!canViewReferral(u, r))
      throw new HttpError(404, 'Customer record not found.');
    return { u, r };
  }
  async function get(url, signal) {
    let res;
    try {
      res = await fetchImpl(url, {
        signal: AbortSignal.any([
          signal || new AbortController().signal,
          AbortSignal.timeout(15000),
        ]),
        headers: { Accept: 'application/json' },
      });
    } catch {
      throw new Error('ComparePower could not be reached. Please try again.');
    }
    if (!res.ok)
      throw new Error(`ComparePower returned ${res.status}. Please try again.`);
    try {
      return await res.json();
    } catch {
      throw new Error('ComparePower returned an unreadable response.');
    }
  }
  function checkout(r, plan, duns, usage, contact = false, start = '') {
    const s = settings();
    if (!s.afid) return null;
    const owner = db
      .prepare('SELECT comparepower_afuid FROM users WHERE id=?')
      .get(r.created_by);
    const url = new URL('https://ref.comparepower.com/checkout/');
    for (const [key, value] of Object.entries({
      cp_afid: s.afid,
      cp_afuid: owner?.comparepower_afuid || s.default_afuid,
      plan_id: plan,
      tdsp_duns: duns,
      usage: String(usage),
    }))
      if (value) url.searchParams.set(key, value);
    if (contact) {
      const [first, ...rest] = String(r.customer_name || '')
        .trim()
        .split(/\s+/);
      for (const [key, value] of Object.entries({
        first_name: first,
        last_name: rest.join(' '),
        email: r.email,
        phone_number: String(r.phone || '').replace(/\D/g, ''),
      }))
        if (value) url.searchParams.set(key, value);
    }
    if (start) url.searchParams.set('selected_start_date', start);
    return url.href;
  }
  function findJob(req, r, u) {
    prune(jobs);
    const job = jobs.get(req.params.job || req.body.job_id);
    if (!job || job.referral_id !== r.id || job.user_id !== u.id)
      throw new HttpError(
        404,
        'Energy comparison expired or was not found. Run a new check.'
      );
    return job;
  }
  app.get(
    '/api/energy/settings',
    wrap((req) => {
      requireRole(req, 'admin');
      return settings();
    })
  );
  app.patch(
    '/api/energy/settings',
    wrap((req) => {
      requireRole(req, 'admin');
      for (const key of ['afid', 'default_afuid'])
        if (
          req.body[key] !== undefined &&
          String(req.body[key]).trim() &&
          !/^[A-Za-z0-9._-]{1,80}$/.test(String(req.body[key]).trim())
        )
          throw new HttpError(
            400,
            'Referral IDs must use letters, numbers, dots, underscores or hyphens.'
          );
      for (const [key, setting] of [
        ['afid', 'comparepower_afid'],
        ['default_afuid', 'comparepower_default_afuid'],
      ])
        if (req.body[key] !== undefined)
          db.prepare(
            'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
          ).run(setting, String(req.body[key]).trim());
      logAudit(
        req,
        'energy.settings',
        'settings',
        '',
        'Energy attribution updated'
      );
      return settings();
    })
  );
  app.post(
    '/api/energy/referrals/:id/meters',
    awrap(async (req) => {
      const { u, r } = access(req),
        address = String(req.body.address ?? r.address ?? '')
          .trim()
          .slice(0, 300),
        zip = String(req.body.zip ?? r.zip ?? '').trim();
      if (!address || !/^\d{5}$/.test(zip))
        throw new HttpError(
          400,
          'Enter the service address and a five-digit ZIP code.'
        );
      prune(lookups);
      const url = new URL('/api/esiids', ERCOT);
      url.searchParams.set('address', address);
      url.searchParams.set('zip_code', zip);
      let payload;
      try {
        payload = await get(url);
      } catch (e) {
        throw new HttpError(502, e.message);
      }
      const meters = rows(payload, ['esiids', 'results', 'meters'])
        .map(meter)
        .filter(Boolean);
      const id = crypto.randomBytes(18).toString('hex');
      lookups.set(id, {
        at: Date.now(),
        user_id: u.id,
        referral_id: r.id,
        meters,
        address,
        zip,
      });
      logAudit(
        req,
        'energy.lookup',
        'referral',
        r.id,
        'Energy meter lookup requested'
      );
      return { lookup_id: id, meters };
    })
  );
  app.post(
    '/api/energy/referrals/:id/recommendations',
    wrap((req) => {
      const { u, r } = access(req);
      prune(lookups);
      prune(jobs);
      const lookup = lookups.get(req.body.lookup_id);
      if (!lookup || lookup.user_id !== u.id || lookup.referral_id !== r.id)
        throw new HttpError(
          400,
          'Look up the service address again before comparing plans.'
        );
      const selected = lookup.meters.find(
        (m) => m.esiid === String(req.body.esiid)
      );
      if (!selected)
        throw new HttpError(400, 'Choose a meter from the address lookup.');
      if (selected.switch_hold)
        throw new HttpError(
          409,
          selected.hold_known
            ? 'This meter has a switch hold. The customer must clear it before switching.'
            : 'Switch-hold status is missing. Verify it before recommending a plan.'
        );
      if (
        [...jobs.values()].some(
          (j) => j.user_id === u.id && j.status === 'working'
        )
      )
        throw new HttpError(409, 'Your energy comparison is already running.');
      if ([...jobs.values()].filter((j) => j.status === 'working').length >= 5)
        throw new HttpError(
          429,
          'Energy comparisons are busy. Please try again shortly.'
        );
      const override = req.body.usage;
      if (
        override !== undefined &&
        (!Array.isArray(override) ||
          override.length !== 12 ||
          override.some((n) => !Number.isFinite(n) || n < 0 || n > 50000))
      )
        throw new HttpError(
          400,
          'Provide twelve monthly usage values between 0 and 50,000 kWh.'
        );
      const id = crypto.randomBytes(18).toString('hex'),
        job = {
          id,
          at: Date.now(),
          user_id: u.id,
          referral_id: r.id,
          status: 'working',
          stage: 'Looking up meter usage and available plans',
          completed: 0,
          total: 0,
          saved: new Set(),
        };
      jobs.set(id, job);
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 120000);
      timer.unref?.();
      (async () => {
        try {
          const plansUrl = new URL('/api/plans/current', PRICING);
          plansUrl.searchParams.set('tdsp_duns', selected.duns);
          plansUrl.searchParams.set('display_usage', '1000');
          plansUrl.searchParams.set('group', 'default');
          const [profile, payload] = await Promise.all([
            override
              ? Promise.resolve({ usage: override })
              : get(
                  `${ERCOT}/api/esiids/${selected.esiid}/profile`,
                  controller.signal
                ),
            get(plansUrl, controller.signal),
          ]);
          const usage = profile.usage;
          if (
            !Array.isArray(usage) ||
            usage.length !== 12 ||
            usage.some(
              (n) =>
                n == null ||
                n === '' ||
                typeof n === 'boolean' ||
                !Number.isFinite(Number(n)) ||
                Number(n) < 0 ||
                Number(n) > 50000
            )
          )
            throw new Error(
              'Twelve monthly usage estimates were not available. Enter customer-provided monthly usage and try again.'
            );
          job.usage = usage.map((n) => Math.round(Number(n)));
          job.usage_source = override ? 'customer' : 'meter estimates';
          job.meter = selected;
          const available = rows(payload, ['plans', 'results']).filter((p) =>
            /^[A-Za-z0-9_-]{1,100}$/.test(String(p?._id || ''))
          );
          const plans = [
              ...new Map(available.map((p) => [String(p._id), p])).values(),
            ].slice(0, 200),
            unique = [...new Set(job.usage)],
            tasks = plans.flatMap((p) => unique.map((n) => ({ p, n }))),
            bills = new Map();
          job.total = tasks.length;
          job.stage = 'Calculating bills at all twelve months of usage';
          job.warnings =
            available.length > 200
              ? [`Comparison limited to 200 of ${available.length} plans.`]
              : [];
          let next = 0;
          prune(cache, 3000);
          await Promise.all(
            Array.from({ length: Math.min(10, tasks.length) }, async () => {
              while (next < tasks.length && !controller.signal.aborted) {
                const { p, n } = tasks[next++],
                  key = `${p._id}:${n}`;
                try {
                  let value = cache.get(key);
                  if (!value || Date.now() - value.at > TTL) {
                    const data = await get(
                      `${PRICING}/api/plans/${encodeURIComponent(p._id)}/calculate/${n}`,
                      controller.signal
                    );
                    if (
                      data.total == null ||
                      data.total === '' ||
                      typeof data.total === 'boolean' ||
                      !Number.isFinite(Number(data.total))
                    )
                      throw new Error('Missing bill total');
                    value = { at: Date.now(), total: Number(data.total) };
                    cache.set(key, value);
                  }
                  bills.set(key, value.total);
                } catch {
                } finally {
                  job.completed++;
                }
              }
            })
          );
          if (controller.signal.aborted)
            throw new Error('The comparison took too long. Try again shortly.');
          const averageUsage = Math.round(
            job.usage.reduce((a, b) => a + b, 0) / 12
          );
          job.plans = plans
            .flatMap((p) => {
              const monthly = job.usage.map((n) => bills.get(`${p._id}:${n}`));
              if (monthly.some((n) => n === undefined)) return [];
              const annual = round(monthly.reduce((a, b) => a + b, 0));
              return [
                {
                  id: String(p._id),
                  name: String(p.name || p.plan_name || 'Energy plan'),
                  brand: String(p.brand?.name || p.brand_name || ''),
                  term: p.term_months
                    ? `${p.term_months} months`
                    : String(p.term || ''),
                  annual_bill: annual,
                  monthly_bill: round(annual / 12),
                  monthly_bills: monthly.map(round),
                  documents: docs(p),
                  checkout_url: checkout(
                    r,
                    String(p._id),
                    selected.duns,
                    averageUsage
                  ),
                },
              ];
            })
            .sort(
              (a, b) =>
                a.annual_bill - b.annual_bill || a.id.localeCompare(b.id)
            );
          const failed = plans.length - job.plans.length;
          if (failed)
            job.warnings.push(
              `${failed} plan${failed === 1 ? '' : 's'} could not be fully calculated and are excluded.`
            );
          if (!job.plans.length)
            throw new Error(
              plans.length
                ? 'No plans could be fully calculated. Please try again.'
                : 'No current plans were returned for this utility.'
            );
          job.plans = job.plans.slice(0, 20);
          job.average_usage = averageUsage;
          job.status = 'done';
          job.stage = 'Comparison ready';
        } catch (e) {
          job.status = 'failed';
          job.error = e.message || 'Energy comparison failed.';
        } finally {
          clearTimeout(timer);
        }
      })();
      return { job_id: id };
    })
  );
  app.get(
    '/api/energy/referrals/:id/jobs/:job',
    wrap((req) => {
      const { u, r } = access(req),
        j = findJob(req, r, u);
      const { saved, user_id, referral_id, at, ...view } = j;
      return view;
    })
  );
  app.post(
    '/api/energy/referrals/:id/checkout',
    wrap((req) => {
      const { u, r } = access(req),
        j = findJob(req, r, u),
        plan = j.plans?.find((p) => p.id === String(req.body.plan_id));
      if (j.status !== 'done' || !plan)
        throw new HttpError(400, 'Choose a plan from a completed comparison.');
      const start = String(req.body.selected_start_date || ''),
        date = new Date(start + 'T12:00:00Z');
      if (
        start &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(start) ||
          !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 10) !== start)
      )
        throw new HttpError(400, 'Enter a valid start date.');
      const url = checkout(
        r,
        plan.id,
        j.meter.duns,
        j.average_usage,
        req.body.include_contact === true,
        start
      );
      if (!url)
        throw new HttpError(
          409,
          'An admin must configure the ComparePower organization refid first.'
        );
      return { url, owner_id: r.created_by };
    })
  );
  app.post(
    '/api/energy/referrals/:id/save',
    wrap((req) => {
      const { u, r } = access(req),
        j = findJob(req, r, u),
        p = j.plans?.find((p) => p.id === String(req.body.plan_id));
      if (j.status !== 'done' || !p)
        throw new HttpError(400, 'Choose a plan from a completed comparison.');
      if (!j.saved.has(p.id)) {
        addComment(
          u,
          r,
          `Energy option checked: ${p.brand ? p.brand + ' · ' : ''}${p.name}. Estimated $${p.monthly_bill.toFixed(2)}/month ($${p.annual_bill.toFixed(2)}/year) using twelve monthly ${j.usage_source}. Customer must verify current EFL, terms and service eligibility at checkout.`,
          { allowMentions: false }
        );
        j.saved.add(p.id);
        logAudit(
          req,
          'energy.save',
          'referral',
          r.id,
          'Energy recommendation saved as a note'
        );
      }
      return { saved: true };
    })
  );
}
module.exports = { mount, meter, docs };
