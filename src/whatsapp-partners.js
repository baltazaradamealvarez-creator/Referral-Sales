'use strict';

// Quiet-group principals use the configured group policy or a saved number.
// They are scoped to one posted lead and do not grant general CRM access.
const scopes = new WeakMap();
function actorFor(db, partner, message, id, test = false) {
  const actor = Object.freeze({ id: null, role: 'whatsapp_partner', full_name: partner.name,
    username: `Spectrum: ${partner.name}`, whatsapp_chat: message.chat, whatsapp_message_id: message.id });
  scopes.set(actor, { db, partnerId: partner.id, group: message.chat, id, test });
  return actor;
}
const isPartner = actor => !!actor && scopes.has(actor);
function canAccess(actor, ref) {
  const scope = scopes.get(actor);
  if (!scope || scope.id !== ref.id || scope.test !== !!ref.quiet_test) return false;
  if (scope.everyone) {
    if (!scope.everyone(scope.group)) return false;
    if (scope.simulation) return true;
    return scope.test
      ? !!scope.db.prepare("SELECT id FROM wa_quiet_tests WHERE id=? AND group_id=? AND message_id<>''").get(ref.id,scope.group)
      : !!scope.db.prepare("SELECT id FROM wa_messages WHERE referral_id=? AND chat=? AND kind='lead' LIMIT 1").get(ref.id,scope.group);
  }
  return !!scope.db.prepare('SELECT id FROM wa_group_partners WHERE id=? AND group_id=? AND enabled=1').get(scope.partnerId, scope.group);
}

function mount(app, db, { whatsapp, requireRole, wrap, HttpError, logAudit }) {
  const { digitsOf } = require('./whatsapp');
  db.prepare("UPDATE wa_order_documents SET status='review',detail='Processing was interrupted by a restart. Reply to the lead and resend this PDF.',updated_at=datetime('now') WHERE status='processing'").run();
  const groups = () => [...new Set([whatsapp.groupId(), whatsapp.quietGroupId(), whatsapp.testGroupId()]
    .filter(id => id && whatsapp.isQuietGroup(id)))];
  const allowsEveryone = chat => whatsapp.quietAccess()==='everyone' && groups().includes(chat);
  function groupActor(message, ref, user=null, simulation=false) {
    if (!allowsEveryone(message.chat) || (!simulation && (!message.isGroup || !message.senderJid))) return null;
    const name=String(user?.full_name || message.name || 'Spectrum participant').trim().slice(0,100) || 'Spectrum participant';
    const actor=Object.freeze({id:user?.id || null,role:'whatsapp_partner',full_name:name,
      username:user?.username || `Spectrum: ${name}`,whatsapp_chat:message.chat,whatsapp_message_id:message.id});
    scopes.set(actor,{db,group:message.chat,id:ref.id,test:!!ref.quiet_test,everyone:allowsEveryone,simulation});
    return canAccess(actor,ref) ? actor : null;
  }
  function find(message) {
    if (!groups().includes(message.chat)) return null;
    if (message.senderPhone) {
      const partner = db.prepare('SELECT * FROM wa_group_partners WHERE group_id=? AND phone=? AND enabled=1')
        .get(message.chat, digitsOf(message.senderPhone));
      if (partner && message.senderJid) db.prepare(`INSERT INTO wa_partner_identities(group_id,jid,partner_id) VALUES(?,?,?)
        ON CONFLICT(group_id,jid) DO UPDATE SET partner_id=excluded.partner_id`).run(message.chat,message.senderJid,partner.id);
      return partner || null; // supplied number wins over an older privacy-ID association
    }
    return db.prepare(`SELECT p.* FROM wa_partner_identities i JOIN wa_group_partners p ON p.id=i.partner_id
      WHERE i.group_id=? AND i.jid=? AND p.group_id=i.group_id AND p.enabled=1`).get(message.chat,message.senderJid || '') || null;
  }
  app.get('/api/whatsapp/partners', wrap(req => {
    requireRole(req,'admin');
    return { access:whatsapp.quietAccess(),groups: groups(), participants: db.prepare('SELECT id,group_id,name,phone,enabled FROM wa_group_partners ORDER BY name,id').all() };
  }));
  app.post('/api/whatsapp/partners', wrap(req => {
    const user=requireRole(req,'admin'), body=req.body || {}, group=String(body.group_id || ''),
      name=String(body.name || '').trim().slice(0,100), phone=digitsOf(body.phone);
    if (!groups().includes(group)) throw new HttpError(400,'Choose a configured quiet or test group first.');
    if (!name || !/^\d{10,15}$/.test(phone)) throw new HttpError(400,'Enter a name and WhatsApp number with country code.');
    db.prepare(`INSERT INTO wa_group_partners(group_id,name,phone,authorized_by) VALUES(?,?,?,?)
      ON CONFLICT(group_id,phone) DO UPDATE SET name=excluded.name,enabled=1,authorized_by=excluded.authorized_by,updated_at=datetime('now')`).run(group,name,phone,user.id);
    logAudit(req,'whatsapp.partner.allow','whatsapp',null,`${name} · ${group}`);
    return {ok:true};
  }));
  app.delete('/api/whatsapp/partners/:id', wrap(req => {
    requireRole(req,'admin');
    db.prepare("UPDATE wa_group_partners SET enabled=0,updated_at=datetime('now') WHERE id=?").run(req.params.id);
    db.prepare('DELETE FROM wa_partner_identities WHERE partner_id=?').run(req.params.id);
    logAudit(req,'whatsapp.partner.revoke','whatsapp',null,`Participant ${req.params.id}`);
    return {ok:true};
  }));
  app.get('/api/whatsapp/documents', wrap(req => {
    requireRole(req,'admin');
    return db.prepare(`SELECT d.*,r.customer_name FROM wa_order_documents d LEFT JOIN referrals r ON r.id=d.referral_id
      ORDER BY d.id DESC LIMIT 30`).all().map(row => ({...row, fields:JSON.parse(row.fields || '{}')}));
  }));
  return { find, groupActor, allowsEveryone, actorFor:(partner,message,id,test=false)=>actorFor(db,partner,message,id,test) };
}

module.exports = { mount, isPartner, canAccess };
