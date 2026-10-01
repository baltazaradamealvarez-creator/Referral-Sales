'use strict';

// The two-way dispatch group on WhatsApp:
//   - every new lead is posted to the group (see announceNewLead in app.js);
//   - a reply to a lead's post (or "#123 …") becomes a note on that lead;
//   - the first dispatcher to reply takes the lead (it's assigned to them);
//   - "approved", "DNQ", "cancelado"… in the reply changes the lead's status;
//   - "@owner" / "@dueño" sends the note to the rep who entered the lead;
//   - "bot …" talks to the assistant (src/agent.js: leads, notes, statuses, reminders, numbers);
//     replying to its answer, or messaging the alerts number privately, continues the chat;
//   - "help" / "ayuda" posts the instructions, in English and Spanish.
// Only people whose WhatsApp number is saved in the app can do anything, and only what
// they could do in the app (reps add notes; dispatch, managers and admins change status).

const { digitsOf } = require('./whatsapp');

const MAX_AGE_MS = 24 * 3600 * 1000;

// ---------- language and keywords ----------

const plain = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function detectLang(text) {
  const t = plain(text);
  if (/[¿¡ñ]/.test(String(text).toLowerCase())) return 'es';
  const es = (t.match(/\b(el|la|los|las|que|por|para|con|una|uno|cliente|llamar|llame|aprobado|cancelado|gracias|hoy|cuantos|quien|esta|estan|si|ya|tambien|dueno|nota|venta)\b/g) || []).length;
  const en = (t.match(/\b(the|is|are|and|for|with|customer|call|called|approved|cancelled|thanks|today|how|many|who|what|yes|already|owner|note|sale)\b/g) || []).length;
  return es > en ? 'es' : 'en';
}

// Status a reply reports, by keywords (English and Spanish). Returns { status } or
// { options: [...] } when it mentions more than one, or {} when it reports none.
function detectStatus(text, approvedStatus = 'Ordered') {
  const t = ` ${plain(text).replace(/[^\w\s#@'-]/g, ' ')} `;
  // "not approved yet", "todavia no aprobado"… report nothing yet.
  const cleaned = t.replace(/\b(not|no|todavia no|aun no|still not|not yet)\s+(yet\s+)?(been\s+)?(approved|aprobad[oa]|ordered|ordenad[oa]|sold|vendid[oa]|cancel\w*|cancelad[oa])\b/g, ' ');
  const found = new Set();
  if (/\b(dnq|no califica|no califico|not qualif\w*|didn'?t qualify|did not qualify|no paso|denied|denegad[oa]|negad[oa]|rechazad[oa]|declined|no aplica|credit (fail\w*|denied))\b/.test(cleaned)) found.add('DNQ');
  if (/\b(cancel+ed|cancel+ation|cancel|cancelad[oa]|cancelar|not interested|no le interesa|ya no quiere)\b/.test(cleaned)) found.add('Cancelled');
  if (/\b(ordered|order placed|ordenad[oa]|orden puesta|sold|vendid[oa]|venta (hecha|cerrada|lista)|installed|instalad[oa])\b/.test(cleaned)) found.add('Ordered');
  if (/\b(approved|approve|aprobad[oa]|aprobaron)\b/.test(cleaned)) found.add(approvedStatus);
  if (!found.has('DNQ') && /\b(passed|paso|qualified|califica|calificad[oa]|in progress|en proceso|working on it|trabajando)\b/.test(cleaned)) found.add('Passed');
  const list = [...found];
  if (list.length === 1) return { status: list[0] };
  if (list.length > 1) return { options: list };
  return {};
}

const OWNER_TAG = /(^|\s)@(owner|due[nñ]o|rep|vendedor|vendedora)\b/i;

// ---------- the instructions ----------

function instructions(approvedStatus) {
  const ap = approvedStatus === 'Passed' ? 'Passed' : 'Ordered';
  return [
    '📋 *E&O Referrals — how this group works*',
    '',
    '• Every new lead is posted here.',
    '• *Reply* to a lead (swipe right on it) to add a note. The *first dispatcher to reply takes the lead*.',
    `• Write *approved* (→ ${ap}), *passed*, *DNQ* or *cancelled* in your reply to change its status.`,
    '• Add *@owner* to send your note to the rep who entered the lead.',
    '• Can\'t find the post? Start with the lead number: *#123 approved*.',
    '• Ask the assistant — start with *bot*: _bot what\'s waiting?_ · _bot remind me at 5pm to call #12_ · _bot how did we do this week?_ Reply to its answer to keep talking, or message this number privately.',
    '• Type *help* to see this again.',
    '• Your WhatsApp number must be saved in the app (Account → WhatsApp alerts) so I know who you are.',
    '',
    '📋 *E&O Referrals — cómo funciona este grupo*',
    '',
    '• Cada lead nuevo se publica aquí.',
    '• *Responde* a un lead (desliza a la derecha) para agregar una nota. El *primer dispatcher en responder toma el lead*.',
    `• Escribe *aprobado* (→ ${ap}), *pasó*, *no califica* o *cancelado* en tu respuesta para cambiar el estado.`,
    '• Agrega *@dueño* para enviar tu nota al vendedor que ingresó el lead.',
    '• ¿No encuentras el mensaje? Empieza con el número del lead: *#123 aprobado*.',
    '• Pregúntale al asistente — empieza con *bot*: _bot ¿qué está pendiente?_ · _bot recuérdame a las 5pm llamar al #12_ · _bot ¿cómo nos fue esta semana?_ Responde a su mensaje para seguir, o escríbele a este número en privado.',
    '• Escribe *ayuda* para ver esto otra vez.',
    '• Tu número de WhatsApp debe estar guardado en la app (Cuenta → Alertas de WhatsApp) para saber quién eres.',
  ].join('\n');
}

const T = {
  unknown: {
    en: 'I don\'t recognise this number yet. Add your WhatsApp number in the app (Account → WhatsApp alerts) and try again.',
    es: 'Todavía no reconozco este número. Agrega tu número de WhatsApp en la app (Cuenta → Alertas de WhatsApp) e intenta de nuevo.',
  },
  notFound: { en: (id) => `I can't find lead #${id}.`, es: (id) => `No encuentro el lead #${id}.` },
  noAccess: { en: (id) => `You don't have access to lead #${id}.`, es: (id) => `No tienes acceso al lead #${id}.` },
  noStatus: {
    en: 'Saved as a note. Only dispatch, a manager or an admin can change the status.',
    es: 'Guardado como nota. Solo dispatch, un gerente o un administrador puede cambiar el estado.',
  },
  which: {
    en: (opts) => `Which status should I set: ${opts.map((o) => `*${o}*`).join(' or ')}? Reply to this message with one.`,
    es: (opts) => `¿Qué estado pongo: ${opts.map((o) => `*${o}*`).join(' o ')}? Responde a este mensaje con uno.`,
  },
  failed: { en: (e) => `I couldn't update it: ${e}`, es: (e) => `No pude actualizarlo: ${e}` },
  noAi: {
    en: 'I can only handle replies to lead posts right now. Type *help* to see what I can do.',
    es: 'Por ahora solo manejo respuestas a los leads. Escribe *ayuda* para ver lo que puedo hacer.',
  },
  slow: {
    en: 'Give me a few minutes — that\'s a lot of questions at once.',
    es: 'Dame unos minutos — son muchas preguntas seguidas.',
  },
  aiDown: {
    en: 'I can\'t answer that right now. Please check the app.',
    es: 'No puedo responder eso ahora. Revisa la app, por favor.',
  },
};

// ---------- the bot ----------

function mount(app, db, deps) {
  const { whatsapp, ai, agent, getSettings, getReferral, canViewReferral, canManageReferral, seesAll, updateReferral, addComment, logAudit, requireRole, wrap, HttpError } = deps;

  const cfg = () => {
    const s = getSettings();
    return {
      enabled: s.wa_two_way !== '0',
      approvedStatus: s.wa_approved_status === 'Passed' ? 'Passed' : 'Ordered',
    };
  };

  let handled = 0;
  // Rate limits so a busy group or a loop can't make the bot spam.
  const recent = new Map();
  const allow = (key, max, ms) => {
    const now = Date.now();
    const hits = (recent.get(key) || []).filter((t) => now - t < ms);
    if (hits.length >= max) return false;
    hits.push(now);
    recent.set(key, hits);
    return true;
  };

  function findUser(m) {
    const users = db.prepare("SELECT id, username, full_name, role, team_id, whatsapp FROM users WHERE active = 1 AND whatsapp <> ''").all();
    if (m.senderPhone) {
      const d = digitsOf(m.senderPhone);
      const u = users.find((x) => digitsOf(x.whatsapp) === d);
      if (u) {
        if (m.senderJid) db.prepare("INSERT INTO wa_identities (jid, user_id) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET user_id = excluded.user_id, updated_at = datetime('now')").run(m.senderJid, u.id);
        return u;
      }
    }
    if (m.senderJid) {
      const link = db.prepare('SELECT user_id FROM wa_identities WHERE jid = ?').get(m.senderJid);
      if (link) return db.prepare('SELECT id, username, full_name, role, team_id, whatsapp FROM users WHERE id = ? AND active = 1').get(link.user_id) || null;
    }
    return null;
  }

  const rememberPost = (referralId, kind) => (id, chat) => {
    db.prepare('INSERT OR IGNORE INTO wa_messages (id, chat, referral_id, kind) VALUES (?, ?, ?, ?)').run(id, chat, referralId, kind);
  };

  // kind 'agent': the assistant's answers, so a reply to one continues the conversation.
  function say(m, text, referralId, kind = 'bot') {
    if (!allow(`chat:${m.chat}`, 20, 60000)) return;
    const remember = referralId || kind === 'agent' ? rememberPost(referralId || null, kind) : undefined;
    whatsapp.reply(m.chat, text, { quotedId: m.id, onSent: remember });
  }

  // The lead a message is about: the post it replies to, or "#123" / "lead 123" in it.
  function leadFor(m, quoted) {
    if (quoted && quoted.referral_id && quoted.kind !== 'agent') return { id: quoted.referral_id, via: 'reply' };
    const k = String(m.text).match(/(?:^|\s)(?:#|lead\s*#?\s*)(\d{1,7})\b/i);
    return k ? { id: Number(k[1]), via: 'number' } : null;
  }

  // Short memory per person and chat, so follow-ups ("and yesterday?", "yes, do it") work.
  const convos = new Map();
  function convo(key) {
    const c = convos.get(key);
    if (c && Date.now() - c.at < 30 * 60000) return c.msgs;
    const msgs = [];
    convos.set(key, { msgs, at: Date.now() });
    if (convos.size > 300) convos.delete(convos.keys().next().value);
    return msgs;
  }

  async function handle(m) {
    const c = cfg();
    const text = String(m.text || '').trim();
    if (!c.enabled || !text) return;
    const inGroup = m.isGroup && m.chat === whatsapp.groupId();
    if (m.isGroup && !inGroup) return; // other groups the alerts number is in
    if (m.ts && Date.now() - m.ts > MAX_AGE_MS) return;
    if (!db.prepare('INSERT OR IGNORE INTO wa_seen (id) VALUES (?)').run(`${m.chat}|${m.id}`).changes) return;
    if (++handled % 500 === 0) db.prepare("DELETE FROM wa_seen WHERE created_at < datetime('now', '-7 days')").run();

    const lang = detectLang(text);
    const me = whatsapp.me() || {};
    const mentionsBot = (m.mentions || []).some((j) => { const d = String(j).split(/[:@]/)[0]; return d && (d === me.number || d === me.lid); });
    const botAsk = /^\s*(bot|asistente|assistant)\b[\s,:]*/i.test(text) || mentionsBot;
    const isHelp = /^\s*(help|ayuda|instructions|instrucciones|\?)\s*[.!]*\s*$/i.test(text) || /^\s*(bot|asistente)\s+(help|ayuda)\s*$/i.test(text);
    const quoted = m.quotedId ? db.prepare('SELECT referral_id, kind FROM wa_messages WHERE id = ?').get(m.quotedId) : null;
    const toAgent = !!(quoted && quoted.kind === 'agent');
    const ref0 = toAgent ? null : leadFor(m, quoted);
    if (!ref0 && !botAsk && !isHelp && !toAgent && inGroup) return; // ordinary chat

    if (isHelp) {
      if (allow(`help:${m.chat}`, 1, 5 * 60000)) whatsapp.reply(m.chat, instructions(c.approvedStatus), { quotedId: m.id });
      return;
    }

    const user = findUser(m);
    if (!user) {
      if (allow(`unknown:${m.senderJid || m.chat}`, 1, 6 * 3600000)) say(m, `${T.unknown.en}\n\n${T.unknown.es}`);
      return;
    }

    let ref = null;
    if (ref0) {
      try { ref = getReferral(ref0.id); } catch { ref = null; }
      if (!ref) { say(m, T.notFound[lang](ref0.id)); return; }
      if (!canViewReferral(user, ref)) { say(m, T.noAccess[lang](ref0.id)); return; }
    }

    // ---- the assistant ----
    if (botAsk || toAgent || (!m.isGroup && !ref)) {
      let question = text.replace(/^\s*(bot|asistente|assistant)\b[\s,:]*/i, '').replace(/@\d{6,}/g, '').trim();
      if (!ai.enabled() || !agent) { say(m, T.noAi[lang]); return; }
      if (!question) question = lang === 'es' ? 'Hola' : 'Hi';
      if (!allow(`agent:${user.id}`, 20, 10 * 60000)) { say(m, T.slow[lang]); return; }
      if (ref) question = `(About lead #${ref.id}) ${question}`;
      const msgs = convo(`${m.chat}|${user.id}`);
      msgs.push({ role: 'user', content: question });
      try {
        const out = await agent.chat(user, msgs, { channel: m.isGroup ? 'group' : 'dm' });
        msgs.push({ role: 'assistant', content: out.text });
        if (msgs.length > 12) msgs.splice(0, msgs.length - 12);
        say(m, out.text, ref && ref.id, 'agent');
      } catch (e) {
        msgs.pop();
        console.error('Assistant failed:', e.message);
        say(m, e.status && e.status < 500 ? e.message : T.aiDown[lang]);
      }
      return;
    }

    // ---- a reply to a lead: note, first-reply assignment, status ----
    const note = ref0.via === 'number' ? text.replace(/(?:^|\s)(?:#|lead\s*#?\s*)\d{1,7}\b/i, '').trim() || text : text;
    let verdict = detectStatus(note, c.approvedStatus);
    // "@owner"/"@dueño", or a WhatsApp @-mention of the rep themselves.
    const owner = db.prepare('SELECT whatsapp FROM users WHERE id = ?').get(ref.created_by);
    const ownerDigits = owner && owner.whatsapp ? digitsOf(owner.whatsapp) : '';
    let notifyOwner = OWNER_TAG.test(note) || (!!ownerDigits && (m.mentions || []).some((j) => digitsOf(String(j).split(/[:@]/)[0]) === ownerDigits));
    let question = '';
    if (ai.enabled()) {
      try {
        const r = await ai.interpretReply({ lead: ref, text: note, senderName: user.full_name, approvedStatus: c.approvedStatus });
        verdict = r.status && r.sure ? { status: r.status } : {};
        if (!r.sure && r.question) question = r.question;
        notifyOwner = notifyOwner || r.notify_owner;
      } catch (e) {
        console.error('AI reading failed, using keywords:', e.message);
      }
    }
    if (verdict.options) question = T.which[lang](verdict.options);

    const changes = [];
    try {
      addComment(user, ref, note, { source: 'whatsapp', notifyOwner });
      if (!ref.assigned_to && seesAll(user)) {
        updateReferral(user, ref.id, { assigned_to: user.id });
        changes.push(`👤 ${user.full_name.split(' ')[0]}`);
      }
      if (verdict.status && verdict.status !== ref.status) {
        if (canManageReferral(user, ref)) {
          updateReferral(user, ref.id, { status: verdict.status });
          changes.push(`*${verdict.status}*`);
        } else {
          say(m, T.noStatus[lang], ref.id);
        }
      }
    } catch (e) {
      say(m, T.failed[lang](e.message), ref.id);
      return;
    }
    logAudit({ user, ip: 'whatsapp' }, 'whatsapp.reply', 'referral', ref.id, `${changes.join(' ') || 'note'}: ${note.slice(0, 200)}`);

    if (changes.length) say(m, `✅ #${ref.id} ${ref.customer_name || ''} · ${changes.join(' · ')}`.replace(/\s+·/g, ' ·'), ref.id);
    else whatsapp.react(m.chat, m.id, notifyOwner ? '📨' : '📝');
    if (question) say(m, question, ref.id);
  }

  whatsapp.onMessage(handle);

  // ---------- admin ----------

  app.post('/api/whatsapp/instructions', wrap((req) => {
    requireRole(req, 'admin');
    if (!whatsapp.groupId()) throw new HttpError(400, 'Pick the dispatch group first.');
    if (whatsapp.status() !== 'connected') throw new HttpError(409, 'WhatsApp isn\'t connected.');
    whatsapp.postToGroup(instructions(cfg().approvedStatus), null, { force: true });
    return { ok: true };
  }));

  return { handle, instructions: () => instructions(cfg().approvedStatus) };
}

module.exports = { mount, detectStatus, detectLang, instructions };
