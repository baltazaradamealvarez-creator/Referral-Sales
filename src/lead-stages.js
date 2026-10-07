'use strict';

const { STATUSES } = require('./db');
const OPEN = ['New', 'Working', 'Passed'];

// Use the audit sequence, including repeated visits. Notes and assignments never reset a stage.
// A closed record stops its clock; reopening it creates another recorded visit.
const STAGE_CTES = `
stage_history AS (
  SELECT h.*, ROW_NUMBER() OVER (PARTITION BY referral_id ORDER BY id) AS first_event,
    LEAD(created_at) OVER (PARTITION BY referral_id ORDER BY id) AS next_at,
    ROW_NUMBER() OVER (PARTITION BY referral_id ORDER BY id DESC) AS last_event
  FROM status_history h
),
stage_intervals AS (
  SELECT r.id AS referral_id, h.to_status AS stage,
    max(r.created_at, h.created_at) AS entered_at,
    h.next_at AS exited_at,
    CASE WHEN h.last_event = 1 AND h.to_status = r.status THEN 1 ELSE 0 END AS current,
    CASE WHEN h.next_at IS NOT NULL THEN max(0, (julianday(h.next_at)-julianday(max(r.created_at,h.created_at)))*1440)
      WHEN h.to_status = r.status AND r.status IN ('New','Working','Passed')
        THEN max(0, (julianday('now')-julianday(max(r.created_at,h.created_at)))*1440)
      ELSE 0 END AS minutes
  FROM referrals r JOIN stage_history h ON h.referral_id = r.id
  UNION ALL
  SELECT r.id, h.from_status, r.created_at, h.created_at, 0,
    max(0, (julianday(h.created_at)-julianday(r.created_at))*1440)
  FROM referrals r JOIN stage_history h ON h.referral_id = r.id AND h.first_event = 1
  WHERE h.from_status IS NOT NULL AND h.created_at > r.created_at
  UNION ALL
  SELECT r.id, 'New', r.created_at, NULL, 1,
    max(0, (julianday('now')-julianday(r.created_at))*1440)
  FROM referrals r WHERE r.status = 'New' AND NOT EXISTS (SELECT 1 FROM status_history h WHERE h.referral_id = r.id)
),
stage_facts AS (
  SELECT referral_id,
    max(CASE WHEN current = 1 THEN entered_at END) AS current_stage_started_at,
    max(CASE WHEN current = 1 THEN minutes END) AS current_stage_minutes,
    min(CASE WHEN stage = 'Ordered' THEN entered_at END) AS first_ordered_at,
    SUM(CASE WHEN stage IN ('New','Working','Passed') THEN minutes ELSE 0 END) AS total_open_minutes,
    ${STATUSES.map(s => `SUM(CASE WHEN stage = '${s}' THEN minutes ELSE 0 END) AS ${s.toLowerCase()}_minutes`).join(',\n    ')}
  FROM stage_intervals GROUP BY referral_id
)`;

function stageTiming(db, ref) {
  const scopedCTEs = STAGE_CTES.replace('FROM status_history h','FROM status_history h WHERE h.referral_id = ?');
  const intervals = db.prepare(`WITH ${scopedCTEs} SELECT * FROM stage_intervals WHERE referral_id = ? ORDER BY entered_at`).all(ref.id,ref.id);
  const current = intervals.find(i => i.current);
  const first = db.prepare('SELECT from_status, to_status, created_at FROM status_history WHERE referral_id = ? ORDER BY id LIMIT 1').get(ref.id);
  const partial = !current || (first && !first.from_status && (first.to_status !== 'New' || first.created_at > ref.created_at));
  return {
    as_of: new Date().toISOString(), current_stage: ref.status,
    current_started_at: current?.entered_at || null,
    current_minutes: current ? current.minutes : null,
    running: !!current && OPEN.includes(ref.status), partial: !!partial,
    stages: STATUSES.map(status => {
      const visits = intervals.filter(i => i.stage === status);
      return { status, minutes: visits.reduce((sum, i) => sum + i.minutes, 0), visits: visits.length,
        current: ref.status === status, intervals: visits.map(i => ({ entered_at: i.entered_at, exited_at: i.exited_at, minutes: i.minutes })) };
    }),
  };
}

module.exports = { STAGE_CTES, stageTiming };
