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
const partnersModule = require('./whatsapp-partners');
const orderPdf = require('./whatsapp-order-pdf');
const waFormat = require('../public/waformat');

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
  let cleaned = t.replace(/\b(not|no|todavia no|aun no|still not|not yet)\s+(yet\s+)?(?:(?:been|is|was|esta|fue)\s+)?(approved|aprobad[oa]|confirmed|confirmad[oa]|passed|order confirmed|order placed|ordered|ordenad[oa]|sold|vendid[oa]|cancel\w*|cancelad[oa])\b/g, ' ');
  cleaned = cleaned.replace(/\b(?:will|going to|should|would|could|if|waiting (?:for|to)|awaiting|pending|cuando|vamos a)(?:\s+\w+){0,4}?\s+(?:on it|working(?: on it)?|in progress|confirmed|confirmad[oa]|approved|aprobad[oa]|ordered|order placed|order confirmed|cancelled|cancelad[oa]|passed|qualified)\b/g,' ');
  const found = new Set();
  if (/\b(dnq|no califica|no califico|not qualif\w*|didn'?t qualify|did not qualify|no paso|denied|denegad[oa]|negad[oa]|rechazad[oa]|declined|no aplica|credit (fail\w*|denied))\b/.test(cleaned)) found.add('DNQ');
  if (/\b(cancel+ed|cancel+ation|cancel|cancelad[oa]|cancelar|not interested|no le interesa|ya no quiere)\b/.test(cleaned)) found.add('Cancelled');
  if (/\b(ordered|order placed|order confirmed|orden confirmada|ordenad[oa]|orden puesta|sold|vendid[oa]|venta (hecha|cerrada|lista)|installed|instalad[oa])\b/.test(cleaned)) found.add('Ordered');
  if (/\b(approved|approve|aprobad[oa]|aprobaron)\b/.test(cleaned)) found.add(approvedStatus);
  if (!found.has('DNQ') && /\b(passed|paso|qualified|califica|calificad[oa])\b/.test(cleaned)) found.add('Passed');
  if (!found.has('Ordered') && /\b(confirmed|confirmad[oa])\b/.test(cleaned) && !/\b(?:appointment|callback|call back|address|phone|email|pricing|price|cita|direccion|telefono)\b/.test(cleaned)) found.add('Passed');
  // Working is an activity stage, not qualification. A reported outcome takes precedence.
  const activity = cleaned.replace(/\b(not|no|still not|not yet|todavia no|aun no)\s+(?:(?:yet|estoy|estamos|esta)\s+)?(?:on it|working(?: on (?:it|this lead|this customer))?|in progress|trabajando|en proceso)\b/g, ' ');
  if (!found.size && (/^\s*working\s*$/.test(activity) || /\b(on it|working on (?:it|this lead|this customer)|in progress|en proceso|trabajando)\b/.test(activity))) found.add('Working');
  if (found.size===1 && /[?¿]/.test(String(text))) return {};
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
    `• Write *on it* / *working* (→ Working), *confirmed* (→ Passed), *approved* (→ ${ap}), *passed*, *DNQ* or *cancelled* in your reply to change its status.`,
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
    `• Escribe *trabajando* (→ Working), *confirmado* (→ Passed), *aprobado* (→ ${ap}), *pasó*, *no califica* o *cancelado* en tu respuesta para cambiar el estado.`,
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
  const { whatsapp, ai, agent, coach, getSettings, getReferral, canViewReferral, canManageReferral, seesAll, updateReferral, addComment, logAudit, requireRole, wrap, HttpError } = deps;

  const partners = partnersModule.mount(app,db,{whatsapp,requireRole,wrap,HttpError,logAudit});

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
      // Do not fall back to a stale identity when WhatsApp supplied a different number.
      return null;
    }
    if (m.senderJid) {
      const link = db.prepare('SELECT user_id FROM wa_identities WHERE jid = ?').get(m.senderJid);
      if (link) return db.prepare("SELECT id, username, full_name, role, team_id, whatsapp FROM users WHERE id = ? AND active = 1 AND whatsapp <> ''").get(link.user_id) || null;
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

  function mentionsOwner(m, ref, note) {
    const owner = db.prepare('SELECT whatsapp FROM users WHERE id = ?').get(ref.created_by);
    const ownerDigits = owner && owner.whatsapp ? digitsOf(owner.whatsapp) : '';
    return OWNER_TAG.test(note) || (!!ownerDigits && (m.mentions || []).some(j => digitsOf(String(j).split(/[:@]/)[0]) === ownerDigits));
  }

  // Short memory per person and chat, so follow-ups ("and yesterday?", "yes, do it") work.
  const convos = new Map();
  const pending = new Map();
  function convo(key) {
    const c = convos.get(key);
    if (c && Date.now() - c.at < 30 * 60000) return c.msgs;
    const msgs = [];
    convos.set(key, { msgs, at: Date.now() });
    if (convos.size > 300) convos.delete(convos.keys().next().value);
    return msgs;
  }

  function quietActor(m, ref) {
    const user=findUser(m);
    if(user) return canViewReferral(user,ref) ? user : null;
    const partner=partners.find(m);
    return partner ? partners.actorFor(partner,m,ref.id,!!ref.quiet_test) : null;
  }
  function testReferral(test) {
    return {...waFormat.QUIET_TEST_LEAD,...JSON.parse(test.document_fields || '{}'),id:test.id,
      created_by:test.created_by,team_id:test.creator_team_id,assigned_to:test.assigned_to,status:test.status,quiet_test:true};
  }
  function comment(m,ref,actor,note) {
    const crm=actor && !partnersModule.isPartner(actor) ? actor : null;
    addComment(crm,ref,note,{source:'whatsapp',notifyOwner:true,allowMentions:!!crm,
      ownerMention:!!crm && mentionsOwner(m,ref,note),
      externalAuthor:actor?.full_name || String(m.name || 'WhatsApp participant').slice(0,100),
      whatsappChat:m.chat,whatsappMessageId:m.id});
  }
  const statusAllowed=(from,to)=>!((from==='Passed' && to==='Working') || (['Ordered','Cancelled','DNQ'].includes(from) && ['Working','Passed'].includes(to)));

  // A PDF is read only for a recognized, permitted account or an explicitly allowed
  // Spectrum number. Its bytes and customer data never go to the conversational AI.
  async function handleDocument(m,test=null) {
    const user=findUser(m), partner=!user && partners.find(m), filename=String(m.document.filename || 'Order.pdf').replace(/[\r\n]/g,' ').slice(0,150);
    const quoted=m.quotedId ? db.prepare('SELECT referral_id,kind FROM wa_messages WHERE id=? AND chat=?').get(m.quotedId,m.chat) : null;
    const target=quoted?.referral_id && quoted.kind!=='agent' ? {id:quoted.referral_id} : user ? leadFor(m,null) : null;
    let ref=test ? testReferral(test) : null;
    if(!test && target) {try{ref=getReferral(target.id);}catch{}}
    const actor=ref ? quietActor(m,ref) : null;
    db.prepare(`INSERT OR IGNORE INTO wa_order_documents(chat,message_id,filename,author,referral_id,test_id)
      VALUES(?,?,?,?,?,?)`).run(m.chat,m.id,filename,actor?.full_name || user?.full_name || String(m.name || 'WhatsApp participant').slice(0,100),
      ref && !test ? ref.id : null,test?.id || null);
    let fields={};
    const finish=(status,detail)=>{
      db.prepare("UPDATE wa_order_documents SET status=?,detail=?,fields=?,updated_at=datetime('now') WHERE chat=? AND message_id=?")
        .run(status,detail.slice(0,500),JSON.stringify(fields),m.chat,m.id);
      return `quiet_pdf_${status}`;
    };
    const capture=(who,note,ordered=false)=>{
      if(!ref)return;
      if(test)whatsapp.quietTests.capture(whatsapp.quietTests.get(test.id),{...m,text:note},who,
        {canViewReferral,canManageReferral,seesAll,detectStatus:()=>ordered?{status:'Ordered'}:{},approvedStatus:cfg().approvedStatus});
      else {comment(m,ref,who,note);rememberPost(ref.id,'lead_reply')(m.id,m.chat);}
    };
    if((ref && (!actor || !canManageReferral(actor,ref))) || (!ref && !user && !partner)) {
      capture(actor,`PDF received: ${filename}${m.text ? '\n'+m.text : ''}\nComment only: this participant is not allowed to update order details.`);
      return finish('comment','Participant cannot update order details. No PDF was downloaded.');
    }
    try {
      const result=await orderPdf.readOrder(m.document);fields=result.fields;
      // Permission, capture and record checks happen again after an asynchronous download.
      if(test ? m.chat!==whatsapp.testGroupId() || getSettings().wa_enabled!=='1' : !whatsapp.quietCaptureEnabled(m.chat))
        return finish('review','Reply capture was turned off while processing this PDF.');
      if(test) {test=whatsapp.quietTests.get(test.id);ref=testReferral(test);}
      else if(ref) {try{ref=getReferral(ref.id);}catch{return finish('review','The linked lead no longer exists.');}}
      else {
        const posted=db.prepare('SELECT DISTINCT referral_id FROM wa_messages WHERE chat=? AND referral_id IS NOT NULL AND kind=\'lead\'').all(m.chat);
        const matches=[];
        for(const row of posted) {
          let candidate;try{candidate=getReferral(row.referral_id);}catch{continue;}
          const who=quietActor(m,candidate);
          if(who && canManageReferral(who,candidate) && orderPdf.identityMatches(fields,candidate))matches.push(candidate);
        }
        if(matches.length!==1)return finish('review',matches.length ? 'Several posted leads match this PDF. Reply directly to the correct lead and resend it.' : 'No unique permitted lead matches this PDF. Reply directly to its lead post and resend it.');
        ref=matches[0];
        db.prepare('UPDATE wa_order_documents SET referral_id=? WHERE chat=? AND message_id=?').run(ref.id,m.chat,m.id);
      }
      const current=quietActor(m,ref);
      if(!current || !canManageReferral(current,ref))return finish('review','Sender permission was removed or does not cover this lead.');
      const conflict=result.issue || orderPdf.orderPatch(fields,ref).issue;
      const duplicate=!test && fields.account_number && db.prepare("SELECT id FROM referrals WHERE replace(replace(account_number,'-',''),' ','')=? AND id<>?").get(fields.account_number,ref.id);
      if(conflict || duplicate) {
        const reason=conflict || 'This account number is already linked to another CRM lead.';
        capture(current,`PDF needs review: ${filename}\n${reason}`);
        return finish('review',reason);
      }
      const {body}=orderPdf.orderPatch(fields,ref);
      if(test) {
        db.prepare('UPDATE wa_quiet_tests SET document_fields=? WHERE id=?').run(JSON.stringify({...JSON.parse(test.document_fields || '{}'),...fields}),test.id);
      } else updateReferral(current,ref.id,body);
      finish('applied',test ? 'Order details saved on the isolated test lead only.' : 'Lead marked Ordered and order details saved.');
      const summary=['PDF processed: '+filename,...Object.entries(fields).filter(([,v])=>v!=='' && v!=null).map(([k,v])=>`${k.replace(/_/g,' ')}: ${v}`),'Status: Ordered'].join('\n');
      try{capture(current,summary,true);}catch{console.error('Order PDF comment could not be saved.');}
      logAudit({user:current,ip:'whatsapp'},'whatsapp.order_pdf',test?'whatsapp_test':'referral',ref.id,`${filename} · ${m.chat} · Ordered`);
      return 'quiet_pdf_applied';
    } catch(error) {
      const safe=error.status===409 ? 'Order customer details match another existing record. Review before applying this PDF.' : /^(?:PDF |Password-protected PDF|The attachment|No readable)/.test(error.message) ? error.message.slice(0,250) : 'PDF could not be processed. Review it in the CRM.';
      // Failure is visible in Settings, and as an attributed comment when linked.
      try{capture(ref ? quietActor(m,ref) : null,`PDF needs review: ${filename}\n${safe}`);}catch{}
      return finish('review',safe);
    }
  }

  // Quiet messages always remain silent, including failures and ambiguous statuses.
  async function handleQuiet(m) {
    if(m.document)return handleDocument(m);
    const quoted=m.quotedId ? db.prepare('SELECT referral_id,kind FROM wa_messages WHERE id=? AND chat=?').get(m.quotedId,m.chat) : null;
    const user=findUser(m), linked=quoted && quoted.referral_id && quoted.kind!=='agent';
    const target=linked ? {id:quoted.referral_id,via:'reply'} : user ? leadFor(m,null) : null;
    if(!target)return 'quiet_ignored';
    let ref;try{ref=getReferral(target.id);}catch{return 'lead_not_found';}
    const actor=quietActor(m,ref);
    if(!actor && !linked)return 'no_access';
    const note=target.via==='number' ? String(m.text).replace(/(?:^|\s)(?:#|lead\s*#?\s*)\d{1,7}\b/i,'').trim() || m.text : m.text;
    try {
      comment(m,ref,actor,note);
      if(actor) {
        if(!ref.assigned_to && seesAll(actor))updateReferral(actor,ref.id,{assigned_to:actor.id});
        const verdict=detectStatus(note,cfg().approvedStatus);
        if(verdict.status && verdict.status!==ref.status && statusAllowed(ref.status,verdict.status) && canManageReferral(actor,ref))
          updateReferral(actor,ref.id,{status:verdict.status});
      }
      rememberPost(ref.id,'lead_reply')(m.id,m.chat);
      logAudit({user:actor,ip:'whatsapp'},'whatsapp.quiet_reply','referral',ref.id,
        `${actor?.full_name || `External: ${m.name || 'WhatsApp participant'}`} · ${m.chat} · ${String(note).slice(0,160)}`);
      return actor ? 'quiet_lead_updated' : 'quiet_external_comment';
    } catch(error) {console.error('Quiet WhatsApp reply failed:',error.message);return 'quiet_update_failed';}
  }

  async function handle(m) {
    const c = cfg();
    const text = String(m.text || '').trim();
    const quiet = m.isGroup && whatsapp.isQuietGroup(m.chat);
    const test = m.isGroup && m.chat===whatsapp.testGroupId() ? whatsapp.quietTests.forReply(m.chat,m.quotedId) : null;
    if (test ? getSettings().wa_enabled!=='1' : quiet ? !whatsapp.quietCaptureEnabled(m.chat) : !c.enabled) return quiet ? 'quiet_capture_off' : 'two_way_off';
    if (!text && !m.document) return 'empty';
    if(m.document && !quiet && !test)return 'unsupported_document';
    const inGroup = m.isGroup && m.chat === whatsapp.groupId();
    if (m.isGroup && !inGroup && !quiet) return 'other_group';
    if (m.ts && Date.now() - m.ts > MAX_AGE_MS) return 'old_message';
    if (!db.prepare('INSERT OR IGNORE INTO wa_seen (id) VALUES (?)').run(`${m.chat}|${m.id}`).changes) return 'duplicate';
    if (++handled % 500 === 0) db.prepare("DELETE FROM wa_seen WHERE created_at < datetime('now', '-7 days')").run();
    if (test) {
      if(m.document)return handleDocument({...m,text},test);
      whatsapp.quietTests.capture(test,{...m,text},quietActor(m,testReferral(test)),{canViewReferral,canManageReferral,seesAll,detectStatus,approvedStatus:c.approvedStatus});
      return 'quiet_test_reply';
    }
    if (quiet) return handleQuiet({ ...m,text });

    const lang = detectLang(text);
    const me = whatsapp.me() || {};
    const mentionsBot = (m.mentions || []).some((j) => { const d = String(j).split(/[:@]/)[0]; return d && (d === me.number || d === me.lid); });
    const botAsk = /^\s*(bot|asistente|assistant)\b[\s,:]*/i.test(text) || mentionsBot;
    const isHelp = /^\s*(help|ayuda|instructions|instrucciones|\?)\s*[.!]*\s*$/i.test(text) || /^\s*(bot|asistente)\s+(help|ayuda)\s*$/i.test(text);
    const quoted = m.quotedId ? db.prepare('SELECT referral_id, kind FROM wa_messages WHERE id = ? AND chat = ?').get(m.quotedId, m.chat) : null;
    const toAgent = !!(quoted && quoted.kind === 'agent');
    const ref0 = toAgent ? null : leadFor(m, quoted);
    if (!ref0 && !botAsk && !isHelp && !toAgent && inGroup) return 'ordinary_chat';

    if (isHelp) {
      if (allow(`help:${m.chat}`, 1, 5 * 60000)) whatsapp.reply(m.chat, instructions(c.approvedStatus), { quotedId: m.id });
      return 'help';
    }

    const user = findUser(m);
    if (!user) {
      if (allow(`unknown:${m.senderJid || m.chat}`, 1, 6 * 3600000)) say(m, `${T.unknown.en}\n\n${T.unknown.es}`);
      return 'unknown_sender';
    }

    // Add private coaching for pricing/support; keep the existing operations tools
    // for lead lookup, updates, statistics, reminders and ordinary assistant chat.
    if (!m.isGroup && ['rep','manager'].includes(user.role) && coach && coach.enabled() && (botAsk || !ref0) && coach.shouldHandle(text.replace(/^\s*(bot|asistente|assistant)\b[\s,:]*/i,''))) {
      if (!allow(`coach:${user.id}`,20,10*60000)) { say(m,T.slow[lang]); return 'rate_limited'; }
      const answer=await coach.handle(user,text.replace(/^\s*(bot|asistente|assistant)\b[\s,:]*/i,''),{chat:m.chat,messageId:m.id});
      say(m,answer,null,'agent');
      return 'seller_coach';
    }

    let ref = null;
    if (ref0) {
      try { ref = getReferral(ref0.id); } catch { ref = null; }
      if (!ref) { say(m, T.notFound[lang](ref0.id)); return 'lead_not_found'; }
      if (!canViewReferral(user, ref)) { say(m, T.noAccess[lang](ref0.id)); return 'no_access'; }
    }

    // ---- the assistant ----
    if (botAsk || toAgent || (!m.isGroup && !ref)) {
      let question = text.replace(/^\s*(bot|asistente|assistant)\b[\s,:]*/i, '').replace(/@\d{6,}/g, '').trim();
      if (!ai.enabled() || !agent) { say(m, T.noAi[lang]); return 'assistant_off'; }
      if (!question) question = lang === 'es' ? 'Hola' : 'Hi';
      if (!allow(`agent:${user.id}`, 20, 10 * 60000)) { say(m, T.slow[lang]); return 'rate_limited'; }
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
        return 'assistant_failed';
      }
      return 'assistant';
    }

    // ---- a reply to a lead: note, first-reply assignment, status ----
    const note = ref0.via === 'number' ? text.replace(/(?:^|\s)(?:#|lead\s*#?\s*)\d{1,7}\b/i, '').trim() || text : text;
    let verdict = detectStatus(note, c.approvedStatus);
    // "@owner"/"@dueño", or a WhatsApp @-mention of the rep themselves.
    const ownerMention = mentionsOwner(m, ref, note);
    let notifyOwner = ownerMention;
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
      addComment(user, ref, note, { source: 'whatsapp', notifyOwner, ownerMention });
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
      return 'update_failed';
    }
    logAudit({ user, ip: 'whatsapp' }, 'whatsapp.reply', 'referral', ref.id, `${changes.join(' ') || 'note'}: ${note.slice(0, 200)}`);

    if (changes.length) say(m, `✅ #${ref.id} ${ref.customer_name || ''} · ${changes.join(' · ')}`.replace(/\s+·/g, ' ·'), ref.id);
    else whatsapp.react(m.chat, m.id, notifyOwner ? '📨' : '📝');
    if (question) say(m, question, ref.id);
    return 'lead_updated';
  }

  // A resend may arrive while the first AI request is still running. Keep each person's
  // conversation ordered instead of mutating the same history in parallel.
  function receive(m) {
    const key = m.isGroup ? m.chat : `${m.chat}|${m.senderJid || m.senderPhone || ''}`;
    const next = (pending.get(key) || Promise.resolve()).then(async () => {
      if(!m.senderPhone && m.resolveSenderPhone && m.isGroup &&
        [whatsapp.groupId(),whatsapp.quietGroupId(),whatsapp.testGroupId()].includes(m.chat)) {
        const phone=await m.resolveSenderPhone().catch(()=>null);
        if(phone)m={...m,senderPhone:phone};
      }
      return handle(m);
    });
    const settled = next.catch(() => {});
    pending.set(key, settled);
    settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
    return next;
  }
  whatsapp.onMessage(receive);

  // ---------- admin ----------

  app.post('/api/whatsapp/quiet-test/simulate',wrap(req=>{
    const user=requireRole(req,'admin'),b=req.body || {},text=String(b.text || '').trim();
    if (!text || text.length>2000) throw new HttpError(400,'Enter a reply up to 2,000 characters.');
    if (!['external','crm','partner'].includes(b.actor)) throw new HttpError(400,'Choose an external participant, trusted Spectrum participant, or your CRM account.');
    const test=whatsapp.quietTests.latest(whatsapp.testGroupId()) || {created_by:user.id,creator_team_id:user.team_id,status:'New',assigned_to:null};
    const partner=b.actor==='partner' ? db.prepare('SELECT * FROM wa_group_partners WHERE group_id=? AND enabled=1 ORDER BY id LIMIT 1').get(whatsapp.testGroupId()) : null;
    if(b.actor==='partner' && !partner)throw new HttpError(400,'Allow a Spectrum participant for the test group first.');
    const actor=b.actor==='crm' ? user : partner ? partners.actorFor(partner,{chat:whatsapp.testGroupId(),id:'simulation'},test.id,true) : null;
    const result=whatsapp.quietTests.assess(test,actor,text,
      {canViewReferral,canManageReferral,seesAll,detectStatus,approvedStatus:cfg().approvedStatus});
    return {...result,comment:text,simulation:true};
  }));

  app.post('/api/whatsapp/instructions', wrap((req) => {
    requireRole(req, 'admin');
    if (!whatsapp.groupId()) throw new HttpError(400, 'Pick the dispatch group first.');
    if (whatsapp.isQuietGroup(whatsapp.groupId())) throw new HttpError(409, 'Quiet groups accept lead posts only. Instructions are available in the app.');
    if (whatsapp.status() !== 'connected') throw new HttpError(409, 'WhatsApp isn\'t connected.');
    whatsapp.postToGroup(instructions(cfg().approvedStatus), null, { force: true });
    return { ok: true };
  }));

  return { handle, instructions: () => instructions(cfg().approvedStatus) };
}

module.exports = { mount, detectStatus, detectLang, instructions };
