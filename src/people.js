'use strict';

function mount(
  app,
  db,
  { requireUser, wrap, HttpError, seesAll, canViewReferral }
) {
  app.get(
    '/api/people/:id',
    wrap((req) => {
      const viewer = requireUser(req),
        id = Number(req.params.id);
      const person = db
        .prepare(
          'SELECT u.id,u.username,u.full_name,u.role,u.team_id,u.active,u.created_at,t.name AS team_name FROM users u LEFT JOIN teams t ON t.id=u.team_id WHERE u.id=?'
        )
        .get(id);
      if (!person) throw new HttpError(404, 'Profile not found.');
      const shared = db
        .prepare(
          'SELECT r.* FROM referrals r WHERE r.created_by=? OR r.assigned_to=? OR EXISTS(SELECT 1 FROM comments c WHERE c.referral_id=r.id AND c.user_id=?) OR EXISTS(SELECT 1 FROM status_history h WHERE h.referral_id=r.id AND h.user_id=?)'
        )
        .all(id, id, id, id)
        .filter((r) => canViewReferral(viewer, r));
      if (
        !seesAll(viewer) &&
        viewer.id !== id &&
        !(viewer.team_id != null && viewer.team_id === person.team_id) &&
        !['admin', 'dispatch'].includes(person.role) &&
        !shared.length
      )
        throw new HttpError(404, 'Profile not found.');
      const owned = shared.filter((r) => r.created_by === id),
        leads = owned
          .slice()
          .sort((a, b) => b.id - a.id)
          .slice(0, 50)
          .map((r) => ({
            id: r.id,
            name: r.customer_name,
            status: r.status,
            created_at: r.created_at,
          }));
      const allowed = new Set(shared.map((r) => r.id));
      const activity = db
        .prepare(
          `SELECT 'status' AS kind,h.id AS id,h.referral_id,r.customer_name,h.created_at AS created_at,h.from_status,h.to_status,'' AS body FROM status_history h JOIN referrals r ON r.id=h.referral_id WHERE h.user_id=?
      UNION ALL SELECT 'comment',c.id,c.referral_id,r.customer_name,c.created_at,NULL,NULL,c.body FROM comments c JOIN referrals r ON r.id=c.referral_id WHERE c.user_id=? ORDER BY created_at DESC,id DESC`
        )
        .all(id, id)
        .filter((r) => allowed.has(r.referral_id))
        .slice(0, 80);
      return {
        person,
        summary: {
          opportunities: owned.length,
          open: owned.filter((r) =>
            ['New', 'Working', 'Passed'].includes(r.status)
          ).length,
          ordered: owned.filter((r) => r.status === 'Ordered').length,
        },
        leads,
        activity,
      };
    })
  );
}
module.exports = { mount };
