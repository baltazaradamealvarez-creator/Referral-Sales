'use strict';

// Speed to lead. A new lead is "touched" the first time someone other than the rep who
// entered it works it (status change, comment, or taking it). Until then a clock runs,
// counting only working hours:
//   - after `sla_minutes` (15) the assigned dispatcher (or every dispatcher) is alerted;
//   - after `sla_escalate_minutes` (60) admins are alerted, and the lead can be handed
//     to the least-busy other dispatcher automatically.
// The same tick sends call-back reminders that people set on leads.

const DEFAULTS = {
  sla_enabled: '1',
  sla_minutes: '15',
  sla_escalate_minutes: '60',
  sla_auto_reassign: '0',
  sla_hours: '8-21',
  sla_timezone: 'America/Chicago',
};

const validZone = (tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

// Offset (ms) of a time zone at a given instant: local wall clock minus UTC.
function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

// The UTC instant of a local wall-clock time in a zone.
function zonedToUtc(y, m, d, h, tz, min = 0) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

function localDate(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return [+p.year, +p.month, +p.day];
}

// Working minutes between two instants. hours: [startHour, endHour) local, e.g. [8, 21].
function businessMinutes(fromMs, toMs, { hours = [0, 24], tz = 'UTC' } = {}) {
  if (toMs <= fromMs) return 0;
  const [start, end] = hours;
  if (start <= 0 && end >= 24) return Math.floor((toMs - fromMs) / 60000);
  let [y, m, d] = localDate(fromMs, tz);
  let total = 0;
  for (let i = 0; i < 62; i++) {
    const ws = zonedToUtc(y, m, d, start, tz);
    if (ws >= toMs) break;
    const we = zonedToUtc(y, m, d, end, tz);
    total += Math.max(0, Math.min(we, toMs) - Math.max(ws, fromMs));
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    [y, m, d] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
  }
  return Math.floor(total / 60000);
}

const parseHours = (v) => {
  const m = String(v || '').match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return [0, 24];
  const a = Math.min(23, +m[1]);
  const b = Math.min(24, +m[2]);
  return b > a ? [a, b] : [0, 24];
};
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const toMs = (sql) => Date.parse(`${String(sql).replace(' ', 'T')}Z`);

function mount(app, db, { requireUser, requireRole, wrap, HttpError, getSettings, logAudit, notify, getViewableReferral }) {
  const config = () => {
    const s = { ...DEFAULTS, ...getSettings() };
    return {
      enabled: s.sla_enabled === '1',
      minutes: Math.max(1, Number(s.sla_minutes) || 15),
      escalate: Math.max(2, Number(s.sla_escalate_minutes) || 60),
      autoReassign: s.sla_auto_reassign === '1',
      hours: parseHours(s.sla_hours),
      tz: validZone(s.sla_timezone) ? s.sla_timezone : DEFAULTS.sla_timezone,
    };
  };

  // Record the first time someone works a lead. Called from the referral routes.
  function touch(ref, userId) {
    if (ref.first_touch_at || userId === ref.created_by) return;
    db.prepare("UPDATE referrals SET first_touch_at = datetime('now'), first_touch_by = ? WHERE id = ? AND first_touch_at IS NULL").run(userId, ref.id);
  }

  const leadName = (r) => r.customer_name || `lead #${r.id}`;
  const activeDispatchers = () => db.prepare("SELECT id, full_name FROM users WHERE role = 'dispatch' AND active = 1").all();
  const activeAdmins = () => db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all();

  // One pass: SLA alerts, escalations, and due call-back reminders. `now` is for tests.
  function tick(now = Date.now()) {
    const c = config();
    const out = { alerted: [], escalated: [], reassigned: [], reminders: [] };
    if (c.enabled) {
      const rows = db.prepare(`SELECT r.id, r.customer_name, r.created_at, r.assigned_to, r.created_by, r.sla_alerted_at, r.sla_escalated_at, a.full_name AS assigned_name
        FROM referrals r LEFT JOIN users a ON a.id = r.assigned_to
        WHERE r.status = 'New' AND r.first_touch_at IS NULL AND (r.sla_alerted_at IS NULL OR r.sla_escalated_at IS NULL)
          AND r.created_at >= ?`).all(sqlTime(now - 14 * 86400000));
      for (const r of rows) {
        const mins = businessMinutes(toMs(r.created_at), now, c);
        if (!r.sla_alerted_at && mins >= c.minutes) {
          const to = r.assigned_to ? [{ id: r.assigned_to }] : activeDispatchers();
          for (const u of (to.length ? to : activeAdmins())) notify(u.id, r.id, `⏱ ${leadName(r)} has been waiting ${mins} min — call them now`);
          db.prepare('UPDATE referrals SET sla_alerted_at = ? WHERE id = ?').run(sqlTime(now), r.id);
          out.alerted.push(r.id);
        }
        if (!r.sla_escalated_at && mins >= c.escalate) {
          let moved = null;
          if (c.autoReassign && r.assigned_to) {
            moved = db.prepare(`SELECT u.id, u.full_name, (SELECT COUNT(*) FROM referrals x WHERE x.assigned_to = u.id AND x.status IN ('New', 'Passed')) AS open
              FROM users u WHERE u.role = 'dispatch' AND u.active = 1 AND u.id <> ? ORDER BY open, u.id LIMIT 1`).get(r.assigned_to);
            if (moved) {
              db.prepare('UPDATE referrals SET assigned_to = ?, assigned_at = ? WHERE id = ?').run(moved.id, sqlTime(now), r.id);
              notify(moved.id, r.id, `⏱ ${leadName(r)} was reassigned to you after waiting ${mins} min — call them now`);
              notify(r.assigned_to, r.id, `${leadName(r)} was reassigned to ${moved.full_name} because nobody had worked it for ${mins} min`);
              out.reassigned.push(r.id);
            }
          }
          for (const a of activeAdmins()) {
            notify(a.id, r.id, `🚨 ${leadName(r)} has had no response for ${mins} min${r.assigned_name ? ` (assigned to ${r.assigned_name})` : ' (unassigned)'}${moved ? `. Reassigned to ${moved.full_name}.` : ''}`);
          }
          db.prepare('UPDATE referrals SET sla_escalated_at = ? WHERE id = ?').run(sqlTime(now), r.id);
          out.escalated.push(r.id);
        }
      }
    }
    const due = db.prepare(`SELECT id, customer_name, phone, follow_up_note, follow_up_user, created_by FROM referrals
      WHERE follow_up_sent = 0 AND follow_up_at IS NOT NULL AND follow_up_at <= ?`).all(sqlTime(now));
    for (const r of due) {
      notify(r.follow_up_user || r.created_by, r.id, `📞 Call back ${leadName(r)}${r.phone ? ` at ${r.phone}` : ''} now${r.follow_up_note ? `: ${r.follow_up_note}` : ''}`);
      db.prepare('UPDATE referrals SET follow_up_sent = 1 WHERE id = ?').run(r.id);
      out.reminders.push(r.id);
    }
    return out;
  }

  // ---------- routes ----------

  app.get('/api/speed/settings', wrap((req) => {
    requireRole(req, 'admin');
    const c = config();
    return { ...c, hours: `${c.hours[0]}-${c.hours[1]}` };
  }));

  app.patch('/api/speed/settings', wrap((req) => {
    requireRole(req, 'admin');
    const b = req.body || {};
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const num = (v, lo, hi, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, msg); return String(n); };
    if (b.enabled !== undefined) set.run('sla_enabled', b.enabled ? '1' : '0');
    if (b.auto_reassign !== undefined) set.run('sla_auto_reassign', b.auto_reassign ? '1' : '0');
    const minutes = b.minutes !== undefined ? num(b.minutes, 1, 1440, 'Alert after 1 to 1440 minutes.') : null;
    const escalate = b.escalate !== undefined ? num(b.escalate, 2, 2880, 'Escalate after 2 to 2880 minutes.') : null;
    if (Number(escalate ?? config().escalate) <= Number(minutes ?? config().minutes)) throw new HttpError(400, 'Escalation must come after the first alert.');
    if (minutes) set.run('sla_minutes', minutes);
    if (escalate) set.run('sla_escalate_minutes', escalate);
    if (b.hours !== undefined) {
      const m = String(b.hours).match(/^(\d{1,2})-(\d{1,2})$/);
      if (!m || +m[2] <= +m[1] || +m[2] > 24) throw new HttpError(400, 'Working hours look like 8-21 (8am to 9pm), or 0-24 for all day.');
      set.run('sla_hours', `${+m[1]}-${+m[2]}`);
    }
    if (b.timezone !== undefined) {
      if (!validZone(b.timezone)) throw new HttpError(400, 'Unknown time zone.');
      set.run('sla_timezone', String(b.timezone));
    }
    logAudit(req, 'speed.settings', 'settings', '', JSON.stringify(config()));
    const c = config();
    return { ...c, hours: `${c.hours[0]}-${c.hours[1]}` };
  }));

  // Call-back reminder on a lead, for the person setting it.
  app.put('/api/referrals/:id/follow-up', wrap((req) => {
    const u = requireUser(req);
    const ref = getViewableReferral(u, req.params.id);
    const b = req.body || {};
    if (b.at === null || b.at === '') {
      db.prepare("UPDATE referrals SET follow_up_at = NULL, follow_up_note = '', follow_up_user = NULL, follow_up_sent = 0 WHERE id = ?").run(ref.id);
      return { follow_up_at: null };
    }
    const at = Date.parse(String(b.at));
    if (!Number.isFinite(at)) throw new HttpError(400, 'Pick a date and time for the call-back.');
    if (at < Date.now() - 60000) throw new HttpError(400, 'That time has already passed.');
    if (at > Date.now() + 180 * 86400000) throw new HttpError(400, 'Pick a time within the next 6 months.');
    const note = String(b.note || '').trim().slice(0, 200);
    db.prepare('UPDATE referrals SET follow_up_at = ?, follow_up_note = ?, follow_up_user = ?, follow_up_sent = 0 WHERE id = ?')
      .run(sqlTime(at), note, u.id, ref.id);
    touch(ref, u.id);
    return { follow_up_at: sqlTime(at), follow_up_note: note };
  }));

  return { tick, touch, config, businessMinutes: (a, b) => businessMinutes(a, b, config()) };
}

module.exports = { mount, businessMinutes, zonedToUtc, tzOffset, localDate, parseHours, validZone, DEFAULTS };
