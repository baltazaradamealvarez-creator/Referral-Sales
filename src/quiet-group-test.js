'use strict';

const waFormat = require('../public/waformat');
const { tx } = require('./db');

function createStore(db) {
  const get = id => db.prepare(`SELECT t.*, u.team_id AS creator_team_id FROM wa_quiet_tests t
    JOIN users u ON u.id=t.created_by WHERE t.id=?`).get(id);
  const latest = group => db.prepare('SELECT id FROM wa_quiet_tests WHERE group_id=? ORDER BY id DESC LIMIT 1').get(group);
  function view(test) {
    if (!test) return null;
    const replies = db.prepare(`SELECT r.body,r.created_at,r.from_status,r.to_status,
      COALESCE(u.full_name,NULLIF(r.external_author,''),'WhatsApp participant') AS author,
      CASE WHEN r.user_id IS NULL THEN 'external' ELSE 'crm' END AS actor
      FROM wa_quiet_test_replies r LEFT JOIN users u ON u.id=r.user_id WHERE r.test_id=? ORDER BY r.id DESC LIMIT 10`).all(test.id);
    return { id:test.id,group_id:test.group_id,group_name:test.group_name,sample_text:test.sample_text,status:test.status,
      assigned_to:test.assigned_to,post_status:test.post_status,post_error:test.post_error,
      created_at:test.created_at,posted_at:test.posted_at,replies };
  }
  function assess(test, user, text, { canViewReferral,canManageReferral,seesAll,detectStatus,approvedStatus }) {
    const ref = { created_by:test.created_by,team_id:test.creator_team_id,assigned_to:test.assigned_to,status:test.status };
    const authorized = user && canViewReferral(user,ref) ? user : null;
    const verdict = detectStatus(text,approvedStatus);
    const permitted = !!authorized && canManageReferral(authorized,ref);
    const status = permitted && verdict.status ? verdict.status : test.status;
    return { actor:authorized ? 'crm' : 'external',user_id:authorized?.id || null,
      from_status:test.status,to_status:status,can_change_status:permitted,
      assigned_to:!test.assigned_to && authorized && seesAll(authorized) ? authorized.id : test.assigned_to,
      ambiguous:!!verdict.options,bot_messages:0,bot_reactions:0 };
  }
  return {
    get,view,assess,
    latest:group => { const row=latest(group);return row ? get(row.id) : null; },
    create(group,user,includeNotes) {
      const sample = waFormat.quietLead(waFormat.QUIET_TEST_LEAD,{includeNotes});
      const row = db.prepare('INSERT INTO wa_quiet_tests(group_id,group_name,created_by,sample_text) VALUES(?,?,?,?)')
        .run(group.id,group.name,user.id,sample);
      return get(Number(row.lastInsertRowid));
    },
    mark(id,status,error='',messageId='') {
      db.prepare(`UPDATE wa_quiet_tests SET post_status=?,post_error=?,
        message_id=CASE WHEN ?<>'' THEN ? ELSE message_id END,
        posted_at=CASE WHEN ? IN ('sent','unconfirmed') THEN datetime('now') ELSE posted_at END WHERE id=?`)
        .run(status,String(error).slice(0,500),messageId,messageId,status,id);
    },
    forReply(chat,quotedId) {
      if (!quotedId) return null;
      const row = db.prepare(`SELECT id FROM wa_quiet_tests WHERE group_id=? AND message_id=?
        UNION SELECT test_id FROM wa_quiet_test_replies WHERE chat=? AND message_id=? LIMIT 1`).get(chat,quotedId,chat,quotedId);
      return row ? get(row.id) : null;
    },
    capture(test,m,user,policy) {
      const body = String(m.text).trim().slice(0,2000);
      const result = assess(test,user,body,policy);
      const author = String(m.name || user?.full_name || 'WhatsApp participant').trim().slice(0,100) || 'WhatsApp participant';
      tx(db,() => {
        const inserted = db.prepare(`INSERT OR IGNORE INTO wa_quiet_test_replies
          (test_id,chat,message_id,user_id,external_author,body,from_status,to_status) VALUES(?,?,?,?,?,?,?,?)`)
          .run(test.id,m.chat,m.id,result.user_id,result.user_id ? '' : author,body,result.from_status,result.to_status);
        if (inserted.changes) db.prepare('UPDATE wa_quiet_tests SET status=?,assigned_to=? WHERE id=?')
          .run(result.to_status,result.assigned_to,test.id);
      });
      return result;
    },
  };
}

module.exports = { createStore };
