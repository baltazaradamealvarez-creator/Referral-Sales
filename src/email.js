'use strict';

// Sends email through Resend (https://resend.com). The API key lives only in the
// server's environment (RESEND_API_KEY); without it, email is simply switched off.

const DEFAULT_NAME = 'E&O Referrals';
const DEFAULT_ADDRESS = 'onboarding@resend.dev';

// Splits `Name <addr@x.com>` or `addr@x.com` into its parts.
function parseFrom(value) {
  const v = String(value || '').trim();
  const m = v.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), address: m[2].trim() };
  return { name: '', address: v };
}

// Display names with RFC 5322 "specials" must be quoted.
function formatFrom(name, address) {
  const safe = String(name).replace(/["\\\r\n]/g, '').trim();
  if (!safe) return address;
  return /[()<>[\]:;@\\,.]/.test(safe) ? `"${safe}" <${address}>` : `${safe} <${address}>`;
}

// settings: the app's settings table (email_from_name, email_reply_to), optional.
function emailConfig(settings = {}) {
  const env = parseFrom(process.env.EMAIL_FROM);
  const address = env.address || DEFAULT_ADDRESS;
  const name = (settings.email_from_name || '').trim() || env.name || DEFAULT_NAME;
  return {
    enabled: !!process.env.RESEND_API_KEY,
    address,
    name,
    from: formatFrom(name, address),
    replyTo: (settings.email_reply_to || '').trim(),
    appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Returns { ok: true, id } or { ok: false, error }. Never throws.
async function sendEmail({ to, subject, text, html }, settings = {}) {
  const cfg = emailConfig(settings);
  if (!cfg.enabled) return { ok: false, error: 'Email is not set up (RESEND_API_KEY is missing).' };
  try {
    const body = { from: cfg.from, to: [to], subject, text, html };
    if (cfg.replyTo) body.reply_to = cfg.replyTo;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || `Resend returned ${res.status}` };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The logo image needs the app's public address; without it, a text wordmark is used.
function logoHtml() {
  const { appUrl } = emailConfig();
  return appUrl
    ? `<div style="margin-bottom:16px"><img src="${esc(appUrl)}/brand/logo-email.png" width="156" height="32" alt="E&amp;O Sales" style="display:block;border:0"></div>`
    : '<div style="font-size:20px;margin-bottom:16px"><b style="color:#0b1f52">E&amp;O</b> <span style="color:#3d4451">Sales</span></div>';
}

function layout({ greeting, bodyHtml, button, footer }) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#16202e;max-width:520px">
    ${logoHtml()}
    <p>${esc(greeting)}</p>
    ${bodyHtml}
    ${button ? `<p style="margin:20px 0"><a href="${esc(button.href)}" style="display:inline-block;background:#0b63ce;color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px">${esc(button.label)}</a></p>` : ''}
    <p style="color:#5c6b80;font-size:13px;margin-top:24px">${footer}</p>
  </div>`;
}

// One alert email for an in-app notification.
function alertEmail({ fullName, message, referralId }, settings) {
  const { appUrl } = emailConfig(settings);
  const link = appUrl ? `${appUrl}/#/${referralId ? `r/${referralId}` : 'notifications'}` : '';
  const subject = message.length > 90 ? message.slice(0, 87) + '…' : message;
  const text = `Hi ${fullName},\n\n${message}\n${link ? `\nOpen it: ${link}\n` : ''}\n— E&O Spectrum Referrals\nTurn these emails off under My account.`;
  const html = layout({
    greeting: `Hi ${fullName},`,
    bodyHtml: `<p style="background:#f0f3f8;border-radius:10px;padding:12px 14px;margin:16px 0">${esc(message)}</p>`,
    button: link && { href: link, label: 'Open in E&O Referrals' },
    footer: 'Turn these emails off under <b>My account</b>.',
  });
  return { subject, text, html };
}

function credentialsBlock(username, password) {
  return `<table style="background:#f0f3f8;border-radius:10px;padding:12px 14px;margin:16px 0;font-size:15px">
      <tr><td style="color:#5c6b80;padding-right:14px">Username</td><td><b>${esc(username)}</b></td></tr>
      <tr><td style="color:#5c6b80;padding-right:14px">Temporary password</td><td><b style="font-family:ui-monospace,Menlo,monospace">${esc(password)}</b></td></tr>
    </table>`;
}

function welcomeEmail({ fullName, username, password, roleLabel, teamName, invitedBy }, settings) {
  const { appUrl } = emailConfig(settings);
  const where = teamName ? ` on ${teamName}` : '';
  const text = `Hi ${fullName},\n\n${invitedBy} set you up on E&O Spectrum Referrals as a ${roleLabel}${where}.\n\n`
    + `Username: ${username}\nTemporary password: ${password}\n\n${appUrl ? `Sign in: ${appUrl}\n\n` : ''}`
    + 'You\'ll pick your own password the first time you sign in.\n\n— E&O Spectrum Referrals';
  const html = layout({
    greeting: `Hi ${fullName},`,
    bodyHtml: `<p>${esc(invitedBy)} set you up on <b>E&amp;O Spectrum Referrals</b> as a ${esc(roleLabel)}${esc(where)}. Here's how to sign in:</p>
      ${credentialsBlock(username, password)}
      <p>You'll pick your own password the first time you sign in. On your phone, use <b>Add to Home Screen</b> to keep it one tap away.</p>`,
    button: appUrl && { href: appUrl, label: 'Sign in' },
    footer: 'Didn\'t expect this? You can ignore this email.',
  });
  return { subject: 'Welcome to E&O Spectrum Referrals', text, html };
}

function tempPasswordEmail({ fullName, username, password, resetBy }, settings) {
  const { appUrl } = emailConfig(settings);
  const text = `Hi ${fullName},\n\n${resetBy} reset your E&O Referrals password.\n\nUsername: ${username}\nTemporary password: ${password}\n\n`
    + `${appUrl ? `Sign in: ${appUrl}\n\n` : ''}You'll pick a new password when you sign in.\n\n— E&O Spectrum Referrals`;
  const html = layout({
    greeting: `Hi ${fullName},`,
    bodyHtml: `<p>${esc(resetBy)} reset your password.</p>${credentialsBlock(username, password)}<p>You'll pick a new password when you sign in.</p>`,
    button: appUrl && { href: appUrl, label: 'Sign in' },
    footer: 'If you didn\'t ask for this, tell your manager.',
  });
  return { subject: 'Your E&O Referrals password was reset', text, html };
}

function resetCodeEmail({ fullName, code, minutes }) {
  const text = `Hi ${fullName},\n\nYour E&O Referrals password reset code is: ${code}\n\nIt expires in ${minutes} minutes. `
    + 'If you didn\'t ask for this, ignore this email — your password hasn\'t changed.\n\n— E&O Spectrum Referrals';
  const html = layout({
    greeting: `Hi ${fullName},`,
    bodyHtml: `<p>Here's your password reset code:</p>
      <p style="font-size:30px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,monospace;background:#f0f3f8;border-radius:10px;padding:12px 16px;display:inline-block;margin:8px 0">${esc(code)}</p>
      <p>It expires in ${minutes} minutes.</p>`,
    footer: 'If you didn\'t ask for this, ignore this email — your password hasn\'t changed.',
  });
  return { subject: `${code} is your E&O Referrals reset code`, text, html };
}

module.exports = { emailConfig, sendEmail, alertEmail, welcomeEmail, tempPasswordEmail, resetCodeEmail, parseFrom, formatFrom };
