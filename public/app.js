'use strict';

(() => {
  const $app = document.getElementById('app');
  const state = { me: null, menuOpen: false };
  const STATUSES = ['New', 'Passed', 'DNQ', 'Ordered', 'Cancelled'];
  const SERVICES = ['Internet', 'TV', 'Mobile', 'Voice'];

  // ---------- utils ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch('/api' + path, init);
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== '/login') {
      state.me = null;
      renderLogin();
      throw new Error('Please sign in.');
    }
    if (res.status === 403 && data && data.must_change_password) {
      renderChangePassword(true);
      throw new Error(data.error);
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Something went wrong.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const parseDate = (iso) => new Date(iso.replace(' ', 'T') + 'Z');
  function when(iso) {
    if (!iso) return '';
    const d = parseDate(iso);
    const diff = (Date.now() - d) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  }
  const fullDate = (iso) => (iso ? parseDate(iso).toLocaleString() : '');
  const dayDate = (ymd) => (ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
  const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
  const svcTags = (s) => (s ? s.split(',').map((x) => `<span class="tag">${esc(x.trim())}</span>`).join('') : '');
  const leadName = (r) => r.customer_name || 'No name';
  const role = () => state.me && state.me.role;
  const isAdmin = () => role() === 'admin';
  const isManager = () => role() === 'manager';
  const seesAll = () => role() === 'admin' || role() === 'dispatch';
  const worksLeads = () => seesAll() || isManager();
  const managesUsers = () => isAdmin() || isManager();
  const canMoveCard = (r) => seesAll() || (isManager() && r.team_id === state.me.team_id);
  const roleLabel = (r) => ({ admin: 'Admin', manager: 'Manager', dispatch: 'Dispatch', rep: 'Rep' }[r] || r);

  function highlightMentions(text) {
    return esc(text).replace(/@([A-Za-z0-9._-]+)/g, '<span class="mention">@$1</span>');
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function query() {
    const q = location.hash.split('?')[1] || '';
    return Object.fromEntries(new URLSearchParams(q));
  }

  let peopleCache = null;
  async function people() {
    if (!worksLeads()) return { credit: [], dispatchers: [] };
    if (!peopleCache) peopleCache = await api('/people');
    return peopleCache;
  }

  // ---------- shell ----------

  function navLinks() {
    const links = [['#/new', 'New Referral']];
    if (seesAll()) links.push([`#/referrals?scope=assigned`, 'My Queue', 'queue']);
    links.push(['#/board', 'Board']);
    links.push(['#/referrals', worksLeads() ? 'Customers' : 'My Referrals']);
    if (seesAll()) links.push(['#/duplicates', 'Duplicates']);
    links.push(['#/sales', 'Sales']);
    if (managesUsers()) links.push(['#/team', isAdmin() ? 'Admin' : 'My Team']);
    return links;
  }

  function isActive(href) {
    const [route, qs] = location.hash.split('?');
    const [hRoute, hQs] = href.split('?');
    if (hRoute === '#/referrals') {
      const scope = new URLSearchParams(qs || '').get('scope');
      if (hQs) return route === hRoute && scope === 'assigned';
      return (route === hRoute && scope !== 'assigned') || route.startsWith('#/r/');
    }
    return (route || '#/new') === hRoute;
  }

  function badges() {
    const me = state.me;
    const bell = document.getElementById('bellBtn');
    if (bell) bell.innerHTML = `🔔${me.unread ? `<span class="badge">${me.unread > 99 ? '99+' : me.unread}</span>` : ''}`;
    const q = document.querySelector('[data-nav="queue"]');
    if (q) q.innerHTML = `My Queue${me.queue ? ` <span class="count">${me.queue}</span>` : ''}`;
  }

  function shell(content, opts = {}) {
    const me = state.me;
    $app.innerHTML = `
      <header class="topbar"><div class="topbar-inner ${opts.wide ? 'wide' : ''}">
        <a class="brand" href="#/new"><span class="logo">E&amp;O</span><span>E&amp;O Spectrum Referrals<small>${esc(me.team_name || (seesAll() ? 'All teams' : ''))}</small></span></a>
        <nav class="nav">${navLinks().map(([h, l, key]) => `<a href="${h}" ${key ? `data-nav="${key}"` : ''} class="${isActive(h) ? 'active' : ''}">${l}</a>`).join('')}</nav>
        <div class="top-actions">
          <a class="icon-btn" id="bellBtn" href="#/notifications" title="Notifications" aria-label="Notifications"></a>
          <div class="menu">
            <button class="icon-btn" id="menuBtn" aria-label="Account">👤</button>
            ${state.menuOpen ? `<div class="menu-pop">
              <div class="who"><b>${esc(me.full_name)}</b><div class="small muted">@${esc(me.username)} · ${roleLabel(me.role)}</div></div>
              <a href="#/account">My account</a>
              <button id="changePwBtn">Change password</button>
              <button id="logoutBtn">Sign out</button>
            </div>` : ''}
          </div>
        </div>
      </div></header>
      <main class="${opts.wide ? 'wide' : ''}">${content}</main>`;
    badges();
    document.getElementById('menuBtn').onclick = (e) => { e.stopPropagation(); state.menuOpen = !state.menuOpen; route_(); };
    if (state.menuOpen) {
      document.getElementById('logoutBtn').onclick = async () => {
        await api('/logout', { method: 'POST', body: {} }).catch(() => {});
        state.me = null; state.menuOpen = false; peopleCache = null;
        renderLogin();
      };
      document.getElementById('changePwBtn').onclick = () => { state.menuOpen = false; renderChangePassword(false); };
    }
  }
  document.addEventListener('click', () => { if (state.menuOpen) { state.menuOpen = false; route_(); } });

  async function refreshMe() {
    state.me = await api('/me');
    return state.me;
  }

  // ---------- login / password ----------

  function renderLogin() {
    $app.innerHTML = `
      <div class="login-wrap"><form class="card login" id="loginForm">
        <div class="logo">E&amp;O</div>
        <h1>E&amp;O Spectrum Referrals</h1>
        <p class="muted" style="margin-top:0">Sign in to enter and track referrals.</p>
        <div class="field"><label for="u">Username</label><input id="u" autocomplete="username" autocapitalize="none" required></div>
        <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
        <div id="loginErr" style="margin-top:.8rem"></div>
        <button class="btn primary big" style="margin-top:1rem">Sign in</button>
        <p class="small muted" style="margin-bottom:0">Forgot your password? Ask your manager to reset it.</p>
      </form></div>`;
    document.getElementById('u').focus();
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/login', { method: 'POST', body: { username: e.target.u.value, password: e.target.p.value } });
        peopleCache = null;
        await refreshMe();
        if (state.me.must_change_password) return renderChangePassword(true);
        if (!location.hash || location.hash === '#/') location.hash = '#/new';
        route_();
      } catch (err) {
        document.getElementById('loginErr').innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
    };
  }

  function renderChangePassword(forced) {
    const body = `
      <div class="${forced ? 'login-wrap' : ''}"><form class="card ${forced ? 'login' : 'narrow'}" id="pwForm">
        <h1>${forced ? 'Set your password' : 'Change password'}</h1>
        ${forced ? '<p class="muted" style="margin-top:0">You signed in with a temporary password. Pick your own to continue.</p>' : ''}
        <div class="field"><label for="cur">${forced ? 'Temporary password' : 'Current password'}</label><input id="cur" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="nw">New password <span class="muted small">(8+ characters)</span></label><input id="nw" type="password" autocomplete="new-password" minlength="8" required></div>
        <div class="field"><label for="nw2">Type it again</label><input id="nw2" type="password" autocomplete="new-password" minlength="8" required></div>
        <div id="pwErr" style="margin-top:.8rem"></div>
        <div class="row" style="margin-top:1rem">
          <button class="btn primary">Save password</button>
          ${forced ? '<button type="button" class="btn" id="pwOut">Sign out</button>' : '<a class="btn" href="#/new">Cancel</a>'}
        </div>
      </form></div>`;
    if (forced) $app.innerHTML = body; else shell(body);
    const form = document.getElementById('pwForm');
    if (forced) document.getElementById('pwOut').onclick = async () => { await api('/logout', { method: 'POST', body: {} }).catch(() => {}); renderLogin(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const err = document.getElementById('pwErr');
      if (form.nw.value !== form.nw2.value) { err.innerHTML = '<div class="alert err">The new passwords don\'t match.</div>'; return; }
      try {
        await api('/me/password', { method: 'POST', body: { current: form.cur.value, next: form.nw.value } });
        await refreshMe();
        toast('Password saved');
        location.hash = '#/new';
        route_();
      } catch (ex) {
        err.innerHTML = `<div class="alert err">${esc(ex.message)}</div>`;
      }
    };
  }

  // ---------- new referral (the easy box) ----------

  async function renderNew() {
    const [settings, ppl] = await Promise.all([api('/settings'), people()]);
    const creditOptions = ppl.credit.filter((p) => p.id !== state.me.id);

    shell(`
      <div class="narrow stack">
        <form class="card quick" id="quickForm" autocomplete="off">
          <div class="row between"><h1 style="margin:0">New referral</h1>
            ${settings.entry_template.trim() ? '<button type="button" class="btn small" id="tplBtn">📝 Use template</button>' : ''}</div>
          <p class="muted" style="margin-top:.3rem">Type or paste the customer's info however you like. Anything extra is kept as notes.</p>
          <textarea id="leadText" placeholder="Jane Smith&#10;512-555-0142&#10;jane@email.com&#10;123 Main St, Austin TX 78701&#10;wants internet + mobile, call after 5" aria-label="Customer info"></textarea>
          <div class="chips" id="chips"></div>
          <div class="row" style="gap:.4rem;margin-bottom:.4rem"><span class="small muted">Services:</span>
            ${SERVICES.map((s) => `<button type="button" class="toggle" data-svc="${s}">${s}</button>`).join('')}</div>
          ${creditOptions.length ? `
            <div class="field" style="margin-top:.6rem"><label for="creditTo" class="small">Entering this for someone else?</label>
              <select id="creditTo"><option value="">No, it's mine</option>${creditOptions.map((p) => `<option value="${p.id}">${esc(p.full_name)}${p.team_name && seesAll() ? ` — ${esc(p.team_name)}` : ''}</option>`).join('')}</select></div>` : ''}
          <div id="fixWrap" hidden>
            <div class="fix-grid" style="margin-top:.6rem">
              <div><label for="f_name">Name</label><input id="f_name"></div>
              <div><label for="f_phone">Phone</label><input id="f_phone" inputmode="tel"></div>
              <div><label for="f_email">Email</label><input id="f_email" inputmode="email" autocapitalize="none"></div>
              <div><label for="f_address">Address</label><input id="f_address"></div>
              <div class="full"><label for="f_notes">Notes</label><textarea id="f_notes" rows="3"></textarea></div>
            </div>
          </div>
          <div id="quickMsg"></div>
          <button class="btn primary big" id="sendBtn" style="margin-top:.6rem">Send referral</button>
          <div class="row between" style="margin-top:.6rem"><button type="button" class="link-btn small" id="fixBtn">Something wrong? Fix the details</button><span class="small muted hide-sm">Ctrl + Enter to send</span></div>
        </form>
        <div class="card">
          <div class="row between"><h2 style="margin:0">My latest referrals</h2><a href="#/referrals?scope=mine" class="small">See all</a></div>
          <ul class="lead-list" id="recent"><li class="muted">Loading…</li></ul>
        </div>
      </div>`);

    const ta = document.getElementById('leadText');
    const chips = document.getElementById('chips');
    const fixWrap = document.getElementById('fixWrap');
    const msg = document.getElementById('quickMsg');
    const fields = ['name', 'phone', 'email', 'address', 'notes'];
    const f = Object.fromEntries(fields.map((k) => [k, document.getElementById('f_' + k)]));
    const touched = new Set();
    const svc = new Set();
    let svcTouched = false;
    let parsed = {};
    ta.focus();

    const drawServices = () => document.querySelectorAll('[data-svc]').forEach((b) => b.classList.toggle('on', svc.has(b.dataset.svc)));
    document.querySelectorAll('[data-svc]').forEach((b) => {
      b.onclick = () => { svcTouched = true; svc.has(b.dataset.svc) ? svc.delete(b.dataset.svc) : svc.add(b.dataset.svc); drawServices(); };
    });

    const drawChips = () => {
      const vals = Object.fromEntries(fields.map((k) => [k, touched.has(k) ? f[k].value : parsed[k] || '']));
      const label = { name: 'Name', phone: 'Phone', email: 'Email', address: 'Address', notes: 'Notes' };
      chips.innerHTML = fields
        .filter((k) => k !== 'notes' || vals.notes)
        .map((k) => `<span class="chip ${vals[k] ? 'on' : ''}">${vals[k] ? '✓' : '○'} ${label[k]}${vals[k] ? `: <b>${esc(vals[k].split('\n')[0])}</b>` : ''}</span>`)
        .join('')
        + (ta.value.trim() && !vals.phone && !vals.email && !vals.address
          ? '<span class="chip warn">Needs a phone, email or address to check for duplicates</span>' : '');
    };

    const doParse = debounce(async () => {
      if (!ta.value.trim()) { parsed = {}; drawChips(); return; }
      try {
        parsed = await api('/parse', { method: 'POST', body: { text: ta.value } });
        for (const k of fields) if (!touched.has(k)) f[k].value = parsed[k] || '';
        if (!svcTouched) { svc.clear(); (parsed.services || []).forEach((s) => svc.add(s)); drawServices(); }
        drawChips();
      } catch { /* ignore */ }
    }, 250);

    ta.addEventListener('input', () => { msg.innerHTML = ''; doParse(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.getElementById('quickForm').requestSubmit(); }
    });
    for (const k of fields) f[k].addEventListener('input', () => { touched.add(k); drawChips(); });
    document.getElementById('fixBtn').onclick = () => { fixWrap.hidden = !fixWrap.hidden; if (!fixWrap.hidden) f.name.focus(); };
    const tplBtn = document.getElementById('tplBtn');
    if (tplBtn) tplBtn.onclick = () => {
      if (ta.value.trim() && !confirm('Replace what you typed with the template?')) return;
      ta.value = settings.entry_template;
      ta.focus();
      // Cursor right after the first "Label: "
      const i = ta.value.indexOf(':');
      if (i >= 0) { const pos = i + (ta.value[i + 1] === ' ' ? 2 : 1); ta.setSelectionRange(pos, pos); }
      doParse();
    };
    drawChips();

    document.getElementById('quickForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = document.getElementById('sendBtn');
      btn.disabled = true;
      msg.innerHTML = '';
      try {
        const body = { text: ta.value, services: [...svc] };
        for (const k of fields) if (touched.has(k) || !fixWrap.hidden) body[k] = f[k].value;
        const credit = document.getElementById('creditTo');
        if (credit && credit.value) body.credit_to = Number(credit.value);
        const ref = await api('/referrals', { method: 'POST', body });
        msg.innerHTML = `<div class="alert ok">✓ Sent! ${esc(leadName(ref))} is in as <b>New</b>${ref.created_by !== state.me.id ? ` for ${esc(ref.created_by_name)}` : ''}. <a href="#/r/${ref.id}">View</a></div>`;
        ta.value = '';
        for (const k of fields) f[k].value = '';
        touched.clear(); parsed = {}; fixWrap.hidden = true; svc.clear(); svcTouched = false;
        if (credit) credit.value = '';
        drawChips(); drawServices();
        loadRecent();
        ta.focus();
      } catch (err) {
        const cls = err.status === 409 ? 'err' : 'warn';
        msg.innerHTML = `<div class="alert ${cls}">${err.status === 409 ? '⛔ ' : ''}${esc(err.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    };

    async function loadRecent() {
      const list = document.getElementById('recent');
      if (!list) return;
      const rows = await api('/referrals?scope=mine&limit=8');
      list.innerHTML = rows.length
        ? rows.map(leadItem).join('')
        : '<li class="muted" style="cursor:default">Nothing yet — your referrals will show up here.</li>';
      bindLeadItems(list);
    }
    loadRecent();
  }

  function leadItem(r) {
    const sub = [r.phone, r.email, r.address].filter(Boolean).join(' · ');
    return `<li data-id="${r.id}"><div class="who"><b>${esc(leadName(r))}</b><span>${esc(sub)}</span></div>
      <div style="text-align:right;flex-shrink:0">${pill(r.status)}<div class="small muted">${when(r.created_at)}</div></div></li>`;
  }
  function bindLeadItems(root) {
    root.querySelectorAll('[data-id]').forEach((el) => { el.onclick = () => { location.hash = '#/r/' + el.dataset.id; }; });
  }

  // ---------- referrals / customers list ----------

  function scopesFor() {
    if (seesAll()) return [['all', 'Everyone'], ['assigned', 'My queue'], ['unassigned', 'Unassigned'], ['mine', 'Entered by me']];
    if (isManager()) return [['team', 'My team'], ['mine', 'Mine']];
    return [];
  }
  const defaultScope = () => (seesAll() ? 'all' : isManager() ? 'team' : 'mine');

  async function renderReferrals() {
    const params = query();
    const scope = params.scope || defaultScope();
    const [ppl, teams] = await Promise.all([people(), seesAll() ? api('/teams') : Promise.resolve([])]);
    const scopes = scopesFor();
    const title = scope === 'assigned' ? 'My queue' : worksLeads() ? 'Customers' : 'My referrals';

    shell(`
      <div class="card">
        <div class="row between" style="margin-bottom:.8rem">
          <h1 style="margin:0">${title}</h1>
          <div class="row">
            ${scopes.length ? `<div class="seg" id="scopeSeg">${scopes.map(([k, l]) => `<button data-k="${k}" class="${scope === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
            <a class="btn small" id="csvBtn" href="#">⬇ Export CSV</a>
          </div>
        </div>
        <div class="filters">
          <input class="q" id="q" placeholder="Search name, phone, email, address, notes, account #" value="${esc(params.q || '')}">
          <select id="st"><option value="">All statuses</option>${STATUSES.map((s) => `<option ${params.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <select id="svc"><option value="">All services</option>${SERVICES.map((s) => `<option ${params.service === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          ${worksLeads() ? `<select id="usr"><option value="">All reps</option>${ppl.credit.filter((u) => !params.team_id || String(u.team_id) === params.team_id).map((u) => `<option value="${u.id}" ${params.user_id === String(u.id) ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>` : ''}
          ${seesAll() ? `<select id="tm"><option value="">All teams</option>${teams.map((t) => `<option value="${t.id}" ${params.team_id === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
          ${seesAll() && scope === 'all' ? `<select id="asg"><option value="">Any dispatcher</option>${ppl.dispatchers.map((u) => `<option value="${u.id}" ${params.assigned_to === String(u.id) ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>` : ''}
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Customer</th><th class="hide-sm">Contact</th><th class="hide-sm">Address</th>${worksLeads() ? '<th class="hide-sm">Rep</th>' : ''}${worksLeads() ? '<th class="hide-sm">Dispatch</th>' : ''}<th>Status</th><th class="hide-sm">Entered</th></tr></thead>
          <tbody id="rows"><tr><td colspan="7" class="muted">Loading…</td></tr></tbody>
        </table></div>
        <p class="small muted" id="count"></p>
      </div>`);

    const setParam = (k, v) => {
      const p = { ...query(), scope };
      if (v) p[k] = v; else delete p[k];
      location.hash = '#/referrals?' + new URLSearchParams(p).toString();
    };
    const seg = document.getElementById('scopeSeg');
    if (seg) seg.querySelectorAll('button').forEach((b) => { b.onclick = () => { location.hash = '#/referrals?scope=' + b.dataset.k; }; });
    for (const [id, key] of [['st', 'status'], ['svc', 'service'], ['usr', 'user_id'], ['tm', 'team_id'], ['asg', 'assigned_to']]) {
      const el = document.getElementById(id);
      if (el) el.onchange = () => setParam(key, el.value);
    }
    const qEl = document.getElementById('q');
    qEl.oninput = debounce(() => load(), 250);
    qEl.onkeydown = (e) => { if (e.key === 'Enter') setParam('q', qEl.value); };

    const currentParams = () => {
      const p = new URLSearchParams({ scope });
      for (const k of ['status', 'service', 'user_id', 'team_id', 'assigned_to']) if (params[k]) p.set(k, params[k]);
      if (qEl.value.trim()) p.set('q', qEl.value.trim());
      return p;
    };
    document.getElementById('csvBtn').onclick = (e) => { e.preventDefault(); location.href = '/api/referrals.csv?' + currentParams().toString(); };

    async function load() {
      const rows = await api('/referrals?' + currentParams().toString());
      const tbody = document.getElementById('rows');
      if (!tbody) return;
      tbody.innerHTML = rows.length ? rows.map((r) => `
        <tr class="click" data-id="${r.id}">
          <td><b>${esc(leadName(r))}</b>${svcTags(r.services)}${r.account_number ? `<div class="small muted">Acct ${esc(r.account_number)}</div>` : ''}${r.comment_count ? `<div class="small muted">💬 ${r.comment_count}</div>` : ''}</td>
          <td class="hide-sm">${esc(r.phone)}<div class="small muted">${esc(r.email)}</div></td>
          <td class="hide-sm small">${esc(r.address)}</td>
          ${worksLeads() ? `<td class="hide-sm small">${esc(r.created_by_name)}${seesAll() && r.team_name ? `<div class="muted">${esc(r.team_name)}</div>` : ''}</td>` : ''}
          ${worksLeads() ? `<td class="hide-sm small">${r.assigned_name ? esc(r.assigned_name) : '<span class="muted">—</span>'}</td>` : ''}
          <td>${pill(r.status)}</td>
          <td class="hide-sm small muted">${when(r.created_at)}</td>
        </tr>`).join('') : '<tr><td colspan="7" class="muted">No referrals match.</td></tr>';
      document.getElementById('count').textContent = `${rows.length}${rows.length === 500 ? '+' : ''} referral${rows.length === 1 ? '' : 's'}`;
      bindLeadItems(tbody);
    }
    load();
  }

  // ---------- kanban board ----------

  async function renderBoard() {
    const params = query();
    const scopes = scopesFor().filter(([k]) => k !== 'mine' || !seesAll());
    const scope = params.scope || defaultScope();
    const closed = params.closed || '30';
    const teams = seesAll() ? await api('/teams') : [];

    shell(`
      <div class="row between" style="margin-bottom:.8rem">
        <h1 style="margin:0">Board</h1>
        <div class="row">
          ${scopes.length ? `<div class="seg" id="scopeSeg">${scopes.map(([k, l]) => `<button data-k="${k}" class="${scope === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
        </div>
      </div>
      <div class="board-filters">
        <input id="q" placeholder="Search…" value="${esc(params.q || '')}">
        ${seesAll() ? `<select id="tm"><option value="">All teams</option>${teams.map((t) => `<option value="${t.id}" ${params.team_id === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
        <select id="closed" title="How far back to show DNQ / Ordered / Cancelled">
          ${[['7', 'Closed: last 7 days'], ['30', 'Closed: last 30 days'], ['90', 'Closed: last 90 days'], ['0', 'Closed: all time']].map(([v, l]) => `<option value="${v}" ${closed === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${worksLeads() ? '<p class="small muted" style="margin:.2rem 0 .8rem">Drag a card to another column to change its status.</p>' : ''}
      <div class="board" id="board">${STATUSES.map((s) => `
        <section class="col" data-status="${s}">
          <header><span class="pill ${s}">${s}</span><span class="n muted small" data-n="${s}"></span></header>
          <div class="cards" data-cards="${s}"><p class="muted small">Loading…</p></div>
        </section>`).join('')}
      </div>`, { wide: true });

    const setParam = (k, v) => {
      const p = { ...query(), scope };
      if (v) p[k] = v; else delete p[k];
      location.hash = '#/board?' + new URLSearchParams(p).toString();
    };
    const seg = document.getElementById('scopeSeg');
    if (seg) seg.querySelectorAll('button').forEach((b) => { b.onclick = () => setParam('scope', b.dataset.k); });
    const tm = document.getElementById('tm'); if (tm) tm.onchange = () => setParam('team_id', tm.value);
    document.getElementById('closed').onchange = (e) => setParam('closed', e.target.value);
    const qEl = document.getElementById('q');
    qEl.oninput = debounce(() => load(), 250);

    let rows = [];
    const card = (r) => {
      const draggable = canMoveCard(r);
      return `<article class="kcard" data-id="${r.id}" ${draggable ? 'draggable="true"' : ''}>
        <div class="row between" style="flex-wrap:nowrap"><b class="kname">${esc(leadName(r))}</b><span class="small muted" style="white-space:nowrap">${when(r.created_at)}</span></div>
        ${r.phone ? `<div class="small">${esc(r.phone)}</div>` : ''}
        ${r.address ? `<div class="small muted kaddr">${esc(r.address)}</div>` : ''}
        ${r.services ? `<div>${svcTags(r.services)}</div>` : ''}
        <div class="kmeta small">
          <span>👤 ${esc(r.created_by_name)}${seesAll() && r.team_name ? ` · ${esc(r.team_name)}` : ''}</span>
          ${r.install_date ? `<span>📅 ${esc(dayDate(r.install_date))}</span>` : ''}
          ${r.comment_count ? `<span>💬 ${r.comment_count}</span>` : ''}
        </div>
        ${worksLeads() ? `<div class="kmeta small">${r.assigned_name ? `<span class="assignee">🎧 ${esc(r.assigned_name)}</span>`
          : `<span class="muted">Unassigned</span>${seesAll() ? `<button class="btn small take" data-take="${r.id}">Take it</button>` : ''}`}</div>` : ''}
      </article>`;
    };

    function draw() {
      for (const s of STATUSES) {
        const list = rows.filter((r) => r.status === s);
        document.querySelector(`[data-cards="${s}"]`).innerHTML = list.map(card).join('') || '<p class="muted small empty">Nothing here</p>';
        document.querySelector(`[data-n="${s}"]`).textContent = list.length;
      }
      document.querySelectorAll('.kcard').forEach((el) => {
        el.onclick = (e) => { if (!e.target.closest('[data-take]')) location.hash = '#/r/' + el.dataset.id; };
        el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', el.dataset.id); el.classList.add('dragging'); };
        el.ondragend = () => el.classList.remove('dragging');
      });
      document.querySelectorAll('[data-take]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          try {
            await api('/referrals/' + b.dataset.take, { method: 'PATCH', body: { assigned_to: state.me.id } });
            const r = rows.find((x) => String(x.id) === b.dataset.take);
            r.assigned_to = state.me.id; r.assigned_name = state.me.full_name;
            draw();
            refreshMe().then(badges).catch(() => {});
            toast('It\'s yours');
          } catch (err) { toast(err.message); }
        };
      });
    }

    document.querySelectorAll('.col').forEach((col) => {
      col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
      col.ondragleave = (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); };
      col.ondrop = async (e) => {
        e.preventDefault();
        col.classList.remove('over');
        const id = e.dataTransfer.getData('text/plain');
        const r = rows.find((x) => String(x.id) === id);
        const to = col.dataset.status;
        if (!r || r.status === to) return;
        const from = r.status;
        r.status = to;
        draw();
        try {
          await api('/referrals/' + id, { method: 'PATCH', body: { status: to } });
          toast(`${leadName(r)} → ${to}`);
        } catch (err) {
          r.status = from;
          draw();
          toast(err.message);
        }
      };
    });

    async function load() {
      const p = new URLSearchParams({ scope, limit: '2000' });
      if (closed !== '0') p.set('closed_days', closed);
      if (params.team_id) p.set('team_id', params.team_id);
      if (qEl.value.trim()) p.set('q', qEl.value.trim());
      rows = await api('/referrals?' + p.toString());
      if (document.getElementById('board')) draw();
    }
    load();
  }

  // ---------- referral detail ----------

  async function renderReferral(id) {
    let r;
    try {
      r = await api('/referrals/' + id);
    } catch (e) {
      shell(`<div class="card narrow"><h1>Not found</h1><p class="muted">${esc(e.message)}</p><a href="#/referrals">Back</a></div>`);
      return;
    }
    const ppl = r.can_assign ? await people() : { dispatchers: [] };
    const editing = state.editing === r.id;
    const rs = new Set((r.services || '').split(',').map((x) => x.trim()).filter(Boolean));
    shell(`
      <p><a href="javascript:history.back()">← Back</a></p>
      <div class="grid-2">
        <div class="stack">
          <div class="card">
            <div class="row between"><h1 style="margin:0">${esc(leadName(r))}</h1>${pill(r.status)}</div>
            <p class="small muted">#${r.id} · ${esc(r.created_by_name)}${r.team_name ? ` (${esc(r.team_name)})` : ''}${r.entered_by && r.entered_by !== r.created_by ? ` · entered by ${esc(r.entered_by_name)}` : ''} · ${fullDate(r.created_at)}</p>
            ${editing ? `
              <form id="editForm">
                <div class="field"><label>Name</label><input name="name" value="${esc(r.customer_name)}"></div>
                <div class="field"><label>Phone</label><input name="phone" value="${esc(r.phone)}"></div>
                <div class="field"><label>Email</label><input name="email" value="${esc(r.email)}"></div>
                <div class="field"><label>Address</label><input name="address" value="${esc(r.address)}"></div>
                <div class="field"><label>Services</label><div class="row" style="gap:.4rem">${SERVICES.map((s) => `<button type="button" class="toggle ${rs.has(s) ? 'on' : ''}" data-esvc="${s}">${s}</button>`).join('')}</div></div>
                <div class="field"><label>Notes</label><textarea name="notes" rows="4">${esc(r.notes)}</textarea></div>
                <div id="editErr" style="margin-top:.6rem"></div>
                <div class="row" style="margin-top:.8rem"><button class="btn primary">Save</button><button type="button" class="btn" id="cancelEdit">Cancel</button></div>
              </form>` : `
              <dl class="kv">
                <dt>Phone</dt><dd>${r.phone ? `<a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>` : '<span class="muted">—</span>'}</dd>
                <dt>Email</dt><dd>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '<span class="muted">—</span>'}</dd>
                <dt>Address</dt><dd>${r.address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(r.address)}" target="_blank" rel="noopener">${esc(r.address)}</a>` : '<span class="muted">—</span>'}</dd>
                <dt>Services</dt><dd>${svcTags(r.services) || '<span class="muted">—</span>'}</dd>
                <dt>Notes</dt><dd style="white-space:pre-wrap">${esc(r.notes) || '<span class="muted">—</span>'}</dd>
                <dt>Account #</dt><dd>${esc(r.account_number) || '<span class="muted">—</span>'}</dd>
                <dt>Install</dt><dd>${r.install_date ? esc(dayDate(r.install_date)) : '<span class="muted">—</span>'}</dd>
                <dt>Dispatch</dt><dd>${r.assigned_name ? esc(r.assigned_name) : '<span class="muted">Unassigned</span>'}</dd>
                <dt>Updated</dt><dd>${fullDate(r.updated_at)}</dd>
              </dl>
              ${r.raw_text ? `<details class="raw"><summary class="small">Original entry</summary><pre>${esc(r.raw_text)}</pre></details>` : ''}
              ${r.can_edit ? '<button class="btn small" id="editBtn" style="margin-top:.8rem">Edit details</button>' : ''}`}
          </div>
          ${r.can_manage ? `
          <div class="card">
            <h2>Update status</h2>
            <div class="seg" id="statusSeg" style="margin-bottom:.9rem">${STATUSES.map((s) => `<button data-s="${s}" class="${r.status === s ? 'on' : ''}">${s}</button>`).join('')}</div>
            <form id="acctForm" class="fix-grid" style="margin:0">
              <div><label for="acct">Spectrum account / order #</label><input id="acct" name="acct" value="${esc(r.account_number)}"></div>
              <div><label for="inst">Install date</label><input id="inst" name="inst" type="date" value="${esc(r.install_date)}"></div>
              <div class="full"><button class="btn">Save</button></div>
            </form>
          </div>` : ''}
          ${r.can_assign ? `
          <div class="card">
            <h2>Dispatch</h2>
            <div class="row">
              <select id="assignSel" style="flex:1;width:auto;min-width:0"><option value="">Unassigned</option>${ppl.dispatchers.map((d) => `<option value="${d.id}" ${r.assigned_to === d.id ? 'selected' : ''}>${esc(d.full_name)}${d.role === 'admin' ? ' (admin)' : ''}</option>`).join('')}</select>
              ${r.assigned_to !== state.me.id ? '<button class="btn primary" id="takeBtn">Take it</button>' : ''}
            </div>
          </div>` : ''}
          <div class="card">
            <h2>History</h2>
            <ul class="timeline">${r.history.map((h) => `<li>${fullDate(h.created_at)} — ${esc(h.full_name)} ${h.from_status ? `changed <b>${esc(h.from_status)}</b> → <b>${esc(h.to_status)}</b>` : 'entered the referral'}</li>`).join('')}</ul>
          </div>
        </div>
        <div class="card">
          <h2>Comments</h2>
          <p class="small muted" style="margin-top:0">Something not adding up? Leave a note. Type <b>@</b> to tag someone.</p>
          <div id="comments">${r.comments.length ? r.comments.map((c) => `
            <div class="comment"><div class="meta"><b>${esc(c.full_name)}</b> · ${when(c.created_at)}</div><p>${highlightMentions(c.body)}</p></div>`).join('') : '<p class="muted">No comments yet.</p>'}
          </div>
          <form id="commentForm" style="margin-top:1rem">
            <textarea id="commentBody" rows="3" placeholder="e.g. @dispatch address doesn't match the account"></textarea>
            <div id="mentionBox"></div>
            <button class="btn primary" style="margin-top:.5rem">Post comment</button>
          </form>
        </div>
      </div>`);

    const editBtn = document.getElementById('editBtn');
    if (editBtn) editBtn.onclick = () => { state.editing = r.id; renderReferral(id); };
    const editForm = document.getElementById('editForm');
    if (editForm) {
      document.querySelectorAll('[data-esvc]').forEach((b) => { b.onclick = () => b.classList.toggle('on'); });
      document.getElementById('cancelEdit').onclick = () => { state.editing = null; renderReferral(id); };
      editForm.onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(editForm));
        fd.services = [...document.querySelectorAll('[data-esvc].on')].map((b) => b.dataset.esvc);
        try {
          await api('/referrals/' + r.id, { method: 'PATCH', body: fd });
          state.editing = null;
          toast('Saved');
          renderReferral(id);
        } catch (err) {
          document.getElementById('editErr').innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
        }
      };
    }
    const seg = document.getElementById('statusSeg');
    if (seg) seg.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.s === r.status) return;
        try {
          await api('/referrals/' + r.id, { method: 'PATCH', body: { status: b.dataset.s } });
          toast(`Marked ${b.dataset.s}`);
          renderReferral(id);
        } catch (err) { toast(err.message); }
      };
    });
    const acctForm = document.getElementById('acctForm');
    if (acctForm) acctForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/referrals/' + r.id, { method: 'PATCH', body: { account_number: acctForm.acct.value, install_date: acctForm.inst.value } });
        toast('Saved');
        renderReferral(id);
      } catch (err) { toast(err.message); }
    };
    const assignSel = document.getElementById('assignSel');
    const assign = async (to) => {
      try {
        await api('/referrals/' + r.id, { method: 'PATCH', body: { assigned_to: to } });
        await refreshMe();
        toast(to ? 'Assigned' : 'Unassigned');
        renderReferral(id);
      } catch (err) { toast(err.message); }
    };
    if (assignSel) assignSel.onchange = () => assign(assignSel.value ? Number(assignSel.value) : null);
    const takeBtn = document.getElementById('takeBtn');
    if (takeBtn) takeBtn.onclick = () => assign(state.me.id);

    setupMentions(document.getElementById('commentBody'), document.getElementById('mentionBox'), r.mentionable);
    document.getElementById('commentForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = document.getElementById('commentBody').value.trim();
      if (!body) return;
      try {
        await api(`/referrals/${r.id}/comments`, { method: 'POST', body: { body } });
        renderReferral(id);
      } catch (err) { toast(err.message); }
    };
  }

  function setupMentions(ta, box, ppl) {
    let matches = [];
    let sel = 0;
    const current = () => {
      const upto = ta.value.slice(0, ta.selectionStart);
      const m = upto.match(/@([A-Za-z0-9._-]*)$/);
      return m ? { q: m[1].toLowerCase(), start: upto.length - m[0].length } : null;
    };
    const draw = () => {
      const c = current();
      matches = c ? ppl.filter((p) => p.username.toLowerCase().startsWith(c.q) || p.full_name.toLowerCase().includes(c.q)).slice(0, 6) : [];
      if (sel >= matches.length) sel = 0;
      box.innerHTML = matches.length ? `<div class="mention-suggest">${matches.map((p, i) => `<button type="button" data-i="${i}" class="${i === sel ? 'on' : ''}"><b>${esc(p.full_name)}</b> <span class="muted">@${esc(p.username)}</span></button>`).join('')}</div>` : '';
      box.querySelectorAll('button').forEach((b) => { b.onmousedown = (e) => { e.preventDefault(); pick(Number(b.dataset.i)); }; });
    };
    const pick = (i) => {
      const c = current();
      if (!c || !matches[i]) return;
      const before = ta.value.slice(0, c.start);
      const after = ta.value.slice(ta.selectionStart);
      ta.value = `${before}@${matches[i].username} ${after}`;
      const pos = before.length + matches[i].username.length + 2;
      ta.setSelectionRange(pos, pos);
      ta.focus();
      matches = [];
      box.innerHTML = '';
    };
    ta.addEventListener('input', draw);
    ta.addEventListener('click', draw);
    ta.addEventListener('keydown', (e) => {
      if (!matches.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % matches.length; draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + matches.length) % matches.length; draw(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(sel); }
      else if (e.key === 'Escape') { matches = []; box.innerHTML = ''; }
    });
    ta.addEventListener('blur', () => setTimeout(() => { box.innerHTML = ''; }, 150));
  }

  // ---------- duplicates log ----------

  async function renderDuplicates() {
    if (!seesAll()) { location.hash = '#/new'; return; }
    const rows = await api('/duplicates');
    shell(`
      <div class="card">
        <h1>Blocked duplicates</h1>
        <p class="muted small" style="margin-top:0">Every time someone tries to enter a lead that already exists. Reps only ever see "This lead is a duplicate" — this page is just for admins and dispatch.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Tried by</th><th>What they entered</th><th>Matched on</th><th>Existing lead</th></tr></thead>
          <tbody>${rows.map((d) => `
            <tr>
              <td class="small muted" style="white-space:nowrap">${when(d.created_at)}</td>
              <td><b>${esc(d.attempted_by_name)}</b>${d.attempted_by_team ? `<div class="small muted">${esc(d.attempted_by_team)}</div>` : ''}</td>
              <td class="small">${esc(d.customer_name || '—')}<div class="muted">${esc([d.phone, d.email, d.address].filter(Boolean).join(' · '))}</div></td>
              <td><span class="tag">${esc(d.matched_on)}</span></td>
              <td>${d.matched_referral_id ? `<a href="#/r/${d.matched_referral_id}">${esc(d.matched_name || 'No name')}</a> ${pill(d.matched_status)}<div class="small muted">${esc(d.matched_owner_name || '')}${d.matched_owner_team ? ` · ${esc(d.matched_owner_team)}` : ''}</div>` : '<span class="muted">deleted</span>'}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="muted">No duplicates blocked yet.</td></tr>'}</tbody>
        </table></div>
      </div>`);
  }

  // ---------- sales ----------

  function rangeFor(key) {
    const d = new Date();
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    if (key === 'today') return { from: iso(d), to: iso(d) };
    if (key === 'week') { const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return { from: iso(s), to: iso(d) }; }
    if (key === 'month') return { from: iso(new Date(d.getFullYear(), d.getMonth(), 1)), to: iso(d) };
    if (key === 'lastmonth') {
      return { from: iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: iso(new Date(d.getFullYear(), d.getMonth(), 0)) };
    }
    return {};
  }

  function statTiles(c) {
    return `<div class="stats">
      <div class="stat"><div class="n">${c.total}</div><div class="l">Total</div></div>
      ${STATUSES.map((s) => `<div class="stat ${s}"><div class="n">${c[s]}</div><div class="l">${s}</div></div>`).join('')}
    </div>`;
  }

  function countTable(rows, firstCol, nameOf, attrs = () => '') {
    return `<div class="table-wrap"><table>
      <thead><tr><th>${firstCol}</th>${STATUSES.map((s) => `<th class="num">${s}</th>`).join('')}<th class="num">Total</th></tr></thead>
      <tbody>${rows.map((u) => `<tr ${attrs(u)}><td>${nameOf(u)}</td>${STATUSES.map((s) => `<td class="num">${u[s]}</td>`).join('')}<td class="num"><b>${u.total}</b></td></tr>`).join('') || `<tr><td colspan="${STATUSES.length + 2}" class="muted">Nothing yet.</td></tr>`}</tbody>
    </table></div>`;
  }
  const repName = (u) => `<b>${esc(u.full_name)}</b>${u.role !== 'rep' ? ` <span class="small muted">${roleLabel(u.role)}</span>` : ''}`;

  async function renderSales() {
    const params = query();
    const period = params.period || 'month';
    const qs = new URLSearchParams(rangeFor(period));
    if (params.team_id) qs.set('team_id', params.team_id);
    const s = await api('/stats?' + qs.toString());
    const periods = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['all', 'All time']];
    const listScope = seesAll() ? 'all' : 'team';

    shell(`
      <div class="row between" style="margin-bottom:1rem">
        <h1 style="margin:0">Sales</h1>
        <div class="seg" id="periodSeg">${periods.map(([k, l]) => `<button data-k="${k}" class="${period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
      ${role() !== 'dispatch' ? `<div class="card"><h2>My sales</h2>${statTiles(s.me)}</div>` : ''}
      ${s.team ? `<div class="card"><h2>Team: ${esc(s.team.name)}</h2>${statTiles(s.team.totals)}<h2 style="margin-top:1.2rem">By rep</h2>
        ${countTable(s.team.users, 'Rep', repName, (u) => (worksLeads() ? `class="click" data-user="${u.id}"` : ''))}</div>` : ''}
      ${s.teams ? `<div class="card"><h2>All teams</h2>${statTiles(s.all)}
        <div style="margin-top:1rem">${countTable(s.teams, 'Team', (t) => `<b>${esc(t.name)}</b>`, (t) => `class="click" data-team="${t.id}"`)}</div>
        <p class="small muted">Click a team to see its reps.</p></div>` : ''}
      ${s.selectedTeam ? `<div class="card"><h2>${esc(s.selectedTeam.name)} — by rep</h2>${countTable(s.selectedTeam.users, 'Rep', repName, (u) => `class="click" data-user="${u.id}"`)}</div>` : ''}
      ${s.dispatchers ? `<div class="card"><div class="row between"><h2>Dispatch</h2>${s.unassigned ? `<a class="small" href="#/referrals?scope=unassigned">${s.unassigned} open lead${s.unassigned === 1 ? '' : 's'} unassigned</a>` : ''}</div>
        ${countTable(s.dispatchers, 'Dispatcher', repName, (u) => `class="click" data-assignee="${u.id}"`)}</div>` : ''}
      ${s.services ? `<div class="card"><h2>By service</h2>${countTable(s.services, 'Service', (x) => `<b>${esc(x.service)}</b>`)}</div>` : ''}`);

    document.querySelectorAll('#periodSeg button').forEach((b) => {
      b.onclick = () => { location.hash = '#/sales?' + new URLSearchParams({ ...params, period: b.dataset.k }).toString(); };
    });
    document.querySelectorAll('[data-team]').forEach((el) => {
      el.onclick = () => { location.hash = '#/sales?' + new URLSearchParams({ ...params, period, team_id: el.dataset.team }).toString(); };
    });
    document.querySelectorAll('[data-user]').forEach((el) => {
      el.onclick = () => { location.hash = `#/referrals?scope=${listScope}&user_id=${el.dataset.user}`; };
    });
    document.querySelectorAll('[data-assignee]').forEach((el) => {
      el.onclick = () => { location.hash = `#/referrals?scope=all&assigned_to=${el.dataset.assignee}`; };
    });
  }

  // ---------- team / users ----------

  async function renderTeam() {
    if (!managesUsers()) { location.hash = '#/new'; return; }
    const [users, teams, settings] = await Promise.all([api('/users'), api('/teams'), isAdmin() ? api('/settings') : Promise.resolve(null)]);
    const flash = state.flash; state.flash = null;
    const roles = ['rep', 'manager', 'dispatch', 'admin'];

    shell(`
      ${flash ? `<div class="card" style="border-color:var(--ok)"><div class="alert ok" style="margin-bottom:.6rem">${esc(flash.title)}</div>
        <p style="margin:0 0 .4rem">Give <b>${esc(flash.username)}</b> this temporary password. They'll pick their own when they sign in:</p>
        <span class="secret">${esc(flash.password)}</span> <button class="btn small" id="copyPw">Copy</button></div>` : ''}
      <div class="grid-2">
        <form class="card" id="addUser">
          <h2>Add a ${isAdmin() ? 'user' : 'rep to ' + esc(state.me.team_name || 'your team')}</h2>
          <div class="field"><label for="au_name">Full name</label><input id="au_name" name="full_name" required></div>
          <div class="field"><label for="au_user">Username</label><input id="au_user" name="username" autocapitalize="none" placeholder="e.g. jsmith" required></div>
          <div class="field"><label for="au_email">Email <span class="muted small">(optional, for alerts)</span></label><input id="au_email" name="email" type="email" autocapitalize="none"></div>
          ${isAdmin() ? `
            <div class="field"><label for="au_role">Role</label><select id="au_role" name="role">${roles.map((r) => `<option value="${r}">${roleLabel(r)}</option>`).join('')}</select>
              <p class="small muted" style="margin:.3rem 0 0" id="roleHelp"></p></div>
            <div class="field"><label for="au_team">Team</label><select id="au_team" name="team_id"><option value="">— none (admin & dispatch only) —</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>` : ''}
          <div id="addErr" style="margin-top:.6rem"></div>
          <button class="btn primary" style="margin-top:.8rem">Add user</button>
          <p class="small muted" style="margin-bottom:0">A temporary password is created for them.</p>
        </form>
        ${isAdmin() ? `
        <div class="card">
          <h2>Teams</h2>
          <ul class="lead-list">${teams.map((t) => `<li style="cursor:default"><div class="who"><b>${esc(t.name)}</b><span>${t.members} active member${t.members === 1 ? '' : 's'}</span></div><button class="btn small" data-rename="${t.id}" data-name="${esc(t.name)}">Rename</button></li>`).join('') || '<li class="muted">No teams yet — add one below.</li>'}</ul>
          <form class="row" id="addTeam" style="margin-top:.8rem"><input name="name" placeholder="New team name" style="flex:1;width:auto;min-width:0" required><button class="btn">Add team</button></form>
        </div>` : `
        <div class="card"><h2>Tips</h2><p class="muted small">Reps sign in with the username and temporary password you give them.<br>If someone forgets their password, hit <b>Reset password</b> and give them the new one.<br>Deactivated users can't sign in, but their sales stay on the books.</p></div>`}
      </div>
      ${isAdmin() ? `
      <div class="grid-2">
        <form class="card" id="settingsForm">
          <h2>Settings</h2>
          <label class="check"><input type="checkbox" name="auto_assign" ${settings.auto_assign === '1' ? 'checked' : ''}> Automatically assign new leads to dispatch</label>
          <p class="small muted" style="margin:.2rem 0 1rem">Each new lead goes to the active dispatcher with the fewest open leads. Off: leads wait in <b>Unassigned</b> until someone takes them.</p>
          <label for="tpl">Entry template</label>
          <textarea id="tpl" name="entry_template" rows="7" style="font-family:ui-monospace,Menlo,monospace;font-size:.9rem">${esc(settings.entry_template)}</textarea>
          <p class="small muted" style="margin:.3rem 0 .8rem">Reps can tap <b>Use template</b> to fill the entry box with this. Use labels like Name:, Phone:, Email:, Address:, City:, Zip:, Services:, Notes: — any other label is kept in the notes.</p>
          <button class="btn primary">Save settings</button>
        </form>
        <div class="card">
          <h2>Email alerts</h2>
          <div id="emailStatus" class="small muted">Checking…</div>
          <h2 style="margin-top:1.4rem">Backup</h2>
          <p class="small muted" style="margin-top:0">Download a full copy of all referrals, users and comments. Keep it somewhere safe.</p>
          <a class="btn small" href="/api/admin/backup" download>⬇ Download backup</a>
          <h2 style="margin-top:1.4rem">Export</h2>
          <p class="small muted" style="margin-top:0">All referrals as a spreadsheet (CSV). Filtered exports are on the Customers page.</p>
          <a class="btn small" href="/api/referrals.csv?scope=all">⬇ Export all referrals</a>
        </div>
      </div>` : ''}
      <div class="card">
        <h2>${isAdmin() ? 'All users' : 'Team members'}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Role</th>${isAdmin() ? '<th>Team</th>' : ''}<th class="num">Referrals</th><th class="num">Ordered</th>${isAdmin() ? '<th class="num">Queue</th>' : ''}<th></th></tr></thead>
          <tbody>${users.map((u) => {
            const manageable = isAdmin() || (u.role === 'rep');
            const self = u.id === state.me.id;
            return `<tr style="${u.active ? '' : 'opacity:.55'}">
              <td><b>${esc(u.full_name)}</b><div class="small muted">@${esc(u.username)}${u.active ? '' : ' · deactivated'}${u.must_change_password ? ' · temp password' : ''}</div>
                <div class="small">${u.email ? esc(u.email) : '<span class="muted">no email</span>'}${manageable ? ` <button class="link-btn small" data-email="${u.id}" data-current="${esc(u.email)}">edit</button>` : ''}</div></td>
              <td>${isAdmin() && !self ? `<select data-role="${u.id}" style="width:auto">${roles.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}</select>` : roleLabel(u.role)}</td>
              ${isAdmin() ? `<td><select data-team="${u.id}" style="width:auto"><option value="">—</option>${teams.map((t) => `<option value="${t.id}" ${u.team_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>` : ''}
              <td class="num"><a href="#/referrals?scope=${isAdmin() ? 'all' : 'team'}&user_id=${u.id}">${u.referral_count}</a></td>
              <td class="num">${u.ordered_count}</td>
              ${isAdmin() ? `<td class="num">${u.role === 'dispatch' || u.open_assigned ? `<a href="#/referrals?scope=all&assigned_to=${u.id}">${u.open_assigned}</a>` : ''}</td>` : ''}
              <td style="white-space:nowrap;text-align:right">${manageable && !self ? `
                <button class="btn small" data-reset="${u.id}" data-username="${esc(u.username)}">Reset password</button>
                <button class="btn small ${u.active ? 'danger' : ''}" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>`);

    const emailStatus = document.getElementById('emailStatus');
    if (emailStatus) {
      const cfg = await api('/admin/email');
      emailStatus.innerHTML = cfg.enabled
        ? `<p style="margin:0 0 .6rem"><b style="color:var(--ok)">On.</b> Sending from <b>${esc(cfg.from)}</b>.${cfg.app_url ? '' : ' Links in emails are off until APP_URL is set.'}</p>
           <button class="btn small" id="testEmail">✉ Send me a test email</button><span id="testRes" style="margin-left:.5rem"></span>`
        : `<p style="margin:0"><b>Off.</b> In Render, open your service → <b>Environment</b> and add <code>RESEND_API_KEY</code> (and <code>EMAIL_FROM</code>, e.g. <code>E&amp;O Referrals &lt;alerts@yourdomain.com&gt;</code>). The app restarts and alerts switch on.</p>`;
      const tb = document.getElementById('testEmail');
      if (tb) tb.onclick = async () => {
        const out = document.getElementById('testRes');
        tb.disabled = true;
        try {
          const r = await api('/admin/test-email', { method: 'POST', body: {} });
          out.innerHTML = `<span style="color:var(--ok)">Sent to ${esc(r.to)} ✓</span>`;
        } catch (err) {
          out.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
        } finally { tb.disabled = false; }
      };
    }
    document.querySelectorAll('[data-email]').forEach((b) => {
      b.onclick = async () => {
        const email = prompt('Email address (leave empty to remove)', b.dataset.current);
        if (email === null) return;
        try { await api('/users/' + b.dataset.email, { method: 'PATCH', body: { email } }); toast('Email saved'); renderTeam(); } catch (err) { toast(err.message); }
      };
    });

    const copy = document.getElementById('copyPw');
    if (copy) copy.onclick = () => { navigator.clipboard?.writeText(flash.password); toast('Copied'); };

    const roleSel = document.getElementById('au_role');
    if (roleSel) {
      const help = {
        rep: 'Enters referrals and sees only their own.',
        manager: 'Sees and works their team\'s leads, adds reps, resets their passwords.',
        dispatch: 'Sees every lead from every team, gets leads assigned, updates statuses. No team needed.',
        admin: 'Full access, including users, teams and settings.',
      };
      const upd = () => { document.getElementById('roleHelp').textContent = help[roleSel.value]; };
      roleSel.onchange = upd; upd();
    }

    document.getElementById('addUser').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api('/users', { method: 'POST', body });
        peopleCache = null;
        state.flash = { title: `${body.full_name} was added.`, username: r.username, password: r.temp_password };
        renderTeam();
      } catch (err) {
        document.getElementById('addErr').innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
    };
    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) settingsForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/settings', { method: 'PATCH', body: { auto_assign: settingsForm.auto_assign.checked, entry_template: settingsForm.entry_template.value } });
        toast('Settings saved');
      } catch (err) { toast(err.message); }
    };
    const addTeam = document.getElementById('addTeam');
    if (addTeam) addTeam.onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/teams', { method: 'POST', body: { name: addTeam.name.value } }); toast('Team added'); renderTeam(); } catch (err) { toast(err.message); }
    };
    document.querySelectorAll('[data-rename]').forEach((b) => {
      b.onclick = async () => {
        const name = prompt('New team name', b.dataset.name);
        if (!name) return;
        try { await api('/teams/' + b.dataset.rename, { method: 'PATCH', body: { name } }); renderTeam(); } catch (err) { toast(err.message); }
      };
    });
    document.querySelectorAll('[data-reset]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Reset the password for @${b.dataset.username}? Their current password will stop working.`)) return;
        try {
          const r = await api(`/users/${b.dataset.reset}/reset-password`, { method: 'POST', body: {} });
          state.flash = { title: 'Password reset.', username: b.dataset.username, password: r.temp_password };
          renderTeam();
          window.scrollTo(0, 0);
        } catch (err) { toast(err.message); }
      };
    });
    document.querySelectorAll('[data-active]').forEach((b) => {
      b.onclick = async () => {
        try { await api('/users/' + b.dataset.active, { method: 'PATCH', body: { active: b.dataset.to === '1' } }); peopleCache = null; renderTeam(); } catch (err) { toast(err.message); }
      };
    });
    document.querySelectorAll('select[data-role]').forEach((s) => {
      s.onchange = async () => { try { await api('/users/' + s.dataset.role, { method: 'PATCH', body: { role: s.value } }); peopleCache = null; toast('Role updated'); renderTeam(); } catch (err) { toast(err.message); } };
    });
    document.querySelectorAll('select[data-team]').forEach((s) => {
      s.onchange = async () => { try { await api('/users/' + s.dataset.team, { method: 'PATCH', body: { team_id: s.value || null } }); peopleCache = null; toast('Team updated'); } catch (err) { toast(err.message); } };
    });
  }

  // ---------- my account ----------

  async function renderAccount() {
    const me = state.me;
    shell(`
      <form class="card narrow" id="acctForm">
        <h1>My account</h1>
        <p class="muted" style="margin-top:0">${esc(me.full_name)} · @${esc(me.username)} · ${roleLabel(me.role)}${me.team_name ? ` · ${esc(me.team_name)}` : ''}</p>
        <div class="field"><label for="em">Email</label><input id="em" type="email" autocapitalize="none" placeholder="you@example.com" value="${esc(me.email)}"></div>
        <label class="check" style="margin-top:.9rem"><input type="checkbox" id="ea" ${me.email_alerts ? 'checked' : ''}> Email me my alerts</label>
        <p class="small muted" style="margin:.3rem 0 0">Status changes on your leads, @mentions, comments on your leads, and leads assigned to you or entered for you.</p>
        ${me.email_enabled ? '' : '<div class="alert warn small" style="margin-top:.8rem">Email alerts aren\'t switched on for this app yet. You\'ll still see everything under 🔔.</div>'}
        <div id="acctErr" style="margin-top:.8rem"></div>
        <div class="row" style="margin-top:1rem"><button class="btn primary">Save</button><button type="button" class="btn" id="pwBtn">Change password</button></div>
      </form>`);
    document.getElementById('pwBtn').onclick = () => renderChangePassword(false);
    document.getElementById('acctForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/me', { method: 'PATCH', body: { email: document.getElementById('em').value, email_alerts: document.getElementById('ea').checked } });
        await refreshMe();
        toast('Saved');
      } catch (err) {
        document.getElementById('acctErr').innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
    };
  }

  // ---------- notifications ----------

  async function renderNotifications() {
    const items = await api('/notifications');
    shell(`
      <div class="card narrow" style="padding:0">
        <div class="row between" style="padding:1rem 1rem .5rem"><h1 style="margin:0">Notifications</h1>${items.some((n) => !n.read) ? '<button class="btn small" id="readAll">Mark all read</button>' : ''}</div>
        ${items.length ? items.map((n) => `<a class="notif ${n.read ? '' : 'unread'}" data-n="${n.id}" href="${n.referral_id ? '#/r/' + n.referral_id : '#/notifications'}">${highlightMentions(n.message)}<div class="when">${when(n.created_at)}</div></a>`).join('') : '<p class="muted" style="padding:0 1rem 1rem">You\'re all caught up.</p>'}
      </div>`);
    const ra = document.getElementById('readAll');
    if (ra) ra.onclick = async () => { await api('/notifications/read', { method: 'POST', body: {} }); await refreshMe(); renderNotifications(); };
    document.querySelectorAll('[data-n]').forEach((a) => {
      a.addEventListener('click', () => { api('/notifications/read', { method: 'POST', body: { id: Number(a.dataset.n) } }).then(refreshMe).catch(() => {}); });
    });
  }

  // ---------- router ----------

  async function route_() {
    if (!state.me) return renderLogin();
    if (state.me.must_change_password) return renderChangePassword(true);
    const h = location.hash.split('?')[0] || '#/new';
    try {
      let m;
      if ((m = h.match(/^#\/r\/(\d+)$/))) return await renderReferral(m[1]);
      if (h === '#/referrals') return await renderReferrals();
      if (h === '#/board') return await renderBoard();
      if (h === '#/duplicates') return await renderDuplicates();
      if (h === '#/sales') return await renderSales();
      if (h === '#/team') return await renderTeam();
      if (h === '#/notifications') return await renderNotifications();
      if (h === '#/account') return await renderAccount();
      return await renderNew();
    } catch (e) {
      if (state.me) toast(e.message);
    }
  }

  window.addEventListener('hashchange', async () => {
    state.menuOpen = false;
    if (state.me) await refreshMe().catch(() => {});
    if (!location.hash.startsWith('#/r/')) state.editing = null;
    route_();
  });

  // Keep the notification and queue badges fresh.
  setInterval(async () => {
    if (!state.me || document.hidden) return;
    try {
      await refreshMe();
      badges();
    } catch { /* ignore */ }
  }, 30000);

  (async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.ok) state.me = await res.json();
    } catch { /* offline */ }
    route_();
  })();
})();
