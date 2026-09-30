'use strict';

(() => {
  const $app = document.getElementById('app');
  const state = { me: null, menuOpen: false };
  const STATUSES = ['New', 'Passed', 'DNQ', 'Ordered', 'Cancelled'];

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

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    const diff = (Date.now() - d) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  }
  const fullDate = (iso) => (iso ? new Date(iso.replace(' ', 'T') + 'Z').toLocaleString() : '');
  const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
  const isMgr = () => state.me && (state.me.role === 'manager' || state.me.role === 'admin');
  const isAdmin = () => state.me && state.me.role === 'admin';
  const roleLabel = (r) => ({ admin: 'Admin', manager: 'Manager', rep: 'Rep' }[r] || r);

  function highlightMentions(text) {
    return esc(text).replace(/@([A-Za-z0-9._-]+)/g, '<span class="mention">@$1</span>');
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ---------- shell ----------

  function navLinks() {
    const links = [
      ['#/new', 'New Referral'],
      ['#/referrals', isMgr() ? 'Customers' : 'My Referrals'],
      ['#/sales', 'Sales'],
    ];
    if (isMgr()) links.push(['#/team', isAdmin() ? 'Users & Teams' : 'My Team']);
    return links;
  }

  function shell(content) {
    const route = location.hash.split('?')[0] || '#/new';
    const me = state.me;
    $app.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#/new"><span class="logo">E&amp;O</span><span>E&amp;O Spectrum Referrals<small>${esc(me.team_name || (isAdmin() ? 'All teams' : ''))}</small></span></a>
        <nav class="nav">${navLinks().map(([h, l]) => `<a href="${h}" class="${route.startsWith(h) || (h === '#/referrals' && route.startsWith('#/r/')) ? 'active' : ''}">${l}</a>`).join('')}</nav>
        <div class="top-actions">
          <a class="icon-btn" href="#/notifications" title="Notifications" aria-label="Notifications">🔔${me.unread ? `<span class="badge">${me.unread > 99 ? '99+' : me.unread}</span>` : ''}</a>
          <div class="menu">
            <button class="icon-btn" id="menuBtn" aria-label="Account">👤</button>
            ${state.menuOpen ? `<div class="menu-pop">
              <div class="who"><b>${esc(me.full_name)}</b><div class="small muted">@${esc(me.username)} · ${roleLabel(me.role)}</div></div>
              <button id="changePwBtn">Change password</button>
              <button id="logoutBtn">Sign out</button>
            </div>` : ''}
          </div>
        </div>
      </div></header>
      <main>${content}</main>`;
    document.getElementById('menuBtn').onclick = (e) => { e.stopPropagation(); state.menuOpen = !state.menuOpen; route_(); };
    if (state.menuOpen) {
      document.getElementById('logoutBtn').onclick = async () => {
        await api('/logout', { method: 'POST', body: {} }).catch(() => {});
        state.me = null; state.menuOpen = false;
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
    shell(`
      <div class="narrow stack">
        <form class="card quick" id="quickForm" autocomplete="off">
          <h1>New referral</h1>
          <p class="muted" style="margin-top:0">Just type or paste the customer's info — any order, any format.</p>
          <textarea id="leadText" placeholder="Jane Smith&#10;512-555-0142&#10;jane@email.com&#10;123 Main St, Austin TX 78701&#10;wants internet + mobile" aria-label="Customer info"></textarea>
          <div class="chips" id="chips"></div>
          <div id="fixWrap" hidden>
            <div class="fix-grid">
              <div><label for="f_name">Name</label><input id="f_name"></div>
              <div><label for="f_phone">Phone</label><input id="f_phone" inputmode="tel"></div>
              <div><label for="f_email">Email</label><input id="f_email" inputmode="email" autocapitalize="none"></div>
              <div><label for="f_address">Address</label><input id="f_address"></div>
              <div class="full"><label for="f_notes">Notes</label><input id="f_notes"></div>
            </div>
          </div>
          <div id="quickMsg"></div>
          <button class="btn primary big" id="sendBtn" style="margin-top:.6rem">Send referral</button>
          <div style="text-align:center;margin-top:.6rem"><button type="button" class="link-btn small" id="fixBtn">Something wrong? Fix the details</button></div>
        </form>
        <div class="card">
          <div class="row between"><h2 style="margin:0">My latest referrals</h2><a href="#/referrals" class="small">See all</a></div>
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
    let parsed = {};
    ta.focus();

    const drawChips = () => {
      const vals = Object.fromEntries(fields.map((k) => [k, touched.has(k) ? f[k].value : parsed[k] || '']));
      const label = { name: 'Name', phone: 'Phone', email: 'Email', address: 'Address', notes: 'Notes' };
      chips.innerHTML = fields
        .filter((k) => k !== 'notes' || vals.notes)
        .map((k) => `<span class="chip ${vals[k] ? 'on' : ''}">${vals[k] ? '✓' : '○'} ${label[k]}${vals[k] ? `: <b>${esc(vals[k])}</b>` : ''}</span>`)
        .join('');
    };

    const doParse = debounce(async () => {
      if (!ta.value.trim()) { parsed = {}; drawChips(); return; }
      try {
        parsed = await api('/parse', { method: 'POST', body: { text: ta.value } });
        for (const k of fields) if (!touched.has(k)) f[k].value = parsed[k] || '';
        drawChips();
      } catch { /* ignore */ }
    }, 250);

    ta.addEventListener('input', () => { msg.innerHTML = ''; doParse(); });
    for (const k of fields) f[k].addEventListener('input', () => { touched.add(k); drawChips(); });
    document.getElementById('fixBtn').onclick = () => { fixWrap.hidden = !fixWrap.hidden; if (!fixWrap.hidden) f.name.focus(); };
    drawChips();

    document.getElementById('quickForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = document.getElementById('sendBtn');
      btn.disabled = true;
      msg.innerHTML = '';
      try {
        const body = { text: ta.value };
        for (const k of fields) if (touched.has(k) || !fixWrap.hidden) body[k] = f[k].value;
        const ref = await api('/referrals', { method: 'POST', body });
        msg.innerHTML = `<div class="alert ok">✓ Sent! ${esc(ref.customer_name)} is in as <b>New</b>. <a href="#/r/${ref.id}">View</a></div>`;
        ta.value = '';
        for (const k of fields) f[k].value = '';
        touched.clear(); parsed = {}; fixWrap.hidden = true;
        drawChips();
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
      const rows = await api('/referrals?scope=mine');
      list.innerHTML = rows.length
        ? rows.slice(0, 8).map(leadItem).join('')
        : '<li class="muted" style="cursor:default">Nothing yet — your referrals will show up here.</li>';
      bindLeadItems(list);
    }
    loadRecent();
  }

  function leadItem(r) {
    const sub = [r.phone, r.email, r.address].filter(Boolean).join(' · ');
    return `<li data-id="${r.id}"><div class="who"><b>${esc(r.customer_name)}</b><span>${esc(sub)}</span></div>
      <div style="text-align:right;flex-shrink:0">${pill(r.status)}<div class="small muted">${when(r.created_at)}</div></div></li>`;
  }
  function bindLeadItems(root) {
    root.querySelectorAll('[data-id]').forEach((el) => { el.onclick = () => { location.hash = '#/r/' + el.dataset.id; }; });
  }

  // ---------- referrals / customers list ----------

  function query() {
    const q = location.hash.split('?')[1] || '';
    return Object.fromEntries(new URLSearchParams(q));
  }

  async function renderReferrals() {
    const params = query();
    const scope = params.scope || (isAdmin() ? 'all' : isMgr() ? 'team' : 'mine');
    const [users] = await Promise.all([isMgr() ? api('/users') : Promise.resolve([])]);
    const teams = isAdmin() ? await api('/teams') : [];

    const scopes = isAdmin() ? [['all', 'Everyone'], ['mine', 'Mine']] : isMgr() ? [['team', 'My team'], ['mine', 'Mine']] : [];
    shell(`
      <div class="card">
        <div class="row between" style="margin-bottom:.8rem">
          <h1 style="margin:0">${isMgr() ? 'Customers' : 'My referrals'}</h1>
          ${scopes.length ? `<div class="seg" id="scopeSeg">${scopes.map(([k, l]) => `<button data-k="${k}" class="${scope === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
        </div>
        <div class="filters">
          <input class="q" id="q" placeholder="Search name, phone, email, address, account #" value="${esc(params.q || '')}">
          <select id="st"><option value="">All statuses</option>${STATUSES.map((s) => `<option ${params.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          ${isMgr() ? `<select id="usr"><option value="">All reps</option>${users.filter((u) => isAdmin() && params.team_id ? String(u.team_id) === params.team_id : true).map((u) => `<option value="${u.id}" ${params.user_id === String(u.id) ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>` : '<span></span>'}
          ${isAdmin() && scope === 'all' ? `<select id="tm"><option value="">All teams</option>${teams.map((t) => `<option value="${t.id}" ${params.team_id === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Customer</th><th class="hide-sm">Contact</th><th class="hide-sm">Address</th>${isMgr() ? '<th class="hide-sm">Rep</th>' : ''}<th>Status</th><th class="hide-sm">Entered</th></tr></thead>
          <tbody id="rows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
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
    document.getElementById('st').onchange = (e) => setParam('status', e.target.value);
    const usr = document.getElementById('usr'); if (usr) usr.onchange = (e) => setParam('user_id', e.target.value);
    const tm = document.getElementById('tm'); if (tm) tm.onchange = (e) => setParam('team_id', e.target.value);
    const qEl = document.getElementById('q');
    qEl.oninput = debounce(() => load(), 250);
    qEl.onkeydown = (e) => { if (e.key === 'Enter') setParam('q', qEl.value); };

    async function load() {
      const p = new URLSearchParams({ scope });
      for (const k of ['status', 'user_id', 'team_id']) if (params[k]) p.set(k, params[k]);
      if (qEl.value.trim()) p.set('q', qEl.value.trim());
      const rows = await api('/referrals?' + p.toString());
      const tbody = document.getElementById('rows');
      if (!tbody) return;
      tbody.innerHTML = rows.length ? rows.map((r) => `
        <tr class="click" data-id="${r.id}">
          <td><b>${esc(r.customer_name)}</b>${r.account_number ? `<div class="small muted">Acct ${esc(r.account_number)}</div>` : ''}${r.comment_count ? `<div class="small muted">💬 ${r.comment_count}</div>` : ''}</td>
          <td class="hide-sm">${esc(r.phone)}<div class="small muted">${esc(r.email)}</div></td>
          <td class="hide-sm small">${esc(r.address)}</td>
          ${isMgr() ? `<td class="hide-sm small">${esc(r.created_by_name)}${isAdmin() && r.team_name ? `<div class="muted">${esc(r.team_name)}</div>` : ''}</td>` : ''}
          <td>${pill(r.status)}</td>
          <td class="hide-sm small muted">${when(r.created_at)}</td>
        </tr>`).join('') : '<tr><td colspan="6" class="muted">No referrals match.</td></tr>';
      document.getElementById('count').textContent = `${rows.length}${rows.length === 500 ? '+' : ''} referral${rows.length === 1 ? '' : 's'}`;
      bindLeadItems(tbody);
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
    const editing = state.editing === r.id;
    shell(`
      <p><a href="javascript:history.back()">← Back</a></p>
      <div class="grid-2">
        <div class="stack">
          <div class="card">
            <div class="row between"><h1 style="margin:0">${esc(r.customer_name)}</h1>${pill(r.status)}</div>
            <p class="small muted">#${r.id} · entered by ${esc(r.created_by_name)}${r.team_name ? ` (${esc(r.team_name)})` : ''} · ${fullDate(r.created_at)}</p>
            ${editing ? `
              <form id="editForm">
                <div class="field"><label>Name</label><input name="name" value="${esc(r.customer_name)}" required></div>
                <div class="field"><label>Phone</label><input name="phone" value="${esc(r.phone)}"></div>
                <div class="field"><label>Email</label><input name="email" value="${esc(r.email)}"></div>
                <div class="field"><label>Address</label><input name="address" value="${esc(r.address)}"></div>
                <div class="field"><label>Notes</label><textarea name="notes" rows="3">${esc(r.notes)}</textarea></div>
                <div id="editErr" style="margin-top:.6rem"></div>
                <div class="row" style="margin-top:.8rem"><button class="btn primary">Save</button><button type="button" class="btn" id="cancelEdit">Cancel</button></div>
              </form>` : `
              <dl class="kv">
                <dt>Phone</dt><dd>${r.phone ? `<a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>` : '<span class="muted">—</span>'}</dd>
                <dt>Email</dt><dd>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '<span class="muted">—</span>'}</dd>
                <dt>Address</dt><dd>${esc(r.address) || '<span class="muted">—</span>'}</dd>
                <dt>Notes</dt><dd style="white-space:pre-wrap">${esc(r.notes) || '<span class="muted">—</span>'}</dd>
                <dt>Account #</dt><dd>${esc(r.account_number) || '<span class="muted">—</span>'}</dd>
                <dt>Updated</dt><dd>${fullDate(r.updated_at)}</dd>
              </dl>
              ${r.can_edit ? '<button class="btn small" id="editBtn" style="margin-top:.8rem">Edit details</button>' : ''}`}
          </div>
          ${r.can_manage ? `
          <div class="card">
            <h2>Update status</h2>
            <div class="seg" id="statusSeg" style="margin-bottom:.8rem">${STATUSES.map((s) => `<button data-s="${s}" class="${r.status === s ? 'on' : ''}">${s}</button>`).join('')}</div>
            <form id="acctForm" class="row"><input class="grow" name="acct" placeholder="Spectrum account / order #" value="${esc(r.account_number)}" style="flex:1;min-width:0;width:auto"><button class="btn">Save</button></form>
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
            <textarea id="commentBody" rows="3" placeholder="e.g. @manager address doesn't match the account"></textarea>
            <div id="mentionBox"></div>
            <button class="btn primary" style="margin-top:.5rem">Post comment</button>
          </form>
        </div>
      </div>`);

    const editBtn = document.getElementById('editBtn');
    if (editBtn) editBtn.onclick = () => { state.editing = r.id; renderReferral(id); };
    const editForm = document.getElementById('editForm');
    if (editForm) {
      document.getElementById('cancelEdit').onclick = () => { state.editing = null; renderReferral(id); };
      editForm.onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(editForm));
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
      await api('/referrals/' + r.id, { method: 'PATCH', body: { account_number: acctForm.acct.value } });
      toast('Account # saved');
      renderReferral(id);
    };

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

  function setupMentions(ta, box, people) {
    let matches = [];
    let sel = 0;
    const current = () => {
      const upto = ta.value.slice(0, ta.selectionStart);
      const m = upto.match(/@([A-Za-z0-9._-]*)$/);
      return m ? { q: m[1].toLowerCase(), start: upto.length - m[0].length } : null;
    };
    const draw = () => {
      const c = current();
      matches = c ? people.filter((p) => p.username.toLowerCase().startsWith(c.q) || p.full_name.toLowerCase().includes(c.q)).slice(0, 6) : [];
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

  function userTable(users, clickable) {
    return `<div class="table-wrap"><table>
      <thead><tr><th>Rep</th>${STATUSES.map((s) => `<th class="num">${s}</th>`).join('')}<th class="num">Total</th></tr></thead>
      <tbody>${users.map((u) => `<tr ${clickable ? `class="click" data-user="${u.id}"` : ''}><td><b>${esc(u.full_name)}</b>${u.role !== 'rep' ? ` <span class="small muted">${roleLabel(u.role)}</span>` : ''}</td>${STATUSES.map((s) => `<td class="num">${u[s]}</td>`).join('')}<td class="num"><b>${u.total}</b></td></tr>`).join('') || `<tr><td colspan="${STATUSES.length + 2}" class="muted">No one here yet.</td></tr>`}</tbody>
    </table></div>`;
  }

  async function renderSales() {
    const params = query();
    const period = params.period || 'month';
    const range = rangeFor(period);
    const qs = new URLSearchParams(range);
    if (params.team_id) qs.set('team_id', params.team_id);
    const s = await api('/stats?' + qs.toString());
    const periods = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['all', 'All time']];

    shell(`
      <div class="row between" style="margin-bottom:1rem">
        <h1 style="margin:0">Sales</h1>
        <div class="seg" id="periodSeg">${periods.map(([k, l]) => `<button data-k="${k}" class="${period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
      <div class="card"><h2>My sales</h2>${statTiles(s.me)}</div>
      ${s.team ? `<div class="card"><h2>Team: ${esc(s.team.name)}</h2>${statTiles(s.team.totals)}<h2 style="margin-top:1.2rem">By rep</h2>${userTable(s.team.users, isMgr())}</div>` : ''}
      ${s.teams ? `<div class="card"><h2>All teams</h2>${statTiles(s.all)}
        <div class="table-wrap" style="margin-top:1rem"><table>
          <thead><tr><th>Team</th>${STATUSES.map((x) => `<th class="num">${x}</th>`).join('')}<th class="num">Total</th></tr></thead>
          <tbody>${s.teams.map((t) => `<tr class="click" data-team="${t.id}"><td><b>${esc(t.name)}</b></td>${STATUSES.map((x) => `<td class="num">${t[x]}</td>`).join('')}<td class="num"><b>${t.total}</b></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No teams yet.</td></tr>'}</tbody>
        </table></div>
        <p class="small muted">Click a team to see its reps.</p></div>` : ''}
      ${s.selectedTeam ? `<div class="card"><h2>${esc(s.selectedTeam.name)} — by rep</h2>${userTable(s.selectedTeam.users, true)}</div>` : ''}`);

    document.querySelectorAll('#periodSeg button').forEach((b) => {
      b.onclick = () => { location.hash = '#/sales?' + new URLSearchParams({ ...params, period: b.dataset.k }).toString(); };
    });
    document.querySelectorAll('[data-team]').forEach((el) => {
      el.onclick = () => { location.hash = '#/sales?' + new URLSearchParams({ ...params, period, team_id: el.dataset.team }).toString(); };
    });
    document.querySelectorAll('[data-user]').forEach((el) => {
      el.onclick = () => { location.hash = `#/referrals?scope=${isAdmin() ? 'all' : 'team'}&user_id=${el.dataset.user}`; };
    });
  }

  // ---------- team / users ----------

  async function renderTeam() {
    if (!isMgr()) { location.hash = '#/new'; return; }
    const [users, teams] = await Promise.all([api('/users'), api('/teams')]);
    const flash = state.flash; state.flash = null;

    shell(`
      ${flash ? `<div class="card" style="border-color:var(--ok)"><div class="alert ok" style="margin-bottom:.6rem">${esc(flash.title)}</div>
        <p style="margin:0 0 .4rem">Give <b>${esc(flash.username)}</b> this temporary password. They'll pick their own when they sign in:</p>
        <span class="secret">${esc(flash.password)}</span> <button class="btn small" id="copyPw">Copy</button></div>` : ''}
      <div class="grid-2">
        <form class="card" id="addUser">
          <h2>Add a ${isAdmin() ? 'user' : 'rep to ' + esc(state.me.team_name || 'your team')}</h2>
          <div class="field"><label for="au_name">Full name</label><input id="au_name" name="full_name" required></div>
          <div class="field"><label for="au_user">Username</label><input id="au_user" name="username" autocapitalize="none" placeholder="e.g. jsmith" required></div>
          ${isAdmin() ? `
            <div class="field"><label for="au_role">Role</label><select id="au_role" name="role"><option value="rep">Rep</option><option value="manager">Manager</option><option value="admin">Admin</option></select></div>
            <div class="field"><label for="au_team">Team</label><select id="au_team" name="team_id"><option value="">— none (admins only) —</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>` : ''}
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
      <div class="card">
        <h2>${isAdmin() ? 'All users' : 'Team members'}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Role</th>${isAdmin() ? '<th>Team</th>' : ''}<th class="num">Referrals</th><th class="num">Ordered</th><th></th></tr></thead>
          <tbody>${users.map((u) => {
            const manageable = isAdmin() || (u.role === 'rep');
            const self = u.id === state.me.id;
            return `<tr style="${u.active ? '' : 'opacity:.55'}">
              <td><b>${esc(u.full_name)}</b><div class="small muted">@${esc(u.username)}${u.active ? '' : ' · deactivated'}${u.must_change_password ? ' · temp password' : ''}</div></td>
              <td>${isAdmin() && !self ? `<select data-role="${u.id}" style="width:auto">${['rep', 'manager', 'admin'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}</select>` : roleLabel(u.role)}</td>
              ${isAdmin() ? `<td><select data-team="${u.id}" style="width:auto"><option value="">—</option>${teams.map((t) => `<option value="${t.id}" ${u.team_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>` : ''}
              <td class="num"><a href="#/referrals?scope=${isAdmin() ? 'all' : 'team'}&user_id=${u.id}">${u.referral_count}</a></td>
              <td class="num">${u.ordered_count}</td>
              <td style="white-space:nowrap;text-align:right">${manageable && !self ? `
                <button class="btn small" data-reset="${u.id}" data-username="${esc(u.username)}">Reset password</button>
                <button class="btn small ${u.active ? 'danger' : ''}" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>`);

    const copy = document.getElementById('copyPw');
    if (copy) copy.onclick = () => { navigator.clipboard?.writeText(flash.password); toast('Copied'); };

    document.getElementById('addUser').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api('/users', { method: 'POST', body });
        state.flash = { title: `${body.full_name} was added.`, username: r.username, password: r.temp_password };
        renderTeam();
      } catch (err) {
        document.getElementById('addErr').innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
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
        try { await api('/users/' + b.dataset.active, { method: 'PATCH', body: { active: b.dataset.to === '1' } }); renderTeam(); } catch (err) { toast(err.message); }
      };
    });
    document.querySelectorAll('select[data-role]').forEach((s) => {
      s.onchange = async () => { try { await api('/users/' + s.dataset.role, { method: 'PATCH', body: { role: s.value } }); toast('Role updated'); renderTeam(); } catch (err) { toast(err.message); } };
    });
    document.querySelectorAll('select[data-team]').forEach((s) => {
      s.onchange = async () => { try { await api('/users/' + s.dataset.team, { method: 'PATCH', body: { team_id: s.value || null } }); toast('Team updated'); } catch (err) { toast(err.message); } };
    });
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
      if (h === '#/sales') return await renderSales();
      if (h === '#/team') return await renderTeam();
      if (h === '#/notifications') return await renderNotifications();
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

  // Keep the notification badge fresh.
  setInterval(async () => {
    if (!state.me || document.hidden) return;
    const before = state.me.unread;
    try {
      await refreshMe();
      if (state.me.unread !== before) {
        const b = document.querySelector('.top-actions a.icon-btn');
        if (b) b.innerHTML = `🔔${state.me.unread ? `<span class="badge">${state.me.unread > 99 ? '99+' : state.me.unread}</span>` : ''}`;
      }
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
