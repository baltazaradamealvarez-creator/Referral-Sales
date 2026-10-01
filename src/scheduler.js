'use strict';

const mail = require('./email');
const { extractStateFromAddress, normalizeState } = require('./normalize');

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
function executeReportQuery(db, user, config) {
  const dataSource = config.data_source || 'referrals';
  const where = [];
  const params = [];

  // Scoping based on user role
  if (dataSource === 'referrals') {
    if (user.role === 'rep') {
      where.push('(r.created_by = ? OR r.assigned_to = ?)');
      params.push(user.id, user.id);
    } else if (user.role === 'manager') {
      where.push('r.team_id = ?');
      params.push(user.team_id ?? -1);
    }
  }

  // Handle date filters & relative dates
  const dateField = config.date_field || 'created_at';
  let fromDate = config.from || null;
  let toDate = config.to || null;

  if (config.relative_date) {
    const resolved = resolveRelativeDates(config.relative_date);
    fromDate = resolved.from || fromDate;
    toDate = resolved.to || toDate;
  }

  if (fromDate) {
    where.push(`r.${dateField} >= ?`);
    params.push(fromDate);
  }
  if (toDate) {
    where.push(`r.${dateField} < date(?, '+1 day')`);
    params.push(toDate);
  }

  // Field filters
  if (config.filters && Array.isArray(config.filters)) {
    for (const f of config.filters) {
      if (!f.field || !f.value) continue;
      const val = f.value;

      if (f.field === 'status') {
        if (Array.isArray(val) && val.length) {
          where.push(`r.status IN (${val.map(() => '?').join(',')})`);
          params.push(...val);
        } else if (typeof val === 'string') {
          where.push('r.status = ?');
          params.push(val);
        }
      } else if (f.field === 'team_id' && (user.role === 'admin' || user.role === 'dispatch')) {
        if (Array.isArray(val) && val.length) {
          where.push(`r.team_id IN (${val.map(() => '?').join(',')})`);
          params.push(...val);
        } else if (val) {
          where.push('r.team_id = ?');
          params.push(Number(val));
        }
      } else if (f.field === 'created_by') {
        where.push('r.created_by = ?');
        params.push(Number(val));
      } else if (f.field === 'state') {
        const norm = normalizeState(val);
        if (norm) {
          where.push('(r.address LIKE ? OR r.address LIKE ?)');
          params.push(`% ${norm.code} %`, `% ${norm.name}%`);
        }
      } else if (f.field === 'service') {
        where.push("(', ' || r.services || ',') LIKE ?");
        params.push(`%, ${val},%`);
      }
    }
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const sql = `
    SELECT r.id, r.created_at, r.customer_name, r.phone, r.email, r.address,
      r.services, r.status, r.account_number, r.install_date, r.notes,
      u.full_name AS created_by_name, t.name AS team_name,
      a.full_name AS assigned_name
    FROM referrals r
    JOIN users u ON u.id = r.created_by
    LEFT JOIN teams t ON t.id = r.team_id
    LEFT JOIN users a ON a.id = r.assigned_to
    ${whereClause}
    ORDER BY r.created_at DESC LIMIT 10000
  `;

  const rows = db.prepare(sql).all(...params);

  // Derive normalized state for each row
  for (const r of rows) {
    const st = extractStateFromAddress(r.address);
    r.state = st ? st.code : 'N/A';
    r.state_name = st ? st.name : 'Unknown';
  }

  return rows;
}

// Generates CSV format for report rows
function generateCSV(rows, columns) {
  const cols = columns && columns.length
    ? columns
    : ['id', 'created_at', 'customer_name', 'phone', 'email', 'address', 'state', 'services', 'status', 'created_by_name', 'team_name'];

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
function generateHTMLTable(rows, title, periodLabel) {
  const cols = ['id', 'created_at', 'customer_name', 'status', 'services', 'created_by_name', 'team_name'];
  let html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; color: #1e293b;">
      <h2 style="color: #0f172a; margin-bottom: 4px;">${title}</h2>
      <p style="color: #64748b; font-size: 14px; margin-top: 0;">Period: ${periodLabel || 'Current Snapshot'}</p>
      <table style="width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px;">
        <thead>
          <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0; text-align: left;">
            <th style="padding: 8px 12px;">ID</th>
            <th style="padding: 8px 12px;">Date</th>
            <th style="padding: 8px 12px;">Customer</th>
            <th style="padding: 8px 12px;">Status</th>
            <th style="padding: 8px 12px;">Services</th>
            <th style="padding: 8px 12px;">Rep</th>
            <th style="padding: 8px 12px;">Team</th>
          </tr>
        </thead>
        <tbody>
  `;

  for (const r of rows.slice(0, 50)) {
    html += `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px 12px;">#${r.id}</td>
        <td style="padding: 8px 12px;">${(r.created_at || '').slice(0, 10)}</td>
        <td style="padding: 8px 12px; font-weight: 500;">${r.customer_name || ''}</td>
        <td style="padding: 8px 12px;"><span style="background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 9999px; font-weight: 600;">${r.status}</span></td>
        <td style="padding: 8px 12px;">${r.services || '-'}</td>
        <td style="padding: 8px 12px;">${r.created_by_name || ''}</td>
        <td style="padding: 8px 12px;">${r.team_name || '-'}</td>
      </tr>
    `;
  }

  html += `
        </tbody>
      </table>
      ${rows.length > 50 ? `<p style="color: #64748b; font-size: 12px;">Showing top 50 of ${rows.length} total records.</p>` : ''}
    </div>
  `;
  return html;
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
  const html = generateHTMLTable(rows, schedule.report_name, periodLabel);
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
