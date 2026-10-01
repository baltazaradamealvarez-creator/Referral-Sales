'use strict';

// The real WhatsApp connection: links a phone's WhatsApp like WhatsApp Web does (scan a
// QR code), using the Baileys library. Unofficial — WhatsApp may disconnect or ban the
// linked number — so use a separate number just for alerts. The rest of the app only
// sees this small interface, which keeps it replaceable (and testable with a fake).
//
// createTransport({ authDir, onQr, onOpen, onClose, onMessage })
//   -> { start, stop, logout, sendText, react, listGroups, exists }
// onMessage gets plain objects: { id, chat, isGroup, senderJid, senderPhone, name, text, quotedId, mentions, ts }

const fs = require('node:fs');

// Baileys logs a lot; keep it quiet except for real errors.
const quietLogger = {
  level: 'silent',
  child() { return quietLogger; },
  trace() {}, debug() {}, info() {}, warn() {},
  error(obj, msg) { if (process.env.WHATSAPP_DEBUG) console.error('[whatsapp]', msg || '', obj); },
};

const jidDigits = (jid) => (jid ? String(jid).split(/[:@]/)[0].replace(/\D/g, '') : '');

function createTransport({ authDir, onQr, onOpen, onClose, onMessage }) {
  let sock = null;
  let lib = null;
  // Recent raw messages, so replies can quote them and reactions can point at them.
  const raw = new Map();
  const remember = (m) => {
    raw.set(m.key.id, m);
    if (raw.size > 500) raw.delete(raw.keys().next().value);
  };

  async function start() {
    lib = lib || await import('@whiskeysockets/baileys');
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason } = lib;
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const latest = await fetchLatestBaileysVersion().catch(() => null);
    sock = makeWASocket({
      auth: state,
      ...(latest && latest.version ? { version: latest.version } : {}),
      browser: Browsers.ubuntu('E&O Referrals'),
      logger: quietLogger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
    });
    const me = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', ({ messages }) => {
      if (me !== sock || !onMessage) return;
      for (const m of messages || []) {
        try {
          if (!m.message || !m.key || !m.key.remoteJid || m.key.remoteJid === 'status@broadcast') continue;
          remember(m);
          if (m.key.fromMe) continue;
          const msg = (m.message.ephemeralMessage && m.message.ephemeralMessage.message) || m.message;
          const ext = msg.extendedTextMessage || {};
          const text = msg.conversation || ext.text || (msg.imageMessage && msg.imageMessage.caption) || '';
          if (!text) continue;
          const ctx = ext.contextInfo || (msg.imageMessage && msg.imageMessage.contextInfo) || {};
          const chat = m.key.remoteJid;
          const isGroup = chat.endsWith('@g.us');
          const senderJid = isGroup ? m.key.participant : chat;
          const pnJid = m.key.participantPn || m.key.senderPn || (senderJid && senderJid.endsWith('@s.whatsapp.net') ? senderJid : '');
          onMessage({
            id: m.key.id, chat, isGroup, senderJid, senderPhone: jidDigits(pnJid) || null, name: m.pushName || '',
            text: String(text), quotedId: ctx.stanzaId || null, mentions: ctx.mentionedJid || [],
            ts: Number(m.messageTimestamp || 0) * 1000 || Date.now(),
          });
        } catch (e) {
          if (process.env.WHATSAPP_DEBUG) console.error('[whatsapp] bad message', e);
        }
      }
    });
    sock.ev.on('connection.update', (u) => {
      if (me !== sock) return; // an old socket we already replaced
      if (u.qr) onQr(u.qr);
      if (u.connection === 'open') onOpen({ id: sock.user && sock.user.id, lid: sock.user && sock.user.lid, name: sock.user && (sock.user.name || sock.user.verifiedName) });
      if (u.connection === 'close') {
        const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
        sock = null;
        onClose({
          code,
          loggedOut: code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden || code === DisconnectReason.badSession,
          replaced: code === DisconnectReason.connectionReplaced,
          restart: code === DisconnectReason.restartRequired,
          message: u.lastDisconnect && u.lastDisconnect.error ? u.lastDisconnect.error.message : '',
        });
      }
    });
  }

  function stop() {
    if (sock) { const s = sock; sock = null; try { s.end(undefined); } catch { /* already closed */ } }
  }

  async function logout() {
    if (sock) { try { await sock.logout(); } catch { /* not connected */ } }
    stop();
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  // Returns the sent message's id. opts.quotedId replies to (quotes) an earlier message.
  async function sendText(jid, text, opts = {}) {
    if (!sock) throw new Error('WhatsApp is not connected');
    const quoted = opts.quotedId ? raw.get(opts.quotedId) : null;
    const sent = await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
    if (sent && sent.key) remember(sent);
    return sent && sent.key ? sent.key.id : null;
  }

  async function react(jid, messageId, emoji) {
    if (!sock) throw new Error('WhatsApp is not connected');
    const m = raw.get(messageId);
    if (!m) return;
    await sock.sendMessage(jid, { react: { text: emoji, key: m.key } });
  }

  async function listGroups() {
    if (!sock) throw new Error('WhatsApp is not connected');
    const all = await sock.groupFetchAllParticipating();
    return Object.values(all).map((g) => ({ id: g.id, name: g.subject || g.id, size: (g.participants || []).length }));
  }

  // The chat id for a phone number, or null if it has no WhatsApp.
  async function exists(digits) {
    if (!sock) throw new Error('WhatsApp is not connected');
    const [r] = (await sock.onWhatsApp(`${digits}@s.whatsapp.net`)) || [];
    return r && r.exists ? r.jid : null;
  }

  return { start, stop, logout, sendText, react, listGroups, exists };
}

module.exports = { createTransport };
