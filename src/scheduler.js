'use strict';

const mail = require('./email');
const { extractStateFromAddress, normalizeState } = require('./normalize');
const { STAGE_CTES } = require('./lead-stages');
const { FIELDS, DEFAULT_COLUMNS, field, validateConfig } = require('./report-fields');

// Resolves relative date filters at execution time
function resolveRelativeDates(preset, refDateStr) {
  const ref = refDateStr ? new Date(`${refDateStr}T12:00:00Z`) : new Date();
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth(); // 0-indexed
  const day = ref.getUTCDate();

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

  if (preset === 'today') {
    return { from: fmt(ref), to: fmt(ref) };
  }
  if (preset === 'yesterday') {
    const y = new Date(ref);
    y.setUTCDate(y.getUTCDate() - 1);
    return { from: fmt(y), to: fmt(y) };
  }
  if (preset === 'this_week') {
    const dayOfWeek = ref.getUTCDay(); // 0 = Sun
    const start = new Date(ref);
    start.setUTCDate(ref.getUTCDate() - dayOfWeek);
    return { from: fmt(start), to: fmt(ref) };
  }
  if (preset === 'last_week') {
    const dayOfWeek = ref.getUTCDay();
    const end = new Date(ref);
    end.setUTCDate(ref.getUTCDate() - dayOfWeek - 1);
    const start = new Date(end);
    start.setUTCDate(end.getUTCDate() - 6);
    return { from: fmt(start), to: fmt(end) };
  }
  if (preset === 'this_month') {
    const start = new Date(Date.UTC(year, month, 1));
    return { from: fmt(start), to: fmt(ref) };
  }
  if (preset === 'last_month') {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    return { from: fmt(start), to: fmt(end) };
  }
  if (preset === 'qtd') {
    const qMonth = Math.floor(month / 3) * 3;
    const start = new Date(Date.UTC(year, qMonth, 1));
    return { from: fmt(start), to: fmt(ref) };
  }
  if (preset === 'ytd') {
    const start = new Date(Date.UTC(year, 0, 1));
    return { from: fmt(start), to: fmt(ref) };
  }
  if (preset === 'rolling_30d' || preset === 'last_30_days') {
    const start = new Date(ref);
    start.setUTCDate(ref.getUTCDate() - 29);
    return { from: fmt(start), to: fmt(ref) };
  }
  if (preset === 'rolling_90d' || preset === 'last_90_days') {
    const start = new Date(ref);
    start.setUTCDate(ref.getUTCDate() - 89);
    return { from: fmt(start), to: fmt(ref) };
  }
  return { from: null, to: null };
}

function computeNextRun(cadence, deliveryTime = '08:00', dayOfWeek = 1, dayOfMonth = 1, fromDate = new Date()) {
  const [hours, minutes] = deliveryTime.split(':').map((x) => parseInt(x, 10) || 0);
  const next = new Date(fromDate);
  next.setUTCHours(hours, minutes, 0, 0);

  if (next <= fromDate) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  if (cadence === 'weekly') {
    // dayOfWeek: 0 = Sun, 1 = Mon ...
    while (next.getUTCDay() !== dayOfWeek) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  } else if (cadence === 'monthly') {
    while (next.getUTCDate() !== Math.min(dayOfMonth, 28)) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }

  return next.toISOString().replace('T', ' ').slice(0, 19);
}

// Executes a report definition safely against the database with strict permission scoping
function executeReportQuery(db, user, config = {}) {
  validateConfig(config);
  const where = [], params = [];
  if (user.role === 'rep') {
    where.push('(r.created_by = ? OR r.assigned_to = ?)'); params.push(user.id, user.id);
  } else if (user.role === 'manager') {
    where.push('r.team_id = ?'); params.push(user.team_id ?? -1);
  } else if (!['admin','dispatch'].includes(user.role)) {
    where.push('0 = 1');
  }
  const dateField = field(config.date_field || 'created_at').sql;
  let fromDate = config.from || null, toDate = config.to || null;
  if (config.relative_date) {
    const resolved = resolveRelativeDates(config.relative_date);
    fromDate = resolved.from || fromDate; toDate = resolved.to || toDate;
  }
  if (fromDate) { where.push(`${dateField} >= ?`); params.push(fromDate); }
  if (toDate) { where.push(`${dateField} < date(?, '+1 day')`); params.push(toDate); }
  const filters = [];
  for (const f of config.filters || []) {
    const key = f.field === 'service' ? 'services' : f.field;
    const def = field(key), sql = def.sql;
    const op = f.op || (Array.isArray(f.value) ? 'in' : f.field === 'service' ? 'contains' : 'eq');
    const value = def.type === 'number' ? Number(f.value) : f.value;
    if (op === 'empty' || op === 'not_empty') {
      filters.push(`(${sql} IS ${op === 'empty' ? '' : 'NOT '}NULL ${op === 'empty' ? 'OR' : 'AND'} ${sql} ${op === 'empty' ? '=' : '<>'} '')`);
    } else if (op === 'in') {
      filters.push(`${sql} IN (${f.value.map(()=>'?').join(',')})`);
      params.push(...f.value.map(v=>def.type === 'number' ? Number(v) : v));
    } else if (key === 'state' && ['eq','ne'].includes(op) && normalizeState(value)) {
      const state = normalizeState(value);
      filters.push(`upper(trim(${sql})) ${op === 'ne' ? 'NOT ' : ''}IN (?,?)`); params.push(state.code,state.name.toUpperCase());
    } else if (op === 'contains' || op === 'not_contains') {
      filters.push(`${sql} ${op === 'not_contains' ? 'NOT ' : ''}LIKE ? ESCAPE '\\'`);
      params.push('%' + String(value).replace(/[\\%_]/g, ch=>'\\' + ch) + '%');
    } else {
      const operators = {eq:'=',ne:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='};
      filters.push(`${sql} ${operators[op]} ?`); params.push(value);
    }
  }
  if (filters.length) where.push('(' + filters.join(config.filter_logic === 'any' ? ' OR ' : ' AND ') + ')');
  const sort = field(config.sort_by || 'created_at').sql;
  const rows = db.prepare(`WITH ${STAGE_CTES}
    SELECT ${FIELDS.map(f=>`${f.sql} AS ${f.key}`).join(', ')}
    FROM referrals r JOIN users u ON u.id = r.created_by
    LEFT JOIN teams t ON t.id = r.team_id LEFT JOIN users a ON a.id = r.assigned_to
    LEFT JOIN users e ON e.id = r.entered_by LEFT JOIN users f ON f.id = r.first_touch_by
    LEFT JOIN stage_facts st ON st.referral_id = r.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${sort} ${config.sort_direction === 'asc' ? 'ASC' : 'DESC'}, r.id DESC LIMIT 10001
  `).all(...params);
  rows.truncated = rows.length > 10000;
  if (rows.truncated) rows.pop();
  for (const r of rows) {
    const st = normalizeState(r.state) || extractStateFromAddress(r.address);
    r.state = st ? st.code : 'N/A'; r.state_name = st ? st.name : 'Unknown';
    for (const f of FIELDS.filter(f=>f.group === 'Stage timers' && f.type === 'number')) {
      if (r[f.key] != null) r[f.key] = Math.round(r[f.key] * 100) / 100;
    }
  }
  return rows;
}

// Generates CSV format for report rows
function generateCSV(rows, columns) {
  const cols = columns && columns.length ? columns : DEFAULT_COLUMNS;
  cols.forEach(field);

  const header = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');

  const escapeCell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = rows.map((r) => cols.map((c) => escapeCell(r[c])).join(','));
  return [header, ...lines].join('\r\n');
}

// Generates HTML format for email body preview
function generateHTMLTable(rows, title, periodLabel, columns) {
  const cols = columns?.length ? columns : ['id','created_at','customer_name','status','services','created_by_name','team_name'];
  cols.forEach(field);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<div style="font-family:Arial,sans-serif;color:#1e293b;overflow:auto">
    <h2>${esc(title)}</h2><p>Period: ${esc(periodLabel || 'Current snapshot')}</p>
    <table style="border-collapse:collapse;font-size:13px"><thead><tr>${cols.map(c=>`<th style="padding:8px;text-align:left">${esc(field(c).label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.slice(0,50).map(r=>`<tr>${cols.map(c=>`<td style="padding:8px;border-top:1px solid #e2e8f0">${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>
    ${rows.length > 50 ? `<p>Showing 50 of ${rows.length} records. All selected records are in the CSV attachment.</p>` : ''}</div>`;
}

// Executes a single scheduled report
async function runScheduledReport(db, scheduleId) {
  const schedule = db.prepare(`
    SELECT s.*, r.name AS report_name, r.config AS report_config, u.email AS creator_email, u.full_name AS creator_name, u.role AS creator_role, u.team_id AS creator_team_id
    FROM report_schedules s
    JOIN reports r ON r.id = s.report_id
    JOIN users u ON u.id = s.created_by
    WHERE s.id = ?
  `).get(scheduleId);

  if (!schedule || !schedule.active) return null;

  let config = {};
  try {
    config = JSON.parse(schedule.report_config || '{}');
  } catch {
    config = {};
  }

  const owner = {
    id: schedule.created_by,
    email: schedule.creator_email,
    role: schedule.creator_role,
    team_id: schedule.creator_team_id,
  };

  const rows = executeReportQuery(db, owner, config);
  let recipients = [];
  try {
    recipients = JSON.parse(schedule.recipients || '[]');
  } catch {
    recipients = [];
  }

  if (recipients.length === 0 && owner.email) {
    recipients.push(owner.email);
  }

  const periodLabel = config.relative_date ? config.relative_date.replace(/_/g, ' ').toUpperCase() : 'All Time';

  if (schedule.skip_empty && rows.length === 0) {
    // Record skipped run
    db.prepare(`
      INSERT INTO schedule_deliveries (schedule_id, report_id, status, record_count, recipients_count, period_label, error_message)
      VALUES (?, ?, 'skipped', 0, ?, ?, 'Skipped: No records found')
    `).run(schedule.id, schedule.report_id, recipients.length, periodLabel);

    const nextRun = computeNextRun(schedule.cadence, schedule.delivery_time, schedule.day_of_week, schedule.day_of_month);
    db.prepare(`
      UPDATE report_schedules SET last_run_at = datetime('now'), last_status = 'skipped', next_run_at = ? WHERE id = ?
    `).run(nextRun, schedule.id);

    return { status: 'skipped', count: 0 };
  }

  // Format delivery content
  const html = generateHTMLTable(rows, schedule.report_name, periodLabel, config.columns);
  const csv = generateCSV(rows, config.columns);

  const settingsRow = db.prepare("SELECT key, value FROM settings WHERE key IN ('email_from_name', 'email_reply_to')").all();
  const settings = Object.fromEntries(settingsRow.map((x) => [x.key, x.value]));

  let sentCount = 0;
  const errors = [];

  for (const recipientEmail of recipients) {
    if (!recipientEmail) continue;

    const emailSubject = `[Report Delivery] ${schedule.report_name} (${rows.length} records)`;
    let result;
    try { result = await mail.sendEmail({
      to: recipientEmail,
      subject: emailSubject,
      html,
      attachments: [
        {
          filename: `${schedule.report_name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`,
          content: Buffer.from(csv, 'utf8').toString('base64'),
          type: 'text/csv',
        },
      ],
    }, settings); } catch (err) { result = { ok: false, error: err.message }; }
    if (result && result.ok) sentCount++;
    else errors.push(result && result.error || 'Email delivery failed.');
  }

  if (!recipients.some(Boolean)) errors.push('No recipient email address is configured.');
  const status = errors.length ? 'failed' : 'success';
  const lastError = [...new Set(errors)].join('; ').slice(0, 1000);

  db.prepare(`
    INSERT INTO schedule_deliveries (schedule_id, report_id, status, record_count, recipients_count, period_label, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(schedule.id, schedule.report_id, status, rows.length, sentCount, periodLabel, lastError);

  const nextRun = computeNextRun(schedule.cadence, schedule.delivery_time, schedule.day_of_week, schedule.day_of_month);
  db.prepare(`
    UPDATE report_schedules SET last_run_at = datetime('now'), last_status = ?, next_run_at = ? WHERE id = ?
  `).run(status, nextRun, schedule.id);

  return { status, count: rows.length, recipients: sentCount, ...(lastError ? { error: lastError } : {}) };
}

// Background loop checking due scheduled reports
function startScheduler(db, intervalMs = 60000) {
  const running = new Set();
  const tick = async () => {
    try {
      const dueSchedules = db.prepare(`
        SELECT id FROM report_schedules
        WHERE active = 1 AND next_run_at <= datetime('now')
      `).all();

      for (const item of dueSchedules) {
        if (running.has(item.id)) continue;
        running.add(item.id);
        try { await runScheduledReport(db, item.id); }
        catch (err) { console.error('Error in report scheduler run:', err.message); }
        finally { running.delete(item.id); }
      }
    } catch (err) {
      console.error('Error in report scheduler tick:', err);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  resolveRelativeDates,
  computeNextRun,
  executeReportQuery,
  generateCSV,
  generateHTMLTable,
  runScheduledReport,
  startScheduler,
};
