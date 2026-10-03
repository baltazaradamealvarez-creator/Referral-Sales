'use strict';

// Everything the dashboard widgets need, in one request, already narrowed to what the
// signed-in user may see. Insights are plain rules over the same numbers.

const { STATUSES, SERVICES } = require('./db');

const WIDGETS = [
  'kpis', 'insights', 'trend', 'status', 'funnel', 'services', 'leaderboard',
  'teams', 'dispatch', 'stale', 'installs', 'activity', 'speed', 'followups',
];

const DEFAULT_LAYOUTS = {
  rep: ['kpis', 'followups', 'insights', 'trend', 'status', 'stale', 'installs', 'leaderboard', 'activity'],
  manager: ['kpis', 'speed', 'followups', 'insights', 'trend', 'leaderboard', 'funnel', 'status', 'stale', 'installs', 'services', 'activity'],
  dispatch: ['kpis', 'speed', 'followups', 'insights', 'dispatch', 'stale', 'installs', 'trend', 'status', 'activity'],
  admin: ['kpis', 'speed', 'insights', 'trend', 'teams', 'leaderboard', 'funnel', 'dispatch', 'services', 'status', 'stale', 'installs', 'activity', 'followups'],
};

// Widgets a role may add. Team and dispatch comparisons need every team's data.
const ALLOWED = {
  rep: WIDGETS.filter((w) => !['teams', 'dispatch'].includes(w)),
  manager: WIDGETS.filter((w) => !['teams', 'dispatch'].includes(w)),
  dispatch: WIDGETS,
  admin: WIDGETS,
};

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function buildDashboard(db, u, q) {
  const seesAll = u.role === 'admin' || u.role === 'dispatch';
  // The client sends its UTC offset so "today" and daily buckets use the user's own day.
  const tz = Math.max(-840, Math.min(840, Math.trunc(Number(q.tz) || 0)));
  const local = (col) => `datetime(${col}, '${-tz >= 0 ? '+' : ''}${-tz} minutes')`;
  const today = new Date(Date.now() - tz * 60000).toISOString().slice(0, 10);

  // ---- scope: which referrals count
  const scope = [];
  const sp = [];
  let teamId = null;
  if (u.role === 'rep') {
    scope.push('r.created_by = ?');
    sp.push(u.id);
    teamId = u.team_id;
  } else if (u.role === 'manager') {
    scope.push('r.team_id = ?');
    sp.push(u.team_id ?? -1);
    teamId = u.team_id;
  } else if (q.team_id) {
    teamId = Number(q.team_id);
    scope.push('r.team_id = ?');
    sp.push(teamId);
  }
  if (q.user_id && u.role !== 'rep') {
    scope.push('r.created_by = ?');
    sp.push(Number(q.user_id));
  }
  const S = scope.length ? scope.join(' AND ') : '1 = 1';

  // ---- period
  let from = isDate(q.from) ? q.from : null;
  let to = isDate(q.to) ? q.to : null;
  if (from && !to) to = today;
  if (from && to && from > to) [from, to] = [to, from];
  const inRange = (col, f, t) => (f ? `date(${local(col)}) BETWEEN '${f}' AND '${t}'` : '1 = 1');
  const R = inRange('r.created_at', from, to);
  const len = from ? daysBetween(from, to) + 1 : 0;
  const prev = from ? { from: addDays(from, -len), to: addDays(from, -1) } : null;

  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const statusCols = STATUSES.map((s) => `SUM(CASE WHEN r.status = '${s}' THEN 1 ELSE 0 END) AS "${s}"`).join(', ');

  function kpisFor(rangeSql) {
    const c = get(`SELECT COUNT(*) AS total, ${statusCols} FROM referrals r WHERE ${S} AND ${rangeSql}`, ...sp);
    for (const k of Object.keys(c)) c[k] = c[k] || 0;
    const t = get(`SELECT AVG(julianday(h.created_at) - julianday(r.created_at)) AS days
      FROM referrals r JOIN status_history h ON h.referral_id = r.id AND h.to_status = 'Ordered'
      WHERE ${S} AND ${rangeSql} AND r.status = 'Ordered'`, ...sp);
    return {
      entered: c.total,
      ordered: c.Ordered,
      open: c.New + c.Working + c.Passed,
      dnq: c.DNQ,
      cancelled: c.Cancelled,
      conversion: pct(c.Ordered, c.total),
      avg_days_to_order: t.days == null ? null : Math.round(t.days * 10) / 10,
      by_status: Object.fromEntries(STATUSES.map((s) => [s, c[s]])),
    };
  }

  const kpis = kpisFor(R);
  const prevKpis = prev ? kpisFor(inRange('r.created_at', prev.from, prev.to)) : null;

  // ---- daily trend: entered (by entry date) and marked Ordered (by the day it was marked)
  const trendFrom = from || addDays(today, -29);
  const trendTo = to || today;
  const trendDays = Math.min(daysBetween(trendFrom, trendTo) + 1, 366);
  const tStart = addDays(trendTo, -(trendDays - 1));
  const enteredRows = all(`SELECT date(${local('r.created_at')}) AS d, COUNT(*) AS n FROM referrals r
    WHERE ${S} AND date(${local('r.created_at')}) BETWEEN ? AND ? GROUP BY d`, ...sp, tStart, trendTo);
  const orderedRows = all(`SELECT date(${local('h.created_at')}) AS d, COUNT(DISTINCT h.referral_id) AS n
    FROM status_history h JOIN referrals r ON r.id = h.referral_id
    WHERE ${S} AND h.to_status = 'Ordered' AND date(${local('h.created_at')}) BETWEEN ? AND ? GROUP BY d`, ...sp, tStart, trendTo);
  const em = Object.fromEntries(enteredRows.map((x) => [x.d, x.n]));
  const om = Object.fromEntries(orderedRows.map((x) => [x.d, x.n]));
  const trend = [];
  for (let i = 0; i < trendDays; i++) {
    const d = addDays(tStart, i);
    trend.push({ date: d, entered: em[d] || 0, ordered: om[d] || 0 });
  }

  // ---- services: how often requested, and how often those leads ordered
  const services = SERVICES.map((s) => {
    const c = get(`SELECT COUNT(*) AS n, SUM(CASE WHEN r.status = 'Ordered' THEN 1 ELSE 0 END) AS o FROM referrals r
      WHERE ${S} AND ${R} AND (', ' || r.services || ',') LIKE ?`, ...sp, `%, ${s},%`);
    return { service: s, entered: c.n, ordered: c.o || 0, conversion: pct(c.o || 0, c.n) };
  });

  // ---- funnel: entered -> worked (left New) -> ordered
  const funnel = [
    { stage: 'Entered', n: kpis.entered },
    { stage: 'Worked', n: kpis.entered - kpis.by_status.New },
    { stage: 'Ordered', n: kpis.ordered },
  ];

  // ---- leaderboard: reps in the viewer's team (reps/managers) or chosen team / everyone
  const lbTeam = u.role === 'rep' || u.role === 'manager' ? u.team_id : teamId;
  const lbWhere = lbTeam != null ? 'u.team_id = ?' : "u.role IN ('rep', 'manager')";
  const leaderboard = all(`
    SELECT u.id, u.full_name, t.name AS team_name,
      COUNT(r.id) AS entered, SUM(CASE WHEN r.status = 'Ordered' THEN 1 ELSE 0 END) AS ordered
    FROM users u LEFT JOIN teams t ON t.id = u.team_id
    LEFT JOIN referrals r ON r.created_by = u.id AND ${R}
    WHERE u.active = 1 AND u.role IN ('rep', 'manager') AND ${lbWhere}
    GROUP BY u.id HAVING COUNT(r.id) > 0
    ORDER BY ordered DESC, entered DESC, u.full_name LIMIT 10`, ...(lbTeam != null ? [lbTeam] : []))
    .map((x) => ({ ...x, ordered: x.ordered || 0, conversion: pct(x.ordered || 0, x.entered), me: x.id === u.id }));

  const out = {
    today, from, to, prev,
    layout_default: DEFAULT_LAYOUTS[u.role],
    allowed: ALLOWED[u.role],
    kpis, prev_kpis: prevKpis, trend, services, funnel, leaderboard,
  };

  if (seesAll) {
    out.teams = all(`
      SELECT t.id, t.name, COUNT(r.id) AS entered, SUM(CASE WHEN r.status = 'Ordered' THEN 1 ELSE 0 END) AS ordered
      FROM teams t LEFT JOIN referrals r ON r.team_id = t.id AND ${R}
      GROUP BY t.id ORDER BY ordered DESC, entered DESC, t.name`).map((x) => ({ ...x, ordered: x.ordered || 0, conversion: pct(x.ordered || 0, x.entered) }));
    out.dispatch = {
      unassigned: get(`SELECT COUNT(*) AS n FROM referrals r WHERE ${S} AND r.assigned_to IS NULL AND r.status IN ('New', 'Working', 'Passed')`, ...sp).n,
      people: all(`
        SELECT u.id, u.full_name,
          (SELECT COUNT(*) FROM referrals r WHERE r.assigned_to = u.id AND r.status IN ('New', 'Working', 'Passed') AND ${S}) AS open,
          (SELECT COUNT(*) FROM referrals r WHERE r.assigned_to = u.id AND r.status = 'Ordered' AND ${S} AND ${R}) AS ordered
        FROM users u WHERE u.active = 1 AND u.role = 'dispatch' ORDER BY open DESC, u.full_name`, ...sp, ...sp),
    };
    out.duplicates = get(`SELECT COUNT(*) AS n FROM duplicate_attempts d WHERE ${inRange('d.created_at', from, to)}`).n;
  }

  // ---- stale: still New after 3+ days
  out.stale = all(`SELECT r.id, r.customer_name, r.phone, r.created_at, u.full_name AS rep,
      CAST(julianday('now') - julianday(r.created_at) AS INTEGER) AS days
    FROM referrals r JOIN users u ON u.id = r.created_by
    WHERE ${S} AND r.status = 'New' AND r.created_at < datetime('now', '-3 days')
    ORDER BY r.created_at LIMIT 8`, ...sp);
  out.stale_count = get(`SELECT COUNT(*) AS n FROM referrals r WHERE ${S} AND r.status = 'New' AND r.created_at < datetime('now', '-3 days')`, ...sp).n;

  // ---- installs in the next 14 days
  out.installs = all(`SELECT r.id, r.customer_name, r.install_date, r.address, u.full_name AS rep
    FROM referrals r JOIN users u ON u.id = r.created_by
    WHERE ${S} AND r.install_date BETWEEN ? AND ? AND r.status <> 'Cancelled'
    ORDER BY r.install_date, r.id LIMIT 10`, ...sp, today, addDays(today, 14));

  // ---- recent activity
  out.activity = all(`SELECT * FROM (
      SELECT 'status' AS kind, h.created_at AS at, r.id AS referral_id, r.customer_name, COALESCE(a.full_name,NULLIF(h.external_author,''),'WhatsApp participant') AS actor,
        h.from_status, h.to_status, NULL AS body
      FROM status_history h JOIN referrals r ON r.id = h.referral_id LEFT JOIN users a ON a.id = h.user_id WHERE ${S}
      UNION ALL
      SELECT 'comment', c.created_at, r.id, r.customer_name, COALESCE(a.full_name,NULLIF(c.external_author,''),'WhatsApp participant'), NULL, NULL, substr(c.body, 1, 140)
      FROM comments c JOIN referrals r ON r.id = c.referral_id LEFT JOIN users a ON a.id = c.user_id WHERE ${S}
    ) ORDER BY at DESC LIMIT 12`, ...sp, ...sp);

  out.insights = insights(out, u, seesAll, db, S, sp, R, local);
  return out;
}

function insights(d, u, seesAll, db, S, sp, R, local) {
  const list = [];
  const k = d.kpis;
  const p = d.prev_kpis;
  const periodWord = d.from ? 'the previous period' : null;

  if (k.entered === 0) {
    list.push({ tone: 'info', text: 'No referrals entered in this period yet.' });
  }
  if (p && periodWord && p.entered >= 3 && k.entered >= 3) {
    const change = Math.round(((k.entered - p.entered) / p.entered) * 100);
    if (Math.abs(change) >= 10) {
      list.push({ tone: change > 0 ? 'good' : 'warn', text: `${k.entered} referrals entered — ${Math.abs(change)}% ${change > 0 ? 'more' : 'fewer'} than ${periodWord} (${p.entered}).` });
    }
    const diff = Math.round((k.conversion - p.conversion) * 10) / 10;
    if (Math.abs(diff) >= 3) {
      list.push({ tone: diff > 0 ? 'good' : 'warn', text: `Conversion is ${k.conversion}%, ${diff > 0 ? 'up' : 'down'} ${Math.abs(diff)} points from ${periodWord}.` });
    }
  }
  if (k.entered >= 5 && !list.some((x) => x.text.startsWith('Conversion'))) {
    list.push({ tone: 'info', text: `${k.ordered} of ${k.entered} referrals ordered — ${k.conversion}% conversion.` });
  }
  if (k.avg_days_to_order != null && k.ordered >= 3) {
    list.push({ tone: 'info', text: `Orders take ${k.avg_days_to_order} day${k.avg_days_to_order === 1 ? '' : 's'} on average from entry.` });
  }

  const lb = d.leaderboard;
  if (u.role !== 'rep' && lb.length >= 2 && lb[0].ordered > 0) {
    list.push({ tone: 'good', text: `${lb[0].full_name} leads with ${lb[0].ordered} order${lb[0].ordered === 1 ? '' : 's'} (${lb[0].conversion}% conversion).`, link: `#/referrals?user_id=${lb[0].id}` });
  }
  if (u.role === 'rep') {
    const mine = lb.findIndex((x) => x.me);
    if (mine >= 0 && lb.length >= 2 && lb[mine].ordered > 0) {
      list.push({ tone: mine === 0 ? 'good' : 'info', text: mine === 0 ? `You're #1 on your team with ${lb[mine].ordered} orders. Keep it up!` : `You're #${mine + 1} of ${lb.length} on your team for orders.` });
    }
  }

  if (d.stale_count > 0) {
    const oldest = d.stale[0];
    list.push({ tone: 'warn', text: `${d.stale_count} lead${d.stale_count === 1 ? ' has' : 's have'} sat in New for 3+ days${oldest ? ` — the oldest is ${oldest.days} days` : ''}.`, link: '#/referrals?status=New' });
  }
  if (seesAll && d.dispatch && d.dispatch.unassigned > 0) {
    list.push({ tone: 'warn', text: `${d.dispatch.unassigned} open lead${d.dispatch.unassigned === 1 ? ' has' : 's have'} no dispatcher.`, link: '#/referrals?scope=unassigned' });
  }
  if (k.entered >= 8 && k.dnq / k.entered >= 0.25) {
    list.push({ tone: 'warn', text: `${Math.round((k.dnq / k.entered) * 100)}% of referrals were DNQ — worth checking lead quality.`, link: '#/referrals?status=DNQ' });
  }

  const svc = d.services.filter((s) => s.entered >= 5).sort((a, b) => b.conversion - a.conversion);
  if (svc.length >= 2 && svc[0].conversion - svc[svc.length - 1].conversion >= 10) {
    list.push({ tone: 'info', text: `${svc[0].service} leads convert best (${svc[0].conversion}%); ${svc[svc.length - 1].service} converts least (${svc[svc.length - 1].conversion}%).` });
  }

  if (k.entered >= 14) {
    const dow = db.prepare(`SELECT strftime('%w', ${local('r.created_at')}) AS w, COUNT(*) AS n FROM referrals r
      WHERE ${S} AND ${R} GROUP BY w ORDER BY n DESC LIMIT 1`).get(...sp);
    const names = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    if (dow) list.push({ tone: 'info', text: `${names[Number(dow.w)]} are the busiest day for new referrals.` });
  }

  if (d.installs.length) {
    const soon = d.installs.filter((x) => x.install_date <= d.today).length;
    list.push({ tone: 'info', text: `${d.installs.length} install${d.installs.length === 1 ? '' : 's'} scheduled in the next two weeks${soon ? `, ${soon} today` : ''}.` });
  }
  if (seesAll && d.duplicates >= 3) {
    list.push({ tone: 'info', text: `${d.duplicates} duplicate entries were blocked in this period.`, link: '#/duplicates' });
  }
  return list.slice(0, 7);
}

module.exports = { buildDashboard, WIDGETS, DEFAULT_LAYOUTS };
