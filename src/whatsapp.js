'use strict';

// WhatsApp alerts through a linked phone (QR code), for:
//   - posting every new lead to the dispatch group, in the same format as Copy for WhatsApp;
//   - sending each person their alerts on WhatsApp, if they added a number and turned it on.
// Messages go out one at a time from a paced queue (gentle on the linked number), wait
// while the link is down, and never block the app: the in-app and phone notifications
// always go out regardless.

const path = require('node:path');
const QRCode = require('qrcode');
const waFormat = require('../public/waformat');
const { normalizeState } = require('./normalize');
const { createStore } = require('./quiet-group-test');

const GAP_MS = 1500; // between messages
const HOURLY_CAP = 200;
const QUEUE_MAX = 300;
const BACKOFF = [2000, 5000, 15000, 30000, 60000];

const digitsOf = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  // Mexico removed its mobile prefix 1, but WhatsApp can still supply older +521 ids.
  // Match that identity to the same +52 number saved in an account.
  if (d.length === 13 && d.startsWith('521')) return `52${d.slice(3)}`;
  return d.length === 10 ? `1${d}` : d; // US numbers without the country code
};

function mount(app, db, { requireUser, requireRole, wrap, awrap, HttpError, getSettings, logAudit, notifyAdmins, rateLimit, createTransport, dataDir }) {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const quietTests = createStore(db);
  const st = { status: 'off', qr: null, me: null, error: '', since: null, alerted: false };
  let transport = null;
  let starting = false;
  let retries = 0;
  let retryTimer = null;
  const queue = [];
  let messageHandler = null; // set by the dispatch-group bot
  const sentTimes = [];
  const jidCache = new Map();
  let pumping = false;
  let activeItem = null;
  // Runtime diagnostics contain no message bodies or sender numbers. They reset on restart.
  const diagnostics = { received: 0, last_received_at: null, last_result: '', handler_errors: 0,
    sent: 0, failed: 0, dropped: 0, suppressed: 0, last_sent_at: null, last_error: '',
    retry_requests:0,retry_available:0,retry_missing:0,retry_blocked:0,retry_cache_errors:0,auth_save_errors:0,last_retry_at:null };

  async function receive(m) {
    diagnostics.received++;
    diagnostics.last_received_at = new Date().toISOString();
    diagnostics.last_result = 'processing';
    if (!messageHandler) { diagnostics.last_result = 'not_ready'; return; }
    try {
      const result = await messageHandler(m);
      diagnostics.last_result = result || 'handled';
      return result;
    } catch (e) {
      diagnostics.handler_errors++;
      diagnostics.last_result = 'handler_error';
      diagnostics.last_error = e.message;
      throw e;
    }
  }

  const authDir = path.join(dataDir, 'whatsapp-auth');
  const cfg = () => {
    const s = getSettings();
    return {
      enabled: s.wa_enabled === '1',
      groupId: s.wa_group_id || '',
      groupName: s.wa_group_name || '',
      newLeadGroup: s.wa_new_lead_group !== '0',
      groupMode: s.wa_group_mode === 'quiet' ? 'quiet' : 'interactive',
      quietAccess: s.wa_quiet_access === 'selected' ? 'selected' : 'everyone',
      quietGroupId: s.wa_quiet_group_id || '', quietGroupName: s.wa_quiet_group_name || '',
      quietEnabled: s.wa_quiet_enabled === '1', quietCapture: s.wa_quiet_capture !== '0',
      includeNotes: s.wa_quiet_include_notes !== '0',
      testGroupId: s.wa_test_group_id || '', testGroupName: s.wa_test_group_name || '',
    };
  };
  const setStatus = (status, extra = {}) => { Object.assign(st, { status, since: Date.now() }, extra); };
  const isQuietGroup = chat => {
    const c = cfg();
    return !!chat && ((chat === c.groupId && c.groupMode === 'quiet') || chat === c.quietGroupId || chat === c.testGroupId);
  };
  const quietCaptureEnabled = chat => {
    const c = cfg();
    return c.enabled && (chat === c.groupId && c.groupMode === 'quiet' ? getSettings().wa_two_way !== '0'
      : chat === c.quietGroupId && c.quietCapture);
  };
  const outcomeKey = chat => chat === cfg().quietGroupId && chat !== cfg().groupId ? 'wa_last_quiet_lead_post' : 'wa_last_lead_post';

  // Persist the last lead-post outcome across deploys without saving its text
  // or customer details. A connected socket alone doesn't prove a post was sent.
  function recordLeadPost(item, status, error = '', messageId = '') {
    if (item.quietTestId) { quietTests.mark(item.quietTestId,status,error,messageId);return; }
    if (!item.referralId) return;
    set.run(item.outcomeKey || outcomeKey(item.jid), JSON.stringify({
      referral_id: item.referralId, group_id: item.jid || '', status,
      at: new Date().toISOString(), error: String(error).slice(0, 500),
    }));
  }

  function lastLeadPost(key = 'wa_last_lead_post') {
    let post;
    try { post = JSON.parse(getSettings()[key] || 'null'); } catch { return null; }
    if (!post || !Number.isInteger(post.referral_id)) return null;
    if (post.status === 'queued' && ![activeItem, ...queue].some(item => item?.referralId === post.referral_id && item.jid === post.group_id)) {
      return { ...post, status: 'interrupted', error: 'The server restarted before confirming this post. Check the group before reposting.' };
    }
    return post;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const wait = BACKOFF[Math.min(retries, BACKOFF.length - 1)];
    retries++;
    setStatus('reconnecting');
    retryTimer = setTimeout(() => { start(); }, wait);
    if (retryTimer.unref) retryTimer.unref();
    // Tell admins once if it stays down for a while.
    if (retries === 8 && !st.alerted) {
      st.alerted = true;
      notifyAdmins('⚠️ WhatsApp alerts can\'t connect right now. Leads still alert in the app. Check Admin → Settings → WhatsApp alerts.');
    }
  }

  async function start() {
    if (starting || !cfg().enabled) return;
    starting = true;
    try {
      if (transport) await transport.stop();
      transport = createTransport({
        authDir,
        canRetryMessage:record=>{
          const c=cfg();if(!c.enabled)return false;
          if(!record.chat.endsWith('@g.us'))return true;
          if(![c.groupId,c.quietGroupId,c.testGroupId].includes(record.chat))return false;
          return !isQuietGroup(record.chat) || (record.quiet && ['lead','test_lead'].includes(record.kind));
        },
        onDiagnostic:({kind})=>{
          const fields={retry_request:'retry_requests',retry_available:'retry_available',retry_missing:'retry_missing',retry_blocked:'retry_blocked',retry_cache_error:'retry_cache_errors',auth_save_error:'auth_save_errors'};
          if(fields[kind])diagnostics[fields[kind]]++;
          if(kind==='retry_request')diagnostics.last_retry_at=new Date().toISOString();
          if(kind==='auth_save_error')diagnostics.last_error='WhatsApp could not save its encryption keys. Check the persistent disk.';
          if(kind==='retry_cache_error')diagnostics.last_error='WhatsApp could not read or save its message-retry cache. Check the persistent disk.';
        },
        onQr: async (raw) => {
          try { st.qr = await QRCode.toDataURL(raw, { margin: 1, width: 280 }); } catch { st.qr = null; }
          setStatus('qr');
        },
        onOpen: (me) => {
          retries = 0;
          st.alerted = false;
          setStatus('connected', { qr: null, error: '', me: { number: String(me.id || '').split(/[:@]/)[0], lid: String(me.lid || '').split(/[:@]/)[0], name: me.name || '' } });
          pump();
        },
        onMessage: (m) => {
          receive(m).catch((e) => console.error('WhatsApp message handling failed:', e.message));
        },
        onClose: (why) => {
          st.error = why.message || '';
          if (why.loggedOut) {
            setStatus('logged_out', { qr: null, me: null });
            transport.logout().catch(() => {});
            notifyAdmins('⚠️ WhatsApp alerts were disconnected from the phone. Scan the QR code again in Admin → Settings → WhatsApp alerts.');
          } else if (why.replaced) {
            setStatus('replaced', { qr: null });
          } else if (why.restart) {
            setImmediate(start);
          } else if (cfg().enabled) {
            scheduleRetry();
          }
        },
      });
      setStatus('starting', { qr: null });
      await transport.start();
      // If WhatsApp never answers, don't sit on "Connecting…" forever.
      const startedAt = st.since;
      const watchdog = setTimeout(() => {
        if (st.status === 'starting' && st.since === startedAt) { transport.stop(); st.error = 'No answer from WhatsApp'; scheduleRetry(); }
      }, 60000);
      if (watchdog.unref) watchdog.unref();
    } catch (e) {
      st.error = e.message;
      scheduleRetry();
    } finally {
      starting = false;
    }
  }

  // ---------- the paced queue ----------

  function enqueue(item) {
    if (!cfg().enabled) return false;
    if (isQuietGroup(item.jid) && !item.referralId && !item.quietTestId) { diagnostics.suppressed++;return false; }
    queue.push({ ...item, tries: 0 });
    while (queue.length > QUEUE_MAX) {
      const dropped=queue.shift(); diagnostics.dropped++; diagnostics.last_error = 'WhatsApp queue is full; oldest message discarded.';
      recordLeadPost(dropped, 'failed', diagnostics.last_error);
      if (dropped.onFailed) { try { dropped.onFailed(diagnostics.last_error); } catch (e) { console.error(e.message); } }
    }
    pump();
    return true;
  }

  async function resolveJid(item) {
    if (item.jid) return item.jid;
    const hit = jidCache.get(item.digits);
    if (hit && Date.now() - hit.at < 86400000) return hit.jid;
    const jid = await transport.exists(item.digits);
    jidCache.set(item.digits, { jid, at: Date.now() });
    return jid;
  }

  async function pump() {
    if (pumping || st.status !== 'connected' || !queue.length) return;
    const now = Date.now();
    while (sentTimes.length && now - sentTimes[0] > 3600000) sentTimes.shift();
    if (sentTimes.length >= HOURLY_CAP) { setTimeout(pump, 60000).unref?.(); return; }
    pumping = true;
    const item = queue.shift();
    activeItem = item;
    try {
      const jid = await resolveJid(item);
      if (jid) {
        const c = cfg();
        if (jid.endsWith('@g.us') && jid !== c.groupId && jid !== c.quietGroupId && jid !== c.testGroupId) {
          recordLeadPost(item,'skipped','This group is no longer selected.');
          if (item.onFailed) item.onFailed('This WhatsApp group is no longer selected.');
          return;
        }
        if (item.quietTestId && jid !== c.testGroupId) {
          recordLeadPost(item,'skipped','The test group changed before this post was sent.');return;
        }
        if (item.referralId && !item.force && (jid === c.groupId ? !c.newLeadGroup : !c.quietEnabled)) {
          recordLeadPost(item,'skipped','Lead posts were paused before this message was sent.');
          return;
        }
        // Check again at send time: an admin may have enabled quiet mode while
        // acknowledgments or briefings were already waiting in the queue.
        const quiet = item.quiet || isQuietGroup(jid);
        if (quiet && !item.referralId && !item.quietTestId) {
          diagnostics.suppressed++;
          if (item.onFailed) item.onFailed('Quiet groups accept lead posts only.');
          return;
        }
        let text = item.text;
        if (item.quietTestId) {
          const test = quietTests.get(item.quietTestId);
          if (!test || test.group_id !== jid) throw new Error('The test post no longer exists.');
          text = test.sample_text;
        } else if (quiet) {
          const ref = db.prepare('SELECT * FROM referrals WHERE id=?').get(item.referralId);
          if (!ref) throw new Error('The lead no longer exists.');
          text = waFormat.quietLead({ ...ref, state_name: normalizeState(ref.state)?.name || '' }, { includeNotes: cfg().includeNotes });
        }
        const id = item.react
          ? await transport.react(jid, item.react.id, item.react.emoji)
          : await transport.sendText(jid, text, { quotedId: item.quotedId,kind:item.quietTestId ? 'test_lead' : item.referralId ? 'lead' : 'chat',quiet:!!quiet });
        sentTimes.push(Date.now());
        if (!item.react) { diagnostics.sent++; diagnostics.last_sent_at = new Date().toISOString(); }
        recordLeadPost(item, id ? 'sent' : 'unconfirmed', id ? '' : 'WhatsApp returned no message reference. Check the group before reposting.',id || '');
        if (item.onSent && id) {
          try { item.onSent(id, jid); }
          catch (e) {
            recordLeadPost(item, 'unlinked', 'The post was accepted, but its CRM reply link could not be saved. Use the lead number in your reply.');
            diagnostics.last_error = e.message;console.error(e);
          }
        }
      } else {
        diagnostics.failed++;
        diagnostics.last_error = 'Recipient number was not found on WhatsApp.';
        recordLeadPost(item, 'failed', diagnostics.last_error);
        if (item.onFailed) item.onFailed(diagnostics.last_error);
      }
    } catch (e) {
      if (++item.tries < 3) queue.push(item);
      else {
        diagnostics.failed++; recordLeadPost(item, 'failed', e.message);
        if (item.onFailed) { try { item.onFailed(e.message); } catch (err) { console.error(err.message); } }
      }
      st.error = e.message;
      diagnostics.last_error = e.message;
    } finally {
      pumping = false;
      activeItem = null;
      if (queue.length) { const t = setTimeout(pump, GAP_MS); if (t.unref) t.unref(); }
    }
  }

  // ---------- what the rest of the app calls ----------

  const api = {
    start,
    stop: async () => { clearTimeout(retryTimer);setStatus('off');if (transport) await transport.stop(); },
    status: () => st.status,
    // A person's alerts, if they added a WhatsApp number and switched it on.
    sendToUser(user, text, { onSent, onFailed } = {}) {
      const d = digitsOf(user.whatsapp);
      if (!user.whatsapp_alerts || d.length < 11) return false;
      return enqueue({ digits: d, text, onSent, onFailed });
    },
    // The new-lead post to the dispatch group. onSent(messageId) lets replies find the lead.
    postToGroup(text, onSent, { force = false, referralId = null, groupId = null } = {}) {
      const c = cfg();
      const target = groupId || c.groupId;
      const extra = target === c.quietGroupId && target !== c.groupId;
      const item = { jid: target, text, onSent, referralId, force, quiet:isQuietGroup(target), outcomeKey:outcomeKey(target) };
      if (!c.enabled || !target || (extra ? !c.quietEnabled : !c.newLeadGroup && !force)) {
        recordLeadPost(item, 'skipped', !c.enabled ? 'WhatsApp is off.' : !target ? 'No group is selected.' : 'New-lead group posts are switched off.');
        return false;
      }
      if (target !== c.groupId && target !== c.quietGroupId) return false;
      if (isQuietGroup(target) && !referralId) { diagnostics.suppressed++;return false; }
      recordLeadPost(item, 'queued');
      return enqueue(item);
    },
    // A reply in a chat, optionally quoting the message it answers.
    reply(chat, text, { quotedId, onSent } = {}) { return enqueue({ jid: chat, text, quotedId, onSent }); },
    react(chat, messageId, emoji) { return enqueue({ jid: chat, react: { id: messageId, emoji } }); },
    groupId: () => cfg().groupId,
    quietGroupId: () => cfg().quietGroupId,
    quietAccess: () => cfg().quietAccess,
    quietGroupEnabled: () => cfg().quietEnabled,
    testGroupId: () => cfg().testGroupId,
    quietTests,
    isQuietGroup, quietCaptureEnabled,
    me: () => st.me,
    onMessage(fn) { messageHandler = fn; },
    // For tests: hand the bot a message as if it came from WhatsApp.
    receive,
    queueLength: () => queue.length,
    // For tests: run the queue now.
    async drain() { for (let i = 0; i < 1000 && queue.length && st.status === 'connected'; i++) await pump(); },
  };

  // ---------- admin routes ----------

  function testView() {
    const c=cfg(),test=quietTests.latest(c.testGroupId),last=quietTests.view(test);
    if (last?.post_status === 'queued' && ![activeItem,...queue].some(item=>item?.quietTestId===last.id)) {
      last.post_status='interrupted';last.post_error='The server restarted before confirming this test. Check the group before sending again.';
    }
    return { group:c.testGroupId ? {id:c.testGroupId,name:c.testGroupName} : null,
      connected:st.status==='connected',sample_text:waFormat.quietLead(waFormat.QUIET_TEST_LEAD,{includeNotes:c.includeNotes}),last_test:last };
  }

  app.get('/api/whatsapp/quiet-test',wrap(req=>{requireRole(req,'admin');return testView();}));
  app.post('/api/whatsapp/quiet-test',awrap(async req=>{
    const u=requireRole(req,'admin'),c=cfg();
    if (!c.enabled || st.status!=='connected') throw new HttpError(409,'Connect WhatsApp first.');
    if (!c.testGroupId) throw new HttpError(400,'Choose a test group first.');
    if (testView().last_test?.post_status==='queued') throw new HttpError(409,'A test post is already waiting to send.');
    const groups=await transport.listGroups();
    if (!groups.some(g=>g.id===c.testGroupId)) throw new HttpError(400,'The test group was not found. Add the alerts phone to it, then choose it here.');
    if (cfg().testGroupId!==c.testGroupId) throw new HttpError(409,'The test group changed. Send the test again to the selected group.');
    // Recheck after the membership lookup so concurrent clicks cannot queue duplicates.
    if (testView().last_test?.post_status==='queued') throw new HttpError(409,'A test post is already waiting to send.');
    const test=quietTests.create({id:c.testGroupId,name:c.testGroupName},u,c.includeNotes);
    if (!enqueue({jid:test.group_id,quietTestId:test.id,quiet:true})) quietTests.mark(test.id,'skipped','WhatsApp is off.');
    logAudit(req,'whatsapp.quiet_test','settings',test.id,`Sample lead to ${c.testGroupName || c.testGroupId}`);
    return testView();
  }));

  const statusView = () => {
    const c = cfg();
    const postingBlocker = !c.enabled ? 'WhatsApp is off.' : !c.groupId ? 'Pick the dispatch group.'
      : !c.newLeadGroup ? 'New-lead group posts are switched off.' : st.status !== 'connected' ? 'Waiting for the WhatsApp connection.' : '';
    const replyBlocker = !c.enabled ? 'WhatsApp is off.' : !c.groupId ? 'Pick the dispatch group.'
      : getSettings().wa_two_way === '0' ? 'Group replies are switched off.' : st.status !== 'connected' ? 'Waiting for the WhatsApp connection.' : '';
    return {
      enabled: c.enabled, status: st.status, qr: st.status === 'qr' ? st.qr : null, me: st.me, error: st.error,
      group: c.groupId ? { id: c.groupId, name: c.groupName } : null, new_lead_group: c.newLeadGroup, queued: queue.length,
      group_mode: c.groupMode, quiet_include_notes: c.includeNotes, quiet_access: c.quietAccess,
      quiet_test: testView(),
      quiet_group: { enabled: c.quietEnabled, group: c.quietGroupId ? { id: c.quietGroupId, name: c.quietGroupName } : null,
        capture_replies: c.quietCapture, posting_ready: !!(c.enabled && c.quietEnabled && c.quietGroupId && st.status === 'connected'),
        last_lead_post: lastLeadPost('wa_last_quiet_lead_post') },
      two_way: getSettings().wa_two_way !== '0', approved_status: getSettings().wa_approved_status === 'Passed' ? 'Passed' : 'Ordered',
      ai_available: !!process.env.ANTHROPIC_API_KEY, ai_enabled: getSettings().ai_enabled !== '0',
      diagnostics: { ...diagnostics },
      group_flow: { posting_ready: !postingBlocker, replies_ready: !replyBlocker,
        posting_blocker: postingBlocker, reply_blocker: replyBlocker, last_lead_post: lastLeadPost() },
      people: db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND whatsapp_alerts = 1 AND whatsapp <> ''").get().n,
    };
  };

  app.get('/api/whatsapp/status', wrap((req) => { requireRole(req, 'admin'); return statusView(); }));

  app.post('/api/whatsapp/connect', wrap((req) => {
    requireRole(req, 'admin');
    set.run('wa_enabled', '1');
    retries = 0;
    if (!['connected', 'starting', 'qr'].includes(st.status)) start();
    logAudit(req, 'whatsapp.connect', 'settings', '', '');
    return statusView();
  }));

  app.post('/api/whatsapp/disconnect', awrap(async (req) => {
    requireRole(req, 'admin');
    set.run('wa_enabled', '0');
    clearTimeout(retryTimer);
    if (transport) await transport.logout().catch(() => {});
    setStatus('off', { qr: null, me: null, error: '' });
    for (const item of queue.splice(0)) {
      recordLeadPost(item, 'failed', 'WhatsApp was disconnected before this message was sent.');
      if (item.onFailed) { try { item.onFailed('WhatsApp was disconnected before this message was sent.'); } catch (e) { console.error(e.message); } }
    }
    logAudit(req, 'whatsapp.disconnect', 'settings', '', '');
    return statusView();
  }));

  app.get('/api/whatsapp/groups', awrap(async (req) => {
    requireRole(req, 'admin');
    if (st.status !== 'connected') throw new HttpError(409, 'Connect WhatsApp first.');
    const groups = await transport.listGroups();
    return groups.sort((x, y) => x.name.localeCompare(y.name));
  }));

  app.patch('/api/whatsapp/settings', wrap((req) => {
    requireRole(req, 'admin');
    const b = req.body || {};
    if (b.quiet_access !== undefined && !['everyone','selected'].includes(b.quiet_access))
      throw new HttpError(400,'Choose everyone in the quiet group or selected numbers.');
    for (const field of ['quiet_enabled','quiet_capture','quiet_include_notes']) {
      if (b[field] !== undefined && typeof b[field] !== 'boolean') throw new HttpError(400,'Quiet group switches must be on or off.');
    }
    const current = cfg();
    const mainId = String(b.group_id ?? current.groupId);
    const quietId = String(b.quiet_group_id ?? current.quietGroupId);
    const testId = String(b.test_group_id ?? current.testGroupId);
    if ([mainId, quietId, testId].some(id => id && !/^[\w.-]+@g\.us$/.test(id))) throw new HttpError(400, 'Pick a group from the list.');
    if (testId && testId===mainId && (b.group_mode ?? current.groupMode)!=='quiet') throw new HttpError(400,'Choose a separate test group. Clear the test group before using it as an interactive dispatch group.');
    if (mainId && mainId === quietId) throw new HttpError(400, 'Choose different dispatch and additional quiet groups, or set the dispatch group mode to Quiet.');
    if (b.group_mode !== undefined && !['interactive','quiet'].includes(b.group_mode)) throw new HttpError(400, 'Choose Interactive or Quiet mode.');
    if (b.quiet_enabled === true && !quietId) throw new HttpError(400, 'Pick the additional quiet group first.');
    if (b.approved_status !== undefined && !['Ordered','Passed'].includes(b.approved_status)) throw new HttpError(400, '"Approved" can mean Ordered or Passed.');
    if (b.group_id !== undefined) {
      const id = String(b.group_id || '');
      if (id && !/^[\w.-]+@g\.us$/.test(id)) throw new HttpError(400, 'Pick a group from the list.');
      set.run('wa_group_id', id);
      set.run('wa_group_name', id ? String(b.group_name || '').slice(0, 100) : '');
    }
    if (b.new_lead_group !== undefined) set.run('wa_new_lead_group', b.new_lead_group ? '1' : '0');
    if (b.group_mode !== undefined) set.run('wa_group_mode', b.group_mode);
    if (b.quiet_access !== undefined) set.run('wa_quiet_access', b.quiet_access);
    if (b.quiet_group_id !== undefined) {
      set.run('wa_quiet_group_id', quietId);
      set.run('wa_quiet_group_name', quietId ? String(b.quiet_group_name || '').slice(0, 100) : '');
      if (!quietId) set.run('wa_quiet_enabled', '0');
    }
    if (b.quiet_enabled !== undefined) set.run('wa_quiet_enabled', b.quiet_enabled ? '1' : '0');
    if (b.quiet_capture !== undefined) set.run('wa_quiet_capture', b.quiet_capture ? '1' : '0');
    if (b.quiet_include_notes !== undefined) set.run('wa_quiet_include_notes', b.quiet_include_notes ? '1' : '0');
    if (b.test_group_id !== undefined) {
      set.run('wa_test_group_id',testId);
      set.run('wa_test_group_name',testId ? String(b.test_group_name || '').slice(0,100) : '');
    }
    if (b.two_way !== undefined) set.run('wa_two_way', b.two_way ? '1' : '0');
    if (b.ai_enabled !== undefined) set.run('ai_enabled', b.ai_enabled ? '1' : '0');
    if (b.approved_status !== undefined) {
      if (!['Ordered', 'Passed'].includes(b.approved_status)) throw new HttpError(400, '"Approved" can mean Ordered or Passed.');
      set.run('wa_approved_status', b.approved_status);
    }
    logAudit(req, 'whatsapp.settings', 'settings', '', JSON.stringify(b).slice(0, 300));
    return statusView();
  }));

  app.post('/api/whatsapp/test', wrap((req) => {
    const u = requireRole(req, 'admin');
    const target = (req.body || {}).target;
    if (st.status !== 'connected') throw new HttpError(409, 'WhatsApp isn\'t connected.');
    if (target === 'group') {
      const c = cfg();
      if (!c.groupId) throw new HttpError(400, 'Pick the dispatch group first.');
      if (isQuietGroup(c.groupId)) throw new HttpError(409, 'Quiet groups accept lead posts only. Use the preview in Settings.');
      enqueue({ jid: c.groupId, text: `✅ E&O Referrals is connected. New leads will be posted here. (Test sent by ${u.full_name})` });
    } else {
      throw new HttpError(400, 'Unknown test.');
    }
    return { ok: true };
  }));

  // Anyone can send themselves a test, once their number is saved.
  const testHits = new Map();
  app.post('/api/whatsapp/test-me', wrap((req) => {
    const u = requireUser(req);
    if (!rateLimit(testHits, `u:${u.id}`, 5, 3600000)) throw new HttpError(429, 'Try again in a little while.');
    if (st.status !== 'connected') throw new HttpError(409, 'WhatsApp alerts aren\'t connected yet. Ask your admin.');
    const row = db.prepare('SELECT whatsapp FROM users WHERE id = ?').get(u.id);
    const d = digitsOf(row.whatsapp);
    if (d.length < 11) throw new HttpError(400, 'Save your WhatsApp number first.');
    enqueue({ digits: d, text: `✅ Hi ${u.full_name.split(' ')[0]}! Your E&O Referrals alerts will come here.` });
    return { ok: true };
  }));

  return api;
}

module.exports = { mount, digitsOf };
