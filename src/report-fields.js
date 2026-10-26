'use strict';

// Only business fields belong in reports. Authentication, matching keys, and PDF bytes stay private.
const FIELDS = [];
function add(group, entries) {
  for (const [key, label, type = 'text', sql = `r.${key}`] of entries) FIELDS.push({ key, label, type, group, sql });
}
add('Customer', [['id','Lead ID','number'],['customer_name','Customer'],['company','Company'],['phone','Phone'],['alt_phone','Alternate phone'],['email','Email'],['dob','Date of birth','date'],['address','Address'],['city','City'],['state','State'],['zip','ZIP'],['contact_pref','Contact preference']]);
add('Opportunity', [['status','Stage'],['services','Services'],['lead_priority','Priority'],['lead_score','Lead score','number'],['est_monthly_value','Estimated monthly value','number'],['package_details','Package details'],['notes','Notes'],['created_at','Created','date'],['updated_at','Updated','date']]);
add('People & teams', [['created_by','Owner ID','number'],['created_by_name','Opportunity owner','text','u.full_name'],['owner_username','Owner username','text','u.username'],['team_id','Team ID','number'],['team_name','Team','text','t.name'],['assigned_to','Dispatcher ID','number'],['assigned_name','Dispatcher','text','a.full_name'],['assigned_at','Assigned','date'],['entered_by','Entered by ID','number'],['entered_by_name','Entered by','text','e.full_name'],['first_touch_at','First response','date'],['response_by','First responder','text','f.full_name']]);
add('Order', [['account_number','Account number'],['order_number','Order number'],['order_reference','Order reference'],['install_date','Installation date','date'],['delivery_date','Delivery date','date'],['initial_payment','Initial payment','number']]);
add('Activity', [['follow_up_at','Follow-up','date'],['follow_up_note','Follow-up note'],['comment_count','Comments','number','(SELECT count(*) FROM comments c WHERE c.referral_id = r.id)'],['document_count','Documents','number','(SELECT count(*) FROM customer_documents d WHERE d.referral_id = r.id)']]);
add('Stage timers', [['current_stage_started_at','Stage started','date','st.current_stage_started_at'],['current_stage_minutes','Time in current stage (minutes)','number','st.current_stage_minutes'],['total_open_minutes','Total time in open stages (minutes)','number','st.total_open_minutes'],['first_ordered_at','First ordered','date','st.first_ordered_at'],...['New','Working','Passed','DNQ','Ordered','Cancelled'].map(s=>[`${s.toLowerCase()}_minutes`,`${s}: total minutes`,'number',`st.${s.toLowerCase()}_minutes`])]);
add('Stage timers', [['history_incomplete','Stage history incomplete (1 = yes)','number',`CASE WHEN st.current_stage_started_at IS NULL OR EXISTS (
  SELECT 1 FROM status_history sh WHERE sh.referral_id = r.id
  AND sh.id = (SELECT min(h.id) FROM status_history h WHERE h.referral_id = r.id)
  AND sh.from_status IS NULL AND (sh.to_status <> 'New' OR sh.created_at > r.created_at)
) THEN 1 ELSE 0 END`]]);

class ReportConfigError extends Error { constructor(message) { super(message); this.status = 400; } }
const BY_KEY = new Map(FIELDS.map(f=>[f.key,f]));
const DEFAULT_COLUMNS = ['id','created_at','customer_name','phone','email','address','state','services','status','created_by_name','team_name'];
function field(key) {
  const found = BY_KEY.get(key);
  if (!found) throw new ReportConfigError(`Unknown report field: ${String(key).slice(0,80)}`);
  return found;
}
function validateConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ReportConfigError('Invalid report configuration.');
  if (config.data_source && config.data_source !== 'referrals') throw new ReportConfigError('Reports currently support opportunities and their customer, owner, team, order, and activity fields.');
  if (config.columns !== undefined) {
    if (!Array.isArray(config.columns) || !config.columns.length || config.columns.length > FIELDS.length) throw new ReportConfigError('Choose at least one report column.');
    config.columns.forEach(field);
  }
  for (const key of ['group_by','secondary_group_by','sort_by','calc_field']) if (config[key]) field(config[key]);
  if (config.calc_field && field(config.calc_field).type !== 'number') throw new ReportConfigError('Calculations need a numeric field.');
  if (config.calc_function && !['sum','avg','min','max'].includes(config.calc_function)) throw new ReportConfigError('Choose a supported calculation.');
  if (field(config.date_field || 'created_at').type !== 'date') throw new ReportConfigError('Date range must use a date field.');
  if (config.sort_direction && !['asc','desc'].includes(config.sort_direction)) throw new ReportConfigError('Invalid sort direction.');
  if (config.filter_logic && !['all','any'].includes(config.filter_logic)) throw new ReportConfigError('Choose all or any filters.');
  if (config.filters !== undefined && (!Array.isArray(config.filters) || config.filters.length > 30)) throw new ReportConfigError('Use up to 30 filters.');
  for (const f of config.filters || []) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new ReportConfigError('Invalid report filter.');
    const def = field(f.field === 'service' ? 'services' : f.field);
    const op = f.op || (Array.isArray(f.value) ? 'in' : f.field === 'service' ? 'contains' : 'eq');
    if (!['eq','ne','contains','not_contains','gt','gte','lt','lte','empty','not_empty','in'].includes(op)) throw new ReportConfigError('Invalid filter operator.');
    if (['contains','not_contains'].includes(op) && def.type !== 'text') throw new ReportConfigError('Text matching needs a text field.');
    if (op === 'in' && (!Array.isArray(f.value) || !f.value.length || f.value.length > 200)) throw new ReportConfigError('Choose up to 200 filter values.');
    if (!['empty','not_empty'].includes(op)) for (const value of op === 'in' ? f.value : [f.value]) {
      if (value == null || typeof value === 'object' || String(value).length > 2000) throw new ReportConfigError('Enter a valid filter value.');
      if (def.type === 'number' && (String(value).trim() === '' || !Number.isFinite(Number(value)))) throw new ReportConfigError(`${def.label} needs a number.`);
    }
  }
  const presets = ['today','yesterday','this_week','last_week','this_month','last_month','qtd','ytd','rolling_30d','rolling_90d','last_30_days','last_90_days'];
  if (config.relative_date && !presets.includes(config.relative_date)) throw new ReportConfigError('Choose a valid date preset.');
  for (const date of [config.from, config.to].filter(Boolean)) if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new ReportConfigError('Use a valid date range.');
  if (!config.relative_date && config.from && config.to && config.from > config.to) throw new ReportConfigError('The start date must be on or before the end date.');
  return config;
}
module.exports = { FIELDS, DEFAULT_COLUMNS, field, validateConfig, ReportConfigError };
