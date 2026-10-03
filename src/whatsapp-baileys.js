'use strict';

// The real WhatsApp connection: links a phone's WhatsApp like WhatsApp Web does (scan a
// QR code), using the Baileys library. Unofficial — WhatsApp may disconnect or ban the
// linked number — so use a separate number just for alerts. The rest of the app only
// sees this small interface, which keeps it replaceable (and testable with a fake).
//
// createTransport({ authDir, onQr, onOpen, onClose, onMessage, onDiagnostic, canRetryMessage })
//   -> { start, stop, logout, sendText, react, listGroups, exists }
// stop() waits for pending message operations and session-key writes.
// onMessage gets plain objects: { id, chat, isGroup, senderJid, senderPhone, name, text, quotedId, mentions, ts }

const fs = require('node:fs');
const { createRetryStore } = require('./whatsapp-retry-store');

// Baileys logs a lot; keep it quiet except for real errors.
const quietLogger = {
  level: 'silent',
  child() { return quietLogger; },
  trace() {}, debug() {}, info() {}, warn() {},
  error(obj, msg) { if (process.env.WHATSAPP_DEBUG) console.error('[whatsapp]', msg || '', obj); },
};

const jidDigits = (jid) => (jid ? String(jid).split(/[:@]/)[0].replace(/\D/g, '') : '');

function createTransport({ authDir, onQr, onOpen, onClose, onMessage, onDiagnostic,
  canRetryMessage = () => true, loadLibrary = () => import('@whiskeysockets/baileys') }) {
  let sock = null;
  let lib = null;
  let retryStore = null;
  const pendingWrites=new Set(),pendingSends=new Set(),peerAliases=new Map();
  const groupNumbers=new Map(),groupLookups=new Map();
  function rememberGroup(group) {
    const phones=new Map();
    for(const member of group.participants || []) {
      const phone=member.jid?.endsWith('@s.whatsapp.net') ? member.jid : member.id?.endsWith('@s.whatsapp.net') ? member.id : '';
      const lid=member.lid || (member.id?.endsWith('@lid') ? member.id : '');
      if(phone && lid)phones.set(lib.jidNormalizedUser(lid),jidDigits(phone));
    }
    groupNumbers.set(group.id,{at:Date.now(),phones});
  }
  const diagnostic=kind=>{try{onDiagnostic?.({kind});}catch{}};
  function track(promise,set) {
    const job=Promise.resolve(promise);set.add(job);
    job.then(()=>set.delete(job),()=>set.delete(job));return job;
  }
  function linkPeers(a,b) {
    if(!a || !b)return;
    const peers=new Set([lib.jidNormalizedUser(a),lib.jidNormalizedUser(b),...(peerAliases.get(lib.jidNormalizedUser(a)) || []),...(peerAliases.get(lib.jidNormalizedUser(b)) || [])]);
    for(const peer of peers)peerAliases.set(peer,peers);
  }
  // Recent raw messages, so replies can quote them and reactions can point at them.
  const raw = new Map();
  const remember = (m) => {
    raw.set(m.key.id, m);
    if (raw.size > 500) raw.delete(raw.keys().next().value);
  };

  async function start() {
    lib = lib || await loadLibrary();
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason } = lib;
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const saveKeys=state.keys.set.bind(state.keys);
    state.keys.set=data=>track(saveKeys(data),pendingWrites).catch(e=>{diagnostic('auth_save_error');throw e;});
    retryStore=createRetryStore(authDir,{codec:lib.proto.Message,normalizeJid:lib.jidNormalizedUser,allowRetry:canRetryMessage,onDiagnostic});
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
      getMessage:async key=>{
        const peers=peerAliases.get(lib.jidNormalizedUser(key?.remoteJid || ''));
        return retryStore.get(key,peers ? [...peers] : []);
      },
    });
    const me = sock;
    sock.ev.on('creds.update',()=>{track(saveCreds(),pendingWrites).catch(()=>diagnostic('auth_save_error'));});
    sock.ev.on('messages.upsert', ({ messages }) => {
      if (me !== sock || !onMessage) return;
      for (const m of messages || []) {
        try {
          if (!m.message || !m.key || !m.key.remoteJid || m.key.remoteJid === 'status@broadcast') continue;
          remember(m);
          if (m.key.fromMe) continue;
          const msg = lib.extractMessageContent(m.message) || m.message;
          const ext = msg.extendedTextMessage || {};
          const doc = msg.documentMessage;
          const pdf = doc && (doc.mimetype === 'application/pdf' || /\.pdf$/i.test(doc.fileName || ''));
          const text = msg.conversation || ext.text || msg.imageMessage?.caption || doc?.caption || '';
          if (!text && !pdf) continue;
          const ctx = ext.contextInfo || msg.imageMessage?.contextInfo || doc?.contextInfo || {};
          const chat = m.key.remoteJid;
          const isGroup = chat.endsWith('@g.us');
          const senderJid = isGroup ? m.key.participant : chat;
          const pnJid = m.key.participantPn || m.key.senderPn || (senderJid && senderJid.endsWith('@s.whatsapp.net') ? senderJid : '');
          if(!isGroup && pnJid)linkPeers(chat,pnJid);
          onMessage({
            id: m.key.id, chat, isGroup, senderJid, senderPhone: jidDigits(pnJid) || null, name: m.pushName || '',
            text: String(text), quotedId: ctx.stanzaId || null, mentions: ctx.mentionedJid || [],
            ts: Number(m.messageTimestamp || 0) * 1000 || Date.now(),
            ...(!pnJid && isGroup && senderJid?.endsWith('@lid') ? {
              async resolveSenderPhone() {
                let group=groupNumbers.get(chat);
                if(!group || Date.now()-group.at>5*60000) {
                  if(!me.groupMetadata)return null;
                  if(!groupLookups.has(chat)) {
                    let timer;
                    const lookup=Promise.race([me.groupMetadata(chat),new Promise((_,reject)=>{
                      timer=setTimeout(()=>reject(new Error('Group lookup timed out')),5000);timer.unref();
                    })]).then(data=>rememberGroup(data)).catch(()=>{}).finally(()=>{clearTimeout(timer);groupLookups.delete(chat);});
                    groupLookups.set(chat,lookup);
                  }
                  await groupLookups.get(chat);group=groupNumbers.get(chat);
                }
                return group?.phones.get(lib.jidNormalizedUser(senderJid)) || null;
              }} : {}),
            ...(pdf ? {document:{ filename:String(doc.fileName || 'Order.pdf').slice(0,150), mimetype:'application/pdf',
              bytes:Number(doc.fileLength?.toNumber?.() ?? doc.fileLength ?? 0),
              // No media is fetched until the quiet-group handler checks the sender.
              async download(signal) {
                const {MAX_BYTES}=require('./whatsapp-order-pdf');
                if (Number(doc.fileLength?.toNumber?.() ?? doc.fileLength ?? 0)>MAX_BYTES) throw new Error('PDF is larger than 5 MB.');
                const stream=await lib.downloadMediaMessage(m,'stream',{options:{timeout:15000,signal}},
                  {logger:quietLogger,reuploadRequest:me.updateMediaMessage?.bind(me)});
                const chunks=[];let size=0;
                try {
                  for await(const chunk of stream) {
                    size+=chunk.length;
                    if(signal?.aborted)throw new Error('PDF download cancelled.');
                    if(size>MAX_BYTES)throw new Error('PDF is larger than 5 MB.');
                    chunks.push(chunk);
                  }
                  return Buffer.concat(chunks);
                } finally {stream.destroy();}
              }}} : {}),
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

  async function stop() {
    if (sock) { const s = sock; sock = null; try { s.end(undefined); } catch { /* already closed */ } }
    await Promise.allSettled([...pendingSends]);
    do{await Promise.allSettled([...pendingWrites]);await new Promise(resolve=>setImmediate(resolve));}while(pendingWrites.size);
  }

  async function logout() {
    if (sock) { try { await sock.logout(); } catch { /* not connected */ } }
    await stop();
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  // Returns the sent message's id. opts.quotedId replies to (quotes) an earlier message.
  async function sendText(jid, text, opts = {}) {
    if (!sock) throw new Error('WhatsApp is not connected');
    const quoted = opts.quotedId ? raw.get(opts.quotedId) : null;
    const me=sock;
    return track((async()=>{
      const sent = await me.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
      if (sent && sent.key) {
        remember(sent);
        const peers=peerAliases.get(lib.jidNormalizedUser(jid));
        retryStore.put(sent,jid,{kind:opts.kind,quiet:opts.quiet,aliases:peers ? [...peers] : []});
      }
      return sent && sent.key ? sent.key.id : null;
    })(),pendingSends);
  }

  async function react(jid, messageId, emoji) {
    if (!sock) throw new Error('WhatsApp is not connected');
    const m = raw.get(messageId);
    if (!m) return;
    await track(sock.sendMessage(jid, { react: { text: emoji, key: m.key } }),pendingSends);
  }

  async function listGroups() {
    if (!sock) throw new Error('WhatsApp is not connected');
    const all = await sock.groupFetchAllParticipating();
    for(const group of Object.values(all))rememberGroup(group);
    return Object.values(all).map((g) => ({ id: g.id, name: g.subject || g.id, size: (g.participants || []).length }));
  }

  // The chat id for a phone number, or null if it has no WhatsApp.
  async function exists(digits) {
    if (!sock) throw new Error('WhatsApp is not connected');
    const [r] = (await sock.onWhatsApp(`${digits}@s.whatsapp.net`)) || [];
    if(r?.exists && r.lid)linkPeers(r.jid,r.lid);
    return r && r.exists ? r.jid : null;
  }

  return { start, stop, logout, sendText, react, listGroups, exists };
}

module.exports = { createTransport };
