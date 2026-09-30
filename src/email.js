'use strict';

// Sends email through Resend (https://resend.com). The API key lives only in the
// server's environment (RESEND_API_KEY); without it, email is simply switched off.

const DEFAULT_FROM = 'E&O Referrals <onboarding@resend.dev>';

function emailConfig() {
  return {
    enabled: !!process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || DEFAULT_FROM,
    appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Returns { ok: true, id } or { ok: false, error }. Never throws.
async function sendEmail({ to, subject, text, html }) {
  const cfg = emailConfig();
  if (!cfg.enabled) return { ok: false, error: 'Email is not set up (RESEND_API_KEY is missing).' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: [to], subject, text, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || `Resend returned ${res.status}` };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// One alert email for an in-app notification.
function alertEmail({ fullName, message, referralId }) {
  const { appUrl } = emailConfig();
  const link = appUrl ? `${appUrl}/#/${referralId ? `r/${referralId}` : 'notifications'}` : '';
  const subject = message.length > 90 ? message.slice(0, 87) + '…' : message;
  const text = `Hi ${fullName},\n\n${message}\n${link ? `\nOpen it: ${link}\n` : ''}\n— E&O Spectrum Referrals\nTurn these emails off under My account.`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#16202e;max-width:520px">
    <p>Hi ${esc(fullName)},</p>
    <p style="background:#f0f3f8;border-radius:10px;padding:12px 14px;margin:16px 0">${esc(message)}</p>
    ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#0b63ce;color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px">Open in E&amp;O Referrals</a></p>` : ''}
    <p style="color:#5c6b80;font-size:13px;margin-top:24px">E&amp;O Spectrum Referrals · Turn these emails off under <b>My account</b>.</p>
  </div>`;
  return { subject, text, html };
}

module.exports = { emailConfig, sendEmail, alertEmail };
