'use strict';

const { digitsOf } = require('./whatsapp');
const { containsComp, cleanKnowledge } = require('./seller-policy');

const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const isSpanish = (text) => /[¿¡]|\b(hola|precio|precios|cuanto|cuánto|necesito|ayuda|puedo|gracias)\b/i.test(String(text)) && !/\b(the|what|how|please|need)\b/i.test(String(text));
const acknowledgement = (es) => es ? 'Ya envié tu pregunta al responsable del equipo para revisión. Te responderemos cuando apruebe la respuesta. Mientras tanto, puedo ayudarte a ingresar tus leads.' : 'I’ve sent your question to the team lead for review. We’ll follow up after they approve the response. In the meantime, I can help you enter your leads.';
const fallbackDraft = (es) => es ? 'Gracias por preguntar. El responsable del equipo revisará los detalles contigo para darte una respuesta correcta.' : 'Thanks for asking. The team lead will review the details with you so you get an accurate answer.';

function mount(app, db, { ai, whatsapp, getSettings, speedConfig, notify, logAudit, requireRole, wrap, HttpError }) {
  const setSetting = (key, value) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  const contact = (id) => db.prepare('SELECT * FROM coach_contacts WHERE user_id = ?').get(id);
  const ensureContact = (id) => db.prepare('INSERT OR IGNORE INTO coach_contacts(user_id) VALUES (?)').run(id);
  const cfg = () => {
    const s = getSettings();
    return { enabled: s.coach_enabled === '1', time: s.coach_time || '11:00', days: Number(s.coach_days) || 3,
      reviewer_id: Number(s.coach_reviewer_id) || null, knowledge: s.coach_knowledge || '' };
  };
  const reviewer = () => db.prepare("SELECT id,username FROM users WHERE id = ? AND role='admin' AND active=1").get(cfg().reviewer_id);
  const seller = (id) => db.prepare("SELECT id,full_name,role,whatsapp,whatsapp_alerts,active FROM users WHERE id=? AND role='rep'").get(id);
  const pending = (id) => db.prepare("SELECT id FROM coach_drafts WHERE seller_id=? AND status IN ('pending','queued','failed') LIMIT 1").get(id);
  const local = (now) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: speedConfig().tz, hourCycle:'h23', weekday:'short',hour:'numeric',minute:'numeric' }).formatToParts(new Date(now)).map((x) => [x.type,x.value]));
  const working = (now) => { const p = local(now); const h = +p.hour + +p.minute/60; const hours = speedConfig().hours; return !['Sat','Sun'].includes(p.weekday) && h >= hours[0] && h < hours[1]; };
  const conversations = new Map();

  // The queue does not survive restart. Never silently label an uncertain send as delivered.
  db.prepare("UPDATE coach_drafts SET status='failed', error='Server restarted before delivery could be confirmed. Check WhatsApp before retrying.' WHERE status='queued'").run();

  function eligibility(u, now, manual = false) {
    if (!u || !u.active || u.role !== 'rep') return 'Not an active seller';
    if (!u.whatsapp_alerts || !u.whatsapp || digitsOf(u.whatsapp).length < 11) return 'WhatsApp alerts are off or no number is saved';
    if (whatsapp.me() && digitsOf(whatsapp.me().number) === digitsOf(u.whatsapp)) return 'Seller uses the bot’s own linked number';
    const c = contact(u.id);
    if (c && c.opted_out) return 'Seller stopped coaching';
    if (pending(u.id)) return 'Waiting for owner review or delivery';
    if (c && c.last_checkin_at && (!manual || !c.last_error) && Date.parse(c.last_checkin_at.replace(' ','T')+'Z') > now - cfg().days*86400000) return 'Within the check-in cooldown';
    if (!manual && db.prepare('SELECT 1 FROM referrals WHERE created_by=? AND created_at >= ? LIMIT 1').get(u.id, sqlTime(now - cfg().days*86400000))) return 'Seller has entered a lead recently';
    return '';
  }

  function checkin(u) {
    return 'Hi / Hola! 👋 I’m the E&O sales AI assistant / Soy el asistente de ventas de E&O.\n\n'
      + 'Have any customer leads ready? Enter them in the app so dispatch can help. Need help with product pricing, choosing a package, or entering a lead? We’re here to help.\n\n'
      + '¿Tienes leads listos? Ingrésalos en la app para que dispatch te ayude. ¿Necesitas ayuda con precios, paquetes o ingresar un lead? Estamos para ayudarte.\n\n'
      + 'Reply STOP to stop these check-ins / Responde ALTO para detener estos mensajes.';
  }

  function sendCheckin(u, now, manual = false) {
    const reason = eligibility(u, now, manual);
    if (reason) throw new HttpError(409, reason);
    if (!working(now)) throw new HttpError(409, 'Check-ins are sent during weekday business hours.');
    if (!cfg().enabled || !reviewer()) throw new HttpError(409, 'Enable coaching and choose an active admin reviewer first.');
    if (getSettings().wa_two_way==='0') throw new HttpError(409,'Turn on two-way WhatsApp replies so sellers can respond.');
    if (!ai.enabled() || !whatsapp || whatsapp.status() !== 'connected') throw new HttpError(409, 'The assistant and WhatsApp must both be connected.');
    ensureContact(u.id);
    // Reserve before enqueueing to prevent scheduler/manual sends racing each other.
    db.prepare("UPDATE coach_contacts SET last_checkin_at=?,last_error='' WHERE user_id=?").run(sqlTime(now),u.id);
    const accepted = whatsapp.sendToUser(u, checkin(u), {
      onSent: () => db.prepare('UPDATE coach_contacts SET last_sent_at=? WHERE user_id=?').run(sqlTime(Date.now()),u.id),
      onFailed: (error) => db.prepare('UPDATE coach_contacts SET last_error=? WHERE user_id=?').run(String(error).slice(0,500),u.id),
    });
    if (!accepted) { db.prepare('UPDATE coach_contacts SET last_checkin_at=NULL WHERE user_id=?').run(u.id); throw new HttpError(409,'WhatsApp did not accept the check-in into its queue.'); }
    return { queued: true };
  }

  function tick(now = Date.now()) {
    const c = cfg();
    if (!c.enabled || !reviewer() || !ai.enabled() || !whatsapp || whatsapp.status() !== 'connected' || getSettings().wa_two_way==='0' || !working(now)) return [];
    const p = local(now); const [h,m] = c.time.split(':').map(Number); const late = +p.hour*60 + +p.minute - (h*60+m);
    if (late < 0 || late > 120) return [];
    const queued = [];
    for (const u of db.prepare("SELECT id,full_name,role,active,whatsapp,whatsapp_alerts FROM users WHERE active=1 AND role='rep' AND whatsapp_alerts=1").all()) {
      if (queued.length >= 20) break;
      if (eligibility(u,now)) continue;
      sendCheckin(u,now);
      logAudit({ user: reviewer(), ip:'seller-coach' },'coach.checkin','user',u.id,'Automatic check-in queued');
      queued.push(u.id);
    }
    return queued;
  }

  function review(u, question, text, reason, chat, messageId) {
    const owner = reviewer();
    if (!owner) throw new HttpError(409,'No active coach reviewer is configured.');
    const draft = containsComp(text) ? fallbackDraft(isSpanish(question)) : String(text || fallbackDraft(isSpanish(question))).slice(0,2000);
    const r = db.prepare('INSERT OR IGNORE INTO coach_drafts(seller_id,reviewer_id,question,draft,reason,chat,message_id) VALUES (?,?,?,?,?,?,?)')
      .run(u.id,owner.id,String(question).slice(0,2000),draft,String(reason).slice(0,500),chat||'',messageId||'');
    if (r.changes) {
      notify(owner.id,null,`📝 Seller reply needs your approval: ${u.full_name}. Open Admin → Settings → Seller coach.`);
      logAudit({ user:u, ip:'seller-coach' },'coach.review','coach_draft',Number(r.lastInsertRowid),'Seller question routed for owner approval');
    }
    return acknowledgement(isSpanish(question));
  }

  async function handle(u, text, { chat='', messageId='' } = {}) {
    ensureContact(u.id);
    const stop = /^(stop|alto|parar|unsubscribe|no mas|no más|baja)[.!\s]*$/i.test(text.trim());
    if (stop) { db.prepare('UPDATE coach_contacts SET opted_out=1 WHERE user_id=?').run(u.id); return isSpanish(text)||/^alto/i.test(text) ? 'Listo. No recibirás más mensajes de coaching. Tus otras alertas no cambian.' : 'Done. You won’t receive more coaching check-ins or replies. Your other alerts are unchanged.'; }
    if (/^(start|reanudar)[.!\s]*$/i.test(text.trim())) { db.prepare('UPDATE coach_contacts SET opted_out=0 WHERE user_id=?').run(u.id); return 'Coaching is back on / El coaching está activo otra vez.'; }
    if (contact(u.id).opted_out) return 'Coaching is paused. Reply START to resume / Responde REANUDAR para activar el coaching.';
    if (containsComp(text)) return review(u,text,fallbackDraft(isSpanish(text)),'Restricted topic: direct owner help required',chat,messageId);
    if (!ai.enabled() || typeof ai.coachReply !== 'function') return review(u,text,fallbackDraft(isSpanish(text)),'AI unavailable; human answer needed',chat,messageId);
    const context = conversations.get(u.id) || [];
    let out;
    try {
      out = await ai.coachReply({ question:text,knowledge:cleanKnowledge(cfg().knowledge),context });
      if (!out || typeof out !== 'object') throw new Error('Invalid coaching response');
    }
    catch { return review(u,text,fallbackDraft(isSpanish(text)),'AI could not produce a reliable answer',chat,messageId); }
    const reply = String(out.reply || '').trim();
    const prices = reply.match(/(?:\$\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*(?:dollars?|pesos?|USD|MXN))/gi) || [];
    const unknownPrice = prices.some((price) => !cfg().knowledge.includes(price));
    if (out.action !== 'answer' || !reply || reply.length > 2000 || containsComp(reply) || unknownPrice) {
      return review(u,text,out.draft || reply,containsComp(reply) ? 'Restricted content blocked' : unknownPrice ? 'Product price needs verification' : out.reason || 'Owner review requested',chat,messageId);
    }
    context.push({role:'user',content:text.slice(0,2000)},{role:'assistant',content:reply});
    conversations.set(u.id,context.slice(-8));
    if (conversations.size > 300) conversations.delete(conversations.keys().next().value);
    return reply;
  }

  function settingsView() {
    return { ...cfg(), connected: whatsapp.status()==='connected', ai:ai.enabled(), tz:speedConfig().tz,
      reviewers:db.prepare("SELECT id,full_name FROM users WHERE active=1 AND role='admin' ORDER BY full_name").all() };
  }
  app.get('/api/coach/settings',wrap((req) => {requireRole(req,'admin');return settingsView();}));
  app.patch('/api/coach/settings',wrap((req) => {
    const actor=requireRole(req,'admin'); const b=req.body||{}; const c=cfg();
    const ownerId=b.reviewer_id !== undefined ? Number(b.reviewer_id) : c.reviewer_id || actor.id;
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1").get(ownerId)) throw new HttpError(400,'Choose an active admin reviewer.');
    if (b.time!==undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) throw new HttpError(400,'Use a time such as 11:00.');
    if (b.days!==undefined && (!Number.isInteger(Number(b.days)) || Number(b.days)<1 || Number(b.days)>30)) throw new HttpError(400,'Check-in interval must be 1–30 days.');
    if (b.knowledge!==undefined && (String(b.knowledge).length>6000 || containsComp(b.knowledge))) throw new HttpError(400,'Seller knowledge must be under 6,000 characters and exclude compensation.');
    setSetting('coach_reviewer_id',String(ownerId));
    for (const [key,val] of Object.entries(b)) if (['time','days','knowledge'].includes(key)) setSetting('coach_'+key,String(val).trim());
    if (b.enabled!==undefined) setSetting('coach_enabled',b.enabled?'1':'0');
    logAudit(req,'coach.settings','settings','','Seller coaching settings saved');return settingsView();
  }));
  app.get('/api/coach/sellers',wrap((req) => {
    requireRole(req,'admin');const now=Date.now();
    return db.prepare("SELECT u.id,u.full_name,u.role,u.active,u.whatsapp,u.whatsapp_alerts,c.opted_out,c.last_sent_at,c.last_error FROM users u LEFT JOIN coach_contacts c ON c.user_id=u.id WHERE u.role='rep' AND u.active=1 ORDER BY u.full_name").all()
      .map((u)=>({id:u.id,full_name:u.full_name,opted_out:!!u.opted_out,last_sent_at:u.last_sent_at,last_error:u.last_error,blocked:eligibility(u,now,true)}));
  }));
  app.get('/api/coach/sellers/:id/preview',wrap((req) => {requireRole(req,'admin');const u=seller(Number(req.params.id));if(!u)throw new HttpError(404,'Seller not found.');return {text:checkin(u),blocked:eligibility(u,Date.now(),true)};}));
  app.post('/api/coach/sellers/:id/checkin',wrap((req) => {
    requireRole(req,'admin');const u=seller(Number(req.params.id));if(!u)throw new HttpError(404,'Seller not found.');const out=sendCheckin(u,Date.now(),true);logAudit(req,'coach.checkin','user',u.id,'Manual check-in queued');return out;
  }));
  app.get('/api/coach/drafts',wrap((req)=>{
    requireRole(req,'admin');return db.prepare("SELECT d.*,u.full_name AS seller_name,r.full_name AS reviewer_name FROM coach_drafts d JOIN users u ON u.id=d.seller_id LEFT JOIN users r ON r.id=d.reviewer_id ORDER BY CASE WHEN d.status IN ('pending','failed') THEN 0 ELSE 1 END,d.id DESC LIMIT 100").all();
  }));
  app.post('/api/coach/drafts/:id/review',wrap((req)=>{
    const actor=requireRole(req,'admin');const d=db.prepare('SELECT * FROM coach_drafts WHERE id=?').get(Number(req.params.id));
    if(!d)throw new HttpError(404,'Draft not found.');
    if(actor.id!==cfg().reviewer_id)throw new HttpError(403,'Only the configured coach reviewer can approve or reject drafts.');
    if(!['pending','failed'].includes(d.status))throw new HttpError(409,'This draft has already been reviewed or queued.');
    const b=req.body||{};
    if(b.action==='reject'){db.prepare("UPDATE coach_drafts SET status='rejected',approved_by=?,reviewed_at=datetime('now') WHERE id=?").run(actor.id,d.id);logAudit(req,'coach.reject','coach_draft',d.id,'Draft rejected');return {status:'rejected'};}
    if(b.action!=='approve')throw new HttpError(400,'Choose approve or reject.');
    const text=String(b.text===undefined?d.draft:b.text).trim();
    if(!text || text.length>2000 || containsComp(text))throw new HttpError(400,'Reply must be 1–2,000 characters and must not discuss compensation.');
    const u=seller(d.seller_id);
    if(!u||!u.active||!u.whatsapp_alerts||contact(u.id)?.opted_out)throw new HttpError(409,'Seller is inactive, has alerts off, or stopped coaching.');
    if(!cfg().enabled||whatsapp.status()!=='connected')throw new HttpError(409,'Enable coaching and connect WhatsApp first.');
    db.prepare("UPDATE coach_drafts SET status='queued',draft=?,approved_by=?,reviewed_at=datetime('now'),error='' WHERE id=?").run(text,actor.id,d.id);
    const accepted=whatsapp.sendToUser(u,text,{
      onSent:()=>{db.prepare("UPDATE coach_drafts SET status='sent',sent_at=datetime('now') WHERE id=?").run(d.id);logAudit(req,'coach.sent','coach_draft',d.id,'Approved reply accepted by WhatsApp');},
      onFailed:(error)=>db.prepare("UPDATE coach_drafts SET status='failed',error=? WHERE id=?").run(String(error).slice(0,500),d.id),
    });
    if(!accepted){db.prepare("UPDATE coach_drafts SET status='failed',error='WhatsApp queue unavailable' WHERE id=?").run(d.id);throw new HttpError(409,'WhatsApp queue unavailable.');}
    logAudit(req,'coach.approve','coach_draft',d.id,'Approved seller reply queued');return {status:'queued'};
  }));
  // Extend pricing/support conversations without taking over the operations assistant.
  const shouldHandle = (text) => {
    if (containsComp(text) || /^(stop|alto|parar|unsubscribe|no m[aá]s|baja|start|reanudar)[.!\s]*$/i.test(text.trim())) return true;
    if (/\b(remind|reminder[s]?|recordatorio[s]?|recu[eé]rdame|find|show|list|update|assign|add (?:a )?note|agrega(?:r)? (?:una )?nota|actualiza(?:r)?|asigna(?:r)?)\b/i.test(text)) return false;
    return /\b(pric(?:e|es|ing)|precio[s]?|cost[s]?|costo[s]?|package[s]?|paquete[s]?|offer[s]?|oferta[s]?|promo|discount[s]?|descuento[s]?|internet|billing|guarantee|exception|excepci[oó]n|eligibility|eligibilidad)\b/i.test(text);
  };
  return { enabled:()=>cfg().enabled, shouldHandle, handle, tick };
}

module.exports={mount};
