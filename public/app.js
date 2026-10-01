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
  // The E&O mark, inline so its colors follow light/dark mode. Each copy needs its own ids.
  let markSeq = 0;
  function markSvg(cls = 'brand-mark') {
    const n = ++markSeq;
    return `<svg class="${cls}" viewBox="0 0 212 110" role="img" aria-label="E&amp;O Sales">
      <defs><linearGradient id="eog${n}" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="212" y2="70">
        <stop offset="0" class="eo-s1"/><stop offset="0.5" class="eo-s2"/><stop offset="1" class="eo-s3"/></linearGradient>
        <mask id="eom${n}" maskUnits="userSpaceOnUse" x="0" y="0" width="212" height="110"><rect width="212" height="110" fill="#fff"/>
        <path d="M110 -2 H150 V26 H86 Z" fill="#000"/><path d="M90 80 H150 V110 H114 Z" fill="#000"/></mask></defs>
      <path d="M120 13 H55 A40 40 0 0 0 55 93 H120" fill="none" stroke="url(#eog${n})" stroke-width="22" mask="url(#eom${n})"/>
      <path d="M26 53 H82 C102 53 112 70 128 92" fill="none" stroke="url(#eog${n})" stroke-width="24"/>
      <circle cx="157" cy="55" r="44" fill="none" stroke="url(#eog${n})" stroke-width="22"/>
      <g fill="none" class="eo-waves" stroke-width="7" stroke-linecap="round">
        <path d="M141 51 A9 9 0 0 1 146 64"/><path d="M144 40 A20 20 0 0 1 156 70"/><path d="M149 29 A31 31 0 0 1 165 76"/></g></svg>`;
  }
  const wordmark = (sub = 'Spectrum Referrals') => `<span class="wm"><b>E&amp;O</b> Sales</span>${sub ? `<small>${sub}</small>` : ''}`;
  const lockup = () => `<div class="lockup">${markSvg('lockup-mark')}<div>${wordmark()}</div></div>`;

  const defaultRoute = () => (role() === 'rep' ? '#/new' : '#/home');
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

  // Main navigation: the day-to-day pages. Everything else lives in one hub:
  // "Admin" for admins, "Account" for everyone else, with sub-tabs across the top.
  const isDispatch = () => role() === 'dispatch';

  function navLinks() {
    const links = [['#/home', 'Home', 'home', '🏠']];
    links.push(['#/new', 'New Referral', 'new', '➕']);
    if (isDispatch()) links.push(['#/referrals?scope=assigned', 'My Queue', 'queue', '🎧']);
    links.push(['#/board', 'Board', 'board', '🗂']);
    links.push(['#/referrals', worksLeads() ? 'Customers' : 'My Referrals', 'customers', '👥']);
    links.push(['#/analytics', 'Analytics', 'analytics', '📊']);
    links.push(['#/sales', 'Sales', 'sales', '📈']);
    if (isDispatch()) links.push(['#/duplicates', 'Duplicates', 'dups', '⛔']);
    if (isManager()) links.push(['#/team', 'My Team', 'team', '👥']);
    links.push(isAdmin() ? ['#/team', 'Admin', 'hub', '⚙'] : ['#/account', 'Account', 'hub', '👤']);
    return links;
  }

  // Sub-tabs of the hub: [href, label].
  function hubTabs() {
    if (isAdmin()) {
      return [['#/team', 'Users & teams'], ['#/team?tab=invites', 'Invite links'], ['#/team?tab=past-sales', 'Past sales'],
        ['#/payments', 'Payments'], ['#/affiliate', 'Affiliate'], ['#/duplicates', 'Duplicates'], ['#/audit-logs', 'Audit log'],
        ['#/team?tab=settings', 'Settings'], ['#/account', 'My account']];
    }
    const t = [['#/account', 'Profile']];
    if (state.me.payments) t.push(['#/payments', 'Payments']);
    if (state.me.affiliate) t.push(['#/affiliate', 'Affiliate']);
    t.push(['#/help', 'Help']);
    return t;
  }
  const hubRoutes = () => new Set(hubTabs().map(([h]) => h.split('?')[0]));
  const inHub = () => hubRoutes().has(location.hash.split('?')[0] || defaultRoute());

  // The current sub-tab: same route, and the same ?tab= (none counts as the first).
  function hubActive(href) {
    const [route, qs] = location.hash.split('?');
    const [hRoute, hQs] = href.split('?');
    return route === hRoute && (new URLSearchParams(qs || '').get('tab') || '') === (new URLSearchParams(hQs || '').get('tab') || '');
  }

  function subTabsHtml() {
    if (!inHub()) return '';
    return `<nav class="subtabs" aria-label="${isAdmin() ? 'Admin' : 'Account'} sections">${hubTabs().map(([h, l]) => `<a href="${h}" class="${hubActive(h) ? 'on' : ''}">${l}</a>`).join('')}</nav>`;
  }

  // The phone tab bar shows these four; the rest go under "More".
  const TAB_KEYS = ['home', 'new', 'board', 'customers'];

  function isActive(href, key) {
    if (key === 'hub') return inHub();
    const [route, qs] = location.hash.split('?');
    const [hRoute, hQs] = href.split('?');
    if (hRoute === '#/referrals') {
      const scope = new URLSearchParams(qs || '').get('scope');
      if (hQs) return route === hRoute && scope === 'assigned';
      return (route === hRoute && scope !== 'assigned') || route.startsWith('#/r/');
    }
    return (route || defaultRoute()) === hRoute;
  }

  function badges() {
    const me = state.me;
    const bell = document.getElementById('bellBtn');
    if (bell) bell.innerHTML = `🔔${me.unread ? `<span class="badge">${me.unread > 99 ? '99+' : me.unread}</span>` : ''}`;
    document.querySelectorAll('[data-nav="queue"]').forEach((q) => {
      const label = q.querySelector('.lbl') || q;
      label.innerHTML = `My Queue${me.queue ? ` <span class="count">${me.queue}</span>` : ''}`;
    });
  }

  // ---------- theme (light / dark / follow the device) ----------

  const THEME_KEY = 'eo-theme';
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
  }
  function applyTheme(t) {
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#171e28' : '#0b63ce');
  }
  function setTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
    applyTheme(t);
    if (location.hash.startsWith('#/home')) route_(); // charts re-read their colors
  }
  applyTheme(getTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (getTheme() === 'system') applyTheme('system'); });

  // ---------- modal dialog ----------

  function modal(html, { wide } = {}) {
    closeModal();
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) closeModal(); });
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    const first = wrap.querySelector('input, select, textarea, button:not([data-close])');
    if (first) first.focus();
    return wrap.querySelector('.modal');
  }
  function closeModal() { document.querySelectorAll('.modal-back').forEach((m) => m.remove()); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeMenus(); } });

  // ---------- tooltips for charts (any element with data-tip) ----------

  const tip = document.createElement('div');
  tip.id = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.classList.add('show');
    const r = tip.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }
  function hideTip() { tip.classList.remove('show'); }
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) showTip(el.dataset.tip, e.clientX, e.clientY);
    else if (!e.target.closest?.('.chart-hit')) hideTip();
  });
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) { const t = e.touches[0]; showTip(el.dataset.tip, t.clientX, t.clientY); } else hideTip();
  }, { passive: true });

  // ---------- shell ----------

  function closeMenus() {
    document.querySelectorAll('.menu-pop.open, .sheet.open, .search-results.open').forEach((m) => m.classList.remove('open'));
    document.querySelector('.topbar')?.classList.remove('searching');
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('.search') && !e.target.closest('.sheet') && !e.target.closest('[data-more]')) closeMenus();
  });

  function shell(content, opts = {}) {
    const me = state.me;
    const links = navLinks();
    const theme = getTheme();
    const tabs = links.filter((l) => TAB_KEYS.includes(l[2]));
    const more = links.filter((l) => !TAB_KEYS.includes(l[2]));
    $app.innerHTML = `
      <header class="topbar"><div class="topbar-inner ${opts.wide ? 'wide' : ''}">
        <a class="brand" href="#/home" aria-label="E&amp;O Sales home">${markSvg()}<span class="brand-text">${wordmark(esc(me.team_name || (seesAll() ? 'All teams' : 'Spectrum Referrals')))}</span></a>
        <nav class="nav">${links.map(([h, l, key]) => `<a href="${h}" data-nav="${key}" class="${isActive(h, key) ? 'active' : ''}"><span class="lbl">${l}</span></a>`).join('')}</nav>
        <div class="search">
          <button class="icon-btn search-toggle" id="searchToggle" aria-label="Search">🔍</button>
          <input id="gsearch" type="search" placeholder="Search customers…  /" autocomplete="off" aria-label="Search customers">
          <div class="search-results" id="gresults"></div>
        </div>
        <div class="top-actions">
          <a class="icon-btn" id="bellBtn" href="#/notifications" title="Notifications" aria-label="Notifications"></a>
          <div class="menu">
            <button class="icon-btn" id="menuBtn" aria-label="Account" aria-haspopup="true">👤</button>
            <div class="menu-pop" id="menuPop">
              <div class="who"><b>${esc(me.full_name)}</b><div class="small muted">@${esc(me.username)} · ${roleLabel(me.role)}</div></div>
              <a href="#/account">My account</a>
              <a href="#/help">Help &amp; how-to</a>
              <div class="menu-theme"><span class="small muted">Appearance</span>
                <div class="seg small-seg">${[['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-theme-set="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
              <button id="logoutBtn">Sign out</button>
            </div>
          </div>
        </div>
      </div></header>
      <div class="offline-bar" role="status">📶 You're offline. New leads are saved on this phone and sent when you're back.</div>
      <main class="${opts.wide ? 'wide' : ''}">${subTabsHtml()}${content}</main>
      <nav class="tabbar" aria-label="Main">
        ${tabs.map(([h, l, key, icon]) => `<a href="${h}" data-nav="${key}" class="${isActive(h, key) ? 'active' : ''}"><span class="ti">${icon}</span><span class="lbl">${key === 'new' ? 'New' : l.replace('My Referrals', 'Mine')}</span></a>`).join('')}
        <button data-more class="${more.some(([h, , key]) => isActive(h, key)) ? 'active' : ''}"><span class="ti">☰</span><span>More</span></button>
      </nav>
      <div class="sheet" id="moreSheet">${more.map(([h, l, key, icon]) => `<a href="${h}" data-nav="${key}"><span class="ti">${icon}</span><span class="lbl">${l}</span></a>`).join('')}
        <a href="#/help"><span class="ti">❓</span><span>Help</span></a></div>`;
    badges();

    const pop = document.getElementById('menuPop');
    document.getElementById('menuBtn').onclick = () => { const open = !pop.classList.contains('open'); closeMenus(); pop.classList.toggle('open', open); };
    pop.querySelectorAll('[data-theme-set]').forEach((b) => {
      b.onclick = () => { setTheme(b.dataset.themeSet); pop.querySelectorAll('[data-theme-set]').forEach((x) => x.classList.toggle('on', x === b)); };
    });
    document.getElementById('logoutBtn').onclick = async () => {
      await api('/logout', { method: 'POST', body: {} }).catch(() => {});
      state.me = null; peopleCache = null; lsSet('eo-me', null);
      renderLogin();
    };
    const sheet = document.getElementById('moreSheet');
    document.querySelector('[data-more]').onclick = () => { const open = !sheet.classList.contains('open'); closeMenus(); sheet.classList.toggle('open', open); };
    setupSearch();
  }

  // ---------- global search ----------

  function setupSearch() {
    const input = document.getElementById('gsearch');
    const box = document.getElementById('gresults');
    const bar = document.querySelector('.topbar');
    let sel = -1;
    let items = [];
    document.getElementById('searchToggle').onclick = () => { bar.classList.add('searching'); input.focus(); };
    const draw = (data) => {
      const q = input.value.trim();
      items = [
        ...data.referrals.map((r) => ({ href: `#/r/${r.id}`, html: `<b>${esc(leadName(r))}</b> ${pill(r.status)}<div class="small muted">${esc([r.phone, r.email, r.address].filter(Boolean).join(' · '))}</div><div class="small muted">${esc(r.created_by_name)}${r.team_name ? ` · ${esc(r.team_name)}` : ''}</div>` })),
        ...data.users.map((u) => ({ href: `#/referrals?scope=${seesAll() ? 'all' : 'team'}&user_id=${u.id}`, html: `👤 <b>${esc(u.full_name)}</b> <span class="small muted">@${esc(u.username)} · ${roleLabel(u.role)}${u.team_name ? ` · ${esc(u.team_name)}` : ''}</span>` })),
      ];
      items.push({ href: `#/referrals?q=${encodeURIComponent(q)}`, html: `<span class="muted">See all results for “${esc(q)}” →</span>` });
      sel = -1;
      box.innerHTML = (data.referrals.length || data.users.length ? '' : '<div class="sr-empty muted small">No customers match.</div>')
        + items.map((it, i) => `<a href="${it.href}" data-i="${i}">${it.html}</a>`).join('');
      box.classList.add('open');
    };
    const run = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { box.classList.remove('open'); return; }
      try { draw(await api('/search?q=' + encodeURIComponent(q))); } catch { /* ignore */ }
    }, 180);
    input.addEventListener('input', run);
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run(); });
    input.addEventListener('keydown', (e) => {
      const links = [...box.querySelectorAll('a')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = e.key === 'ArrowDown' ? Math.min(links.length - 1, sel + 1) : Math.max(0, sel - 1);
        links.forEach((a, i) => a.classList.toggle('on', i === sel));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = links[sel >= 0 ? sel : 0];
        if (target) location.hash = target.getAttribute('href').slice(1);
        input.blur(); closeMenus();
      }
    });
    box.addEventListener('click', () => { closeMenus(); input.value = ''; });
  }
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing && document.getElementById('gsearch')) {
      e.preventDefault();
      document.querySelector('.topbar')?.classList.add('searching');
      document.getElementById('gsearch').focus();
    }
  });

  async function refreshMe() {
    state.me = await api('/me');
    return state.me;
  }

  // ---------- login / password ----------

  function renderLogin() {
    $app.innerHTML = `
      <div class="login-wrap"><form class="card login" id="loginForm">
        ${lockup()}
        <p class="muted" style="margin:.2rem 0 1rem">Sign in to enter and track referrals.</p>
        <div class="field"><label for="u">Username</label><input id="u" autocomplete="username" autocapitalize="none" required></div>
        <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
        <div id="loginErr" style="margin-top:.8rem"></div>
        <button class="btn primary big" style="margin-top:1rem">Sign in</button>
        <p style="margin:.9rem 0 0;text-align:center"><button type="button" class="link-btn small" id="forgotBtn">Forgot your password?</button></p>
      </form></div>`;
    document.getElementById('forgotBtn').onclick = () => renderForgot(document.getElementById('u').value);
    document.getElementById('u').focus();
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/login', { method: 'POST', body: { username: e.target.u.value, password: e.target.p.value } });
        peopleCache = null;
        await refreshMe();
        if (state.me.must_change_password) return renderChangePassword(true);
        if (!location.hash || location.hash === '#/') location.hash = defaultRoute();
        route_();
      } catch (err) {
        document.getElementById('loginErr').innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
    };
  }

  // Step 1: ask for a code. Step 2: enter it with a new password.
  function renderForgot(prefill = '', step = 1, note = '') {
    $app.innerHTML = `
      <div class="login-wrap"><form class="card login" id="fpForm">
        ${lockup()}
        <h1>${step === 1 ? 'Reset your password' : 'Check your email'}</h1>
        ${step === 1 ? `
          <p class="muted" style="margin-top:0">Enter your username or email. If your account has an email address, we'll send you a 6-digit code.</p>
          <div class="field"><label for="fpLogin">Username or email</label><input id="fpLogin" autocomplete="username" autocapitalize="none" value="${esc(prefill)}" required></div>`
        : `
          <p class="muted" style="margin-top:0">${note || 'If that account has an email address, a code is on its way. It expires in 15 minutes.'}</p>
          <div class="field"><label for="fpCode">6-digit code</label><input id="fpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required style="font-size:1.4rem;letter-spacing:.3em"></div>
          <div class="field"><label for="fpNew">New password <span class="muted small">(8+ characters)</span></label><input id="fpNew" type="password" autocomplete="new-password" minlength="8" required></div>`}
        <div id="fpErr" style="margin-top:.8rem"></div>
        <button class="btn primary big" style="margin-top:1rem">${step === 1 ? 'Send me a code' : 'Reset password & sign in'}</button>
        <p style="margin:.9rem 0 0;text-align:center" class="small">
          ${step === 2 ? '<button type="button" class="link-btn small" id="fpAgain">Send a new code</button> · ' : ''}
          <button type="button" class="link-btn small" id="fpBack">Back to sign in</button></p>
      </form></div>`;
    const err = (m) => { document.getElementById('fpErr').innerHTML = `<div class="alert err">${esc(m)}</div>`; };
    document.getElementById('fpBack').onclick = () => renderLogin();
    const again = document.getElementById('fpAgain');
    if (again) again.onclick = () => renderForgot(prefill, 1);
    document.getElementById('fpForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('.btn.primary');
      btn.disabled = true;
      try {
        if (step === 1) {
          const login = document.getElementById('fpLogin').value.trim();
          const r = await api('/password/forgot', { method: 'POST', body: { login } });
          if (!r.email_enabled) {
            document.getElementById('fpErr').innerHTML = '<div class="alert warn">Email isn\'t set up for this app yet. Ask your manager or an admin to reset your password.</div>';
            return;
          }
          renderForgot(login, 2);
        } else {
          await api('/password/reset', { method: 'POST', body: { login: prefill, code: document.getElementById('fpCode').value, password: document.getElementById('fpNew').value } });
          await refreshMe();
          toast('Password reset. Welcome back!');
          location.hash = defaultRoute();
          route_();
        }
      } catch (ex) {
        err(ex.message);
      } finally {
        btn.disabled = false;
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
        location.hash = defaultRoute();
        route_();
      } catch (ex) {
        err.innerHTML = `<div class="alert err">${esc(ex.message)}</div>`;
      }
    };
  }

  // ---------- new referral (the easy box) ----------

  async function renderNew() {
    // Works without signal: settings come from the last visit, and leads are saved on the phone.
    const [settings, ppl] = await Promise.all([
      api('/settings').then((x) => { lsSet('eo-settings', { entry_template: x.entry_template }); return x; }).catch(() => lsGet('eo-settings', { entry_template: '' })),
      people().catch(() => ({ credit: [], dispatchers: [] })),
    ]);
    const creditOptions = ppl.credit.filter((p) => p.id !== state.me.id);

    shell(`
      <div class="narrow stack">
        ${helpNudge()}
        <div id="phoneNudge"></div>
        <div id="outboxBox"></div>
        <form class="card quick" id="quickForm" autocomplete="off">
          <div class="row between"><h1 style="margin:0">New referral</h1>
            ${settings.entry_template.trim() ? '<button type="button" class="btn small" id="tplBtn">📝 Use template</button>' : ''}</div>
          <p class="muted" style="margin-top:.3rem">Type or paste the customer's info however you like. Anything extra is kept as notes.</p>
          <textarea id="leadText" placeholder="Jane Smith&#10;512-555-0142&#10;jane@email.com&#10;123 Main St, Austin TX 78701&#10;wants internet + mobile, call after 5" aria-label="Customer info"></textarea>
          <div class="chips" id="chips"></div>
          <div id="addrHint"></div>
          <div class="score-meter" id="scoreMeter" hidden></div>
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
              <div><label for="f_dob">Date of birth</label><input id="f_dob" inputmode="numeric" placeholder="MM/DD/YYYY"></div>
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
    const fields = ['name', 'phone', 'email', 'address', 'dob', 'notes'];
    const f = Object.fromEntries(fields.map((k) => [k, document.getElementById('f_' + k)]));
    const touched = new Set();
    const svc = new Set();
    let svcTouched = false;
    let parsed = {};
    ta.focus();

    const drawServices = () => document.querySelectorAll('[data-svc]').forEach((b) => b.classList.toggle('on', svc.has(b.dataset.svc)));
    document.querySelectorAll('[data-svc]').forEach((b) => {
      b.onclick = () => { svcTouched = true; svc.has(b.dataset.svc) ? svc.delete(b.dataset.svc) : svc.add(b.dataset.svc); drawServices(); drawScore(); };
    });

    const currentVals = () => Object.fromEntries(fields.map((k) => [k, touched.has(k) ? f[k].value : parsed[k] || '']));
    // Live lead-quality meter: red to green, with what's missing or looks fake.
    const meter = document.getElementById('scoreMeter');
    const drawScore = () => {
      const vals = currentVals();
      if (!ta.value.trim() && !fields.some((k) => vals[k])) { meter.hidden = true; return; }
      const q = LeadScore.scoreLead({ ...vals, zip: parsed.zip, city: parsed.city, services: [...svc] });
      const fix = q.checks.email.fix;
      meter.hidden = false;
      meter.style.setProperty('--sc', q.color);
      meter.innerHTML = `<div class="sm-top"><span class="sm-label">Lead quality</span><b class="sm-pct">${q.score}%</b><span class="sm-band">${q.band}</span></div>
        <div class="sm-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${q.score}" aria-label="Lead quality"><span style="width:${q.score}%"></span></div>
        ${q.fakes.length ? `<ul class="sm-fakes">${q.fakes.map((x) => `<li>⛔ ${esc(x.msg)}</li>`).join('')}</ul>` : ''}
        ${q.tips.length ? `<ul class="sm-tips">${q.tips.map((t) => `<li>${esc(t)}${fix && t.startsWith('Did you mean') ? ' <button type="button" class="link-btn" id="fixEmail">Fix it</button>' : ''}</li>`).join('')}</ul>` : ''}`;
      const fe = document.getElementById('fixEmail');
      if (fe) fe.onclick = () => { touched.add('email'); f.email.value = fix; if (ta.value.includes(vals.email)) ta.value = ta.value.replace(vals.email, fix); drawChips(); };
    };

    // "Did you mean …?" for the address read from the box.
    const addrHint = document.getElementById('addrHint');
    const suggestAddress = debounce(async () => {
      const a = currentVals().address;
      if (!a || touched.has('address') || a.length < 6 || !/\d/.test(a)) { addrHint.innerHTML = ''; return; }
      let best;
      try { best = ((await api('/address/suggest?q=' + encodeURIComponent(a))).suggestions || [])[0]; } catch { best = null; }
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!best || currentVals().address !== a || norm(best.label).startsWith(norm(a))) { addrHint.innerHTML = ''; return; }
      if ((a.match(/^\s*\d+/) || [''])[0].trim() !== (best.line1.match(/^\d+/) || [''])[0]) { addrHint.innerHTML = ''; return; }
      addrHint.innerHTML = `<div class="addr-hint">📍 Did you mean <b>${esc(best.label)}</b>? <button type="button" class="btn small" id="useAddr">Use it</button></div>`;
      document.getElementById('useAddr').onclick = () => { touched.add('address'); f.address.value = best.label; addrHint.innerHTML = ''; drawChips(); };
    }, 700);
    attachAddressSuggest(f.address, (x) => { f.address.value = x.label; touched.add('address'); addrHint.innerHTML = ''; drawChips(); });

    const drawChips = () => {
      const vals = currentVals();
      const label = { name: 'Name', phone: 'Phone', email: 'Email', address: 'Address', dob: 'Date of birth', notes: 'Notes' };
      if (vals.dob && /^\d{4}-\d{2}-\d{2}$/.test(vals.dob)) vals.dob = usDate(vals.dob);
      chips.innerHTML = fields
        .filter((k) => k !== 'notes' || vals.notes)
        .map((k) => `<span class="chip ${vals[k] ? 'on' : ''}">${vals[k] ? '✓' : '○'} ${label[k]}${vals[k] ? `: <b>${esc(vals[k].split('\n')[0])}</b>` : ''}</span>`)
        .join('')
        + (ta.value.trim() && !vals.phone && !vals.email && !vals.address
          ? '<span class="chip warn">Needs a phone, email or address to check for duplicates</span>' : '')
        + (ta.value.trim() && !vals.name ? '<span class="chip warn">Needs the customer\'s name</span>' : '');
      drawScore();
      suggestAddress();
    };

    const doParse = debounce(async () => {
      if (!ta.value.trim()) { parsed = {}; drawChips(); return; }
      try {
        parsed = await api('/parse', { method: 'POST', body: { text: ta.value } });
        for (const k of fields) if (!touched.has(k)) f[k].value = k === 'dob' ? usDate(parsed.dob) : parsed[k] || '';
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
        msg.innerHTML = `<div class="alert ok">✓ Sent! ${esc(leadName(ref))} is in as <b>New</b>${ref.created_by !== state.me.id ? ` for ${esc(ref.created_by_name)}` : ''}. <a href="#/r/${ref.id}">View</a>
          <div class="wa-row">${waButtonsHtml()}</div></div>`;
        bindWhatsapp(msg, ref);
        ta.value = '';
        for (const k of fields) f[k].value = '';
        touched.clear(); parsed = {}; fixWrap.hidden = true; svc.clear(); svcTouched = false;
        if (credit) credit.value = '';
        drawChips(); drawServices();
        loadRecent();
        ta.focus();
      } catch (err) {
        if (!err.status) {
          // No signal: keep it on the phone and send it later.
          const body = { text: ta.value, services: [...svc] };
          for (const k of fields) if (touched.has(k) || !fixWrap.hidden) body[k] = f[k].value;
          const credit = document.getElementById('creditTo');
          if (credit && credit.value) body.credit_to = Number(credit.value);
          queueLead(body);
          msg.innerHTML = '<div class="alert warn">📶 No signal. The lead is <b>saved on this phone</b> and will send by itself when you\'re back online.</div>';
          ta.value = '';
          for (const k of fields) f[k].value = '';
          touched.clear(); parsed = {}; fixWrap.hidden = true; svc.clear(); svcTouched = false;
          drawChips(); drawServices(); drawOutbox();
          return;
        }
        const cls = err.status === 409 ? 'err' : 'warn';
        msg.innerHTML = `<div class="alert ${cls}">${err.status === 409 ? '⛔ ' : ''}${esc(err.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    };
    drawOutbox();
    phoneNudge();
    flushOutbox();

    async function loadRecent() {
      const list = document.getElementById('recent');
      if (!list) return;
      let rows;
      try { rows = await api('/referrals?scope=mine&limit=8'); } catch { list.innerHTML = '<li class="muted" style="cursor:default">Your latest referrals show here when you\'re online.</li>'; return; }
      list.innerHTML = rows.length
        ? rows.map(leadItem).join('')
        : '<li class="muted" style="cursor:default">Nothing yet — your referrals will show up here.</li>';
      bindLeadItems(list);
    }
    loadRecent();
  }

  // Lead quality: a coloured percentage, red (low) to green (high).
  function scoreBadge(score, big) {
    if (score == null || !window.LeadScore) return '';
    const s = Number(score);
    const band = s >= 80 ? 'Strong' : s >= 60 ? 'Good' : s >= 35 ? 'Fair' : 'Weak';
    return `<span class="score-badge${big ? ' big' : ''}" style="--sc:${LeadScore.scoreColor(s)}" title="Lead quality: ${band} (${s}%)">${s}%</span>`;
  }

  function leadItem(r) {
    const sub = [r.phone, r.email, r.address].filter(Boolean).join(' · ');
    return `<li data-id="${r.id}"><div class="who"><b>${esc(leadName(r))}</b><span>${esc(sub)}</span></div>
      <div style="text-align:right;flex-shrink:0">${scoreBadge(r.lead_score)} ${pill(r.status)}<div class="small muted">${when(r.created_at)}</div></div></li>`;
  }
  function bindLeadItems(root) {
    root.querySelectorAll('[data-id]').forEach((el) => { el.onclick = () => { location.hash = '#/r/' + el.dataset.id; }; });
  }

  // ---------- referrals / customers list ----------

  function scopesFor() {
    if (isDispatch()) return [['all', 'Everyone'], ['assigned', 'My queue'], ['unassigned', 'Unassigned'], ['mine', 'Entered by me']];
    if (isAdmin()) return [['all', 'Everyone'], ['unassigned', 'Unassigned'], ['mine', 'Entered by me']];
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
        <div class="table-wrap"><table class="rtable leads-table">
          <thead><tr><th>Customer</th><th>Contact</th><th>Address</th>${worksLeads() ? '<th>Rep</th>' : ''}${worksLeads() ? '<th>Dispatch</th>' : ''}<th>Status</th><th>Entered</th></tr></thead>
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
          <td class="c-main"><b>${esc(leadName(r))}</b>${svcTags(r.services)}${r.account_number ? `<div class="small muted">Acct ${esc(r.account_number)}</div>` : ''}${r.comment_count ? `<div class="small muted">💬 ${r.comment_count}</div>` : ''}</td>
          <td class="c-contact" data-label="Contact">${esc(r.phone)}<div class="small muted">${esc(r.email)}</div></td>
          <td class="c-addr small" data-label="Address">${esc(r.address)}</td>
          ${worksLeads() ? `<td class="small" data-label="Rep">${esc(r.created_by_name)}${seesAll() && r.team_name ? `<div class="muted">${esc(r.team_name)}</div>` : ''}</td>` : ''}
          ${worksLeads() ? `<td class="small" data-label="Dispatch">${r.assigned_name ? esc(r.assigned_name) : '<span class="muted">—</span>'}</td>` : ''}
          <td class="c-status">${pill(r.status)} ${scoreBadge(r.lead_score)}</td>
          <td class="small muted" data-label="Entered">${when(r.created_at)}</td>
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
        <div class="row between" style="flex-wrap:nowrap"><b class="kname">${esc(leadName(r))}</b><span class="small muted" style="white-space:nowrap">${scoreBadge(r.lead_score)} ${when(r.created_at)}</span></div>
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

    // Helpers
    const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    const empty = '<span class="field-value empty">—</span>';
    const fv = (v) => v ? `<span class="field-value">${v}</span>` : empty;
    const daysSince = (dateStr) => { const d = new Date(dateStr); const now = new Date(); return Math.floor((now - d) / 86400000); };
    const svcCount = rs.size;
    const createdDays = daysSince(r.created_at);
    const estVal = r.est_monthly_value || 0;
    const priority = r.lead_priority || 'Standard';
    const contactPref = r.contact_pref || 'Anytime';
    const CONTACT_PREFS = ['Anytime', 'Morning', 'Afternoon', 'Evening', 'Weekend'];
    const PRIORITIES = ['Low', 'Standard', 'High', 'Urgent'];

    shell(`
      <p><a href="javascript:history.back()">← Back to list</a></p>

      <!-- Record Header Card -->
      <div class="card" style="margin-bottom:1rem">
        <div class="record-header">
          <div class="record-avatar">${initials(r.customer_name)}</div>
          <div class="record-title-block">
            <h1>${esc(leadName(r))}</h1>
            <div class="record-subtitle">
              ${r.company ? esc(r.company) + ' · ' : ''}#${r.id} · ${esc(r.created_by_name)}${r.team_name ? ` (${esc(r.team_name)})` : ''}${r.entered_by && r.entered_by !== r.created_by ? ` · entered by ${esc(r.entered_by_name)}` : ''}
            </div>
            <div class="record-meta-row">
              ${pill(r.status)}
              ${scoreBadge(r.lead_score)}
              ${r.response_minutes != null ? `<span class="speed-chip ${r.response_minutes <= r.speed_target ? 'ok' : 'slow'}" title="Time to first response, in working hours">⚡ Answered in ${fmtMins(r.response_minutes)}${r.response_by ? ` by ${esc(r.response_by.split(' ')[0])}` : ''}</span>`
                : r.waiting_minutes != null ? `<span class="speed-chip wait ${r.waiting_minutes > r.speed_target ? 'late' : ''}" title="Working minutes since it came in">⏱ Waiting ${fmtMins(r.waiting_minutes)}</span>` : ''}
              <span class="priority-badge ${esc(priority)}">${esc(priority)} Priority</span>
              <span class="pref-chip">🕐 ${esc(contactPref)}</span>
            </div>
          </div>
        </div>

        <!-- Highlights Strip -->
        <div class="record-highlights">
          <div class="highlight-tile">
            <div class="hl-val" style="color:var(--ok)">${estVal ? '$' + estVal.toLocaleString('en-US', { minimumFractionDigits: 0 }) : '—'}</div>
            <div class="hl-label">Est. Monthly</div>
          </div>
          <div class="highlight-tile">
            <div class="hl-val" style="color:${r.lead_score != null && window.LeadScore ? LeadScore.scoreColor(r.lead_score) : 'inherit'}">${r.lead_score != null ? `${r.lead_score}%` : '—'}</div>
            <div class="hl-label">Lead quality</div>
          </div>
          <div class="highlight-tile">
            <div class="hl-val">${svcCount}</div>
            <div class="hl-label">Services</div>
          </div>
          <div class="highlight-tile">
            <div class="hl-val">${createdDays}d</div>
            <div class="hl-label">Age</div>
          </div>
          <div class="highlight-tile">
            <div class="hl-val">${r.assigned_name ? esc(r.assigned_name.split(' ')[0]) : '—'}</div>
            <div class="hl-label">Dispatcher</div>
          </div>
        </div>

        ${r.lead_tips && r.lead_tips.length ? `<div class="score-tips"><b>To improve this lead:</b> ${r.lead_tips.map(esc).join(' · ')}</div>` : ''}
        <div class="record-actions" id="waActions">${waButtonsHtml()}
          ${r.can_edit && !editing ? '<button class="btn small" id="editBtn">✏️ Edit Record</button>' : ''}
          ${r.can_edit && r.can_manage ? '<button class="btn small" id="deleteBtn" style="color:var(--danger)">🗑 Delete</button>' : ''}
        </div>
      </div>

      <div class="grid-2">
        <!-- LEFT COLUMN: Detail Sections -->
        <div class="stack">
          <div class="card">
            ${editing ? `
              <form id="editForm">
                <h2 style="margin-bottom:.8rem">Edit Record</h2>
                <div class="edit-grid">
                  <div class="field"><label>Full Name</label><input name="name" value="${esc(r.customer_name)}" placeholder="Customer name"></div>
                  <div class="field"><label>Company</label><input name="company" value="${esc(r.company || '')}" placeholder="Company / Organization"></div>
                  <div class="field"><label>Phone</label><input name="phone" value="${esc(r.phone)}" placeholder="(555) 123-4567"></div>
                  <div class="field"><label>Alt Phone</label><input name="alt_phone" value="${esc(r.alt_phone || '')}" placeholder="Secondary number"></div>
                  <div class="field"><label>Email</label><input name="email" value="${esc(r.email)}" placeholder="email@example.com"></div>
                  <div class="field"><label>Contact Preference</label>
                    <select name="contact_pref">${CONTACT_PREFS.map((p) => `<option ${contactPref === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
                  </div>
                  <div class="field full"><label>Address</label><input name="address" value="${esc(r.address)}" placeholder="Street address"></div>
                  <div class="field"><label>City</label><input name="city" value="${esc(r.city || '')}" placeholder="City"></div>
                  <div class="field"><label>Date of Birth</label><input name="dob" value="${esc(usDate(r.dob))}" placeholder="MM/DD/YYYY" inputmode="numeric"></div>
                  <div class="field"><label>ZIP</label><input name="zip" value="${esc(r.zip || '')}" placeholder="ZIP code"></div>
                  <div class="field full"><label>Services</label><div class="row" style="gap:.4rem">${SERVICES.map((s) => `<button type="button" class="toggle ${rs.has(s) ? 'on' : ''}" data-esvc="${s}">${s}</button>`).join('')}</div></div>
                  <div class="field"><label>Lead Priority</label>
                    <select name="lead_priority">${PRIORITIES.map((p) => `<option ${priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
                  </div>
                  <div class="field"><label>Est. Monthly Value ($)</label><input name="est_monthly_value" type="number" step="0.01" min="0" value="${estVal}" placeholder="0.00"></div>
                  <div class="field full"><label>Package Details</label><textarea name="package_details" rows="2" placeholder="e.g. Internet 500, TV Select, Mobile line">${esc(r.package_details || '')}</textarea></div>
                  <div class="field full"><label>Notes</label><textarea name="notes" rows="3" placeholder="Internal notes about this lead">${esc(r.notes)}</textarea></div>
                </div>
                <div id="editErr" style="margin-top:.6rem"></div>
                <div class="row" style="margin-top:.8rem"><button class="btn primary">💾 Save Changes</button><button type="button" class="btn" id="cancelEdit">Cancel</button></div>
              </form>
            ` : `
              <!-- CONTACT INFORMATION -->
              <div class="record-section" data-section="contact">
                <div class="record-section-header" data-toggle-section>
                  <h3>Contact Information</h3>
                  <span class="section-chevron">▼</span>
                </div>
                <div class="record-fields">
                  <div class="field-row">
                    <span class="field-label">Full Name</span>
                    ${fv(esc(r.customer_name))}
                  </div>
                  <div class="field-row">
                    <span class="field-label">Company</span>
                    ${fv(r.company ? esc(r.company) : '')}
                  </div>
                  <div class="field-row">
                    <span class="field-label">Phone</span>
                    ${r.phone ? `<span class="field-value"><a href="tel:${esc(r.phone.replace(/[^\\d+]/g, ''))}">${esc(r.phone)}</a></span>` : empty}
                  </div>
                  <div class="field-row">
                    <span class="field-label">Alt Phone</span>
                    ${r.alt_phone ? `<span class="field-value"><a href="tel:${esc(r.alt_phone.replace(/[^\\d+]/g, ''))}">${esc(r.alt_phone)}</a></span>` : empty}
                  </div>
                  <div class="field-row">
                    <span class="field-label">Email</span>
                    ${r.email ? `<span class="field-value"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></span>` : empty}
                  </div>
                  <div class="field-row">
                    <span class="field-label">Preferred Contact</span>
                    <span class="field-value"><span class="pref-chip">🕐 ${esc(contactPref)}</span></span>
                  </div>
                </div>
              </div>

              <!-- LOCATION -->
              <div class="record-section" data-section="location">
                <div class="record-section-header" data-toggle-section>
                  <h3>Location</h3>
                  <span class="section-chevron">▼</span>
                </div>
                <div class="record-fields">
                  <div class="field-row full-width">
                    <span class="field-label">Address</span>
                    ${r.address ? `<span class="field-value"><a href="https://maps.google.com/?q=${encodeURIComponent(r.address)}" target="_blank" rel="noopener">📍 ${esc(r.address)}</a></span>` : empty}
                  </div>
                  <div class="field-row">
                    <span class="field-label">City</span>
                    ${fv(r.city ? esc(r.city) : '')}
                  </div>
                  <div class="field-row">
                    <span class="field-label">ZIP Code</span>
                    ${fv(r.zip ? esc(r.zip) : '')}
                  </div>
                </div>
              </div>

              <!-- LEAD DETAILS -->
              <div class="record-section" data-section="lead">
                <div class="record-section-header" data-toggle-section>
                  <h3>Lead Details</h3>
                  <span class="section-chevron">▼</span>
                </div>
                <div class="record-fields">
                  <div class="field-row">
                    <span class="field-label">Priority</span>
                    <span class="field-value"><span class="priority-badge ${esc(priority)}">${esc(priority)}</span></span>
                  </div>
                  <div class="field-row">
                    <span class="field-label">Est. Monthly Value</span>
                    ${estVal ? `<span class="field-value value-highlight">$${estVal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>` : empty}
                  </div>
                  <div class="field-row">
                    <span class="field-label">Created By</span>
                    <span class="field-value">${esc(r.created_by_name)}${r.team_name ? ` <span class="muted small">(${esc(r.team_name)})</span>` : ''}</span>
                  </div>
                  <div class="field-row">
                    <span class="field-label">Created</span>
                    <span class="field-value">${fullDate(r.created_at)}</span>
                  </div>
                  <div class="field-row">
                    <span class="field-label">Last Updated</span>
                    <span class="field-value">${fullDate(r.updated_at)}</span>
                  </div>
                  <div class="field-row">
                    <span class="field-label">Dispatch</span>
                    <span class="field-value">${r.assigned_name ? esc(r.assigned_name) : '<span class="muted">Unassigned</span>'}</span>
                  </div>
                </div>
              </div>

              <!-- ACCOUNT & SERVICES -->
              <div class="record-section" data-section="account">
                <div class="record-section-header" data-toggle-section>
                  <h3>Account &amp; Services</h3>
                  <span class="section-chevron">▼</span>
                </div>
                <div class="record-fields">
                  <div class="field-row">
                    <span class="field-label">Services</span>
                    <span class="field-value">${svcTags(r.services) || '<span class="empty">—</span>'}</span>
                  </div>
                  <div class="field-row">
                    <span class="field-label">Package Details</span>
                    ${fv(r.package_details ? esc(r.package_details) : '')}
                  </div>
                  <div class="field-row">
                    <span class="field-label">Account #</span>
                    ${fv(r.account_number ? esc(r.account_number) : '')}
                  </div>
                  ${r.commission != null ? `<div class="field-row">
                    <span class="field-label">Commission</span>
                    <span class="field-value">$${Number(r.commission).toFixed(2)}</span>
                  </div>` : ''}
                  <div class="field-row">
                    <span class="field-label">Date of Birth</span>
                    ${fv(r.dob ? esc(usDate(r.dob)) : '')}
                  </div>
                  <div class="field-row">
                    <span class="field-label">Install Date</span>
                    ${r.install_date ? `<span class="field-value">${esc(dayDate(r.install_date))}</span>` : empty}
                  </div>
                </div>
              </div>

              <!-- NOTES -->
              <div class="record-section" data-section="notes">
                <div class="record-section-header" data-toggle-section>
                  <h3>Notes</h3>
                  <span class="section-chevron">▼</span>
                </div>
                <div class="record-fields single-col">
                  <div class="field-row full-width">
                    <span class="field-value" style="white-space:pre-wrap">${esc(r.notes) || '<span class="empty">No notes recorded.</span>'}</span>
                  </div>
                </div>
              </div>

              ${r.raw_text ? `<details class="raw" style="margin-top:.5rem"><summary class="small muted" style="cursor:pointer">View original entry text</summary><pre style="margin:.5rem 0 0;padding:.7rem;background:var(--surface-2);border-radius:8px;font-size:.82rem;overflow-x:auto">${esc(r.raw_text)}</pre></details>` : ''}
            `}
          </div>

          ${r.can_manage ? `
          <div class="card">
            <h2>Update Status</h2>
            <div class="seg" id="statusSeg" style="margin-bottom:.9rem">${STATUSES.map((s) => `<button data-s="${s}" class="${r.status === s ? 'on' : ''}">${s}</button>`).join('')}</div>
            <form id="acctForm" class="fix-grid" style="margin:0">
              <div><label for="acct">Spectrum account / order #</label><input id="acct" name="acct" value="${esc(r.account_number)}"></div>
              <div><label for="inst">Install date</label><input id="inst" name="inst" type="date" value="${esc(r.install_date)}"></div>
              ${isAdmin() ? `<div><label for="comm">Commission ($)</label><input id="comm" name="comm" type="number" min="0" step="0.01" inputmode="decimal" value="${r.commission != null ? esc(r.commission) : ''}" placeholder="paid to the seller"></div>` : ''}
              <div class="full"><button class="btn">Save</button></div>
            </form>
          </div>` : ''}

          ${r.can_assign ? `
          <div class="card">
            <h2>Dispatch Assignment</h2>
            <div class="row">
              <select id="assignSel" style="flex:1;width:auto;min-width:0"><option value="">Unassigned</option>${ppl.dispatchers.map((d) => `<option value="${d.id}" ${r.assigned_to === d.id ? 'selected' : ''}>${esc(d.full_name)}${d.role === 'admin' ? ' (admin)' : ''}</option>`).join('')}</select>
              ${r.assigned_to !== state.me.id ? '<button class="btn primary" id="takeBtn">Take it</button>' : ''}
            </div>
          </div>` : ''}
        </div>

        <!-- RIGHT COLUMN: Activity Sidebar -->
        <div class="activity-sidebar">
          <div class="card">
            <h2>📞 Call-back reminder</h2>
            ${r.follow_up_at && !r.follow_up_sent ? `<p style="margin-top:0">Reminder set for <b>${esc(fullDate(r.follow_up_at))}</b>${r.follow_up_note ? ` — ${esc(r.follow_up_note)}` : ''}</p>` : '<p class="small muted" style="margin-top:0">Get a notification when it\'s time to call this customer back.</p>'}
            <div class="row fu-quick">${[['1h', 'In 1 hour'], ['t10', 'Tomorrow 10am'], ['t17', 'Tomorrow 5pm']].map(([k, l]) => `<button type="button" class="btn small" data-fu="${k}">${l}</button>`).join('')}</div>
            <form id="fuForm" class="fu-form">
              <input type="datetime-local" id="fuAt" aria-label="Call-back time" required>
              <input id="fuNote" maxlength="200" placeholder="Note (optional)" aria-label="Note" value="${esc(r.follow_up_sent ? '' : r.follow_up_note || '')}">
              <button class="btn primary">Set reminder</button>
              ${r.follow_up_at && !r.follow_up_sent ? '<button type="button" class="btn" id="fuClear">Clear</button>' : ''}
            </form>
          </div>

          <div class="card">
            <h2>Activity Timeline</h2>
            <ul class="timeline">${r.history.map((h) => `<li>${fullDate(h.created_at)} — ${esc(h.full_name)} ${h.from_status ? `changed <b>${esc(h.from_status)}</b> → <b>${esc(h.to_status)}</b>` : 'entered the referral'}</li>`).join('')}</ul>
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
        </div>
      </div>`);

    // Section collapse toggles
    document.querySelectorAll('[data-toggle-section]').forEach((hdr) => {
      hdr.onclick = () => hdr.closest('.record-section').classList.toggle('collapsed');
    });

    const editBtn = document.getElementById('editBtn');
    if (editBtn) editBtn.onclick = () => { state.editing = r.id; renderReferral(id); };
    bindWhatsapp(document.getElementById('waActions'), r);
    const fuForm = document.getElementById('fuForm');
    if (fuForm) {
      const fuAt = document.getElementById('fuAt');
      const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      if (r.follow_up_at && !r.follow_up_sent) fuAt.value = localInput(parseDate(r.follow_up_at));
      const save = async (when) => {
        try {
          await api(`/referrals/${r.id}/follow-up`, { method: 'PUT', body: { at: when.toISOString(), note: document.getElementById('fuNote').value } });
          toast(`Reminder set for ${when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`);
          renderReferral(id);
        } catch (err) { toast(err.message); }
      };
      document.querySelectorAll('[data-fu]').forEach((b) => {
        b.onclick = () => {
          const d = new Date();
          if (b.dataset.fu === '1h') d.setHours(d.getHours() + 1);
          else { d.setDate(d.getDate() + 1); d.setHours(b.dataset.fu === 't10' ? 10 : 17, 0, 0, 0); }
          save(d);
        };
      });
      fuForm.onsubmit = (e) => { e.preventDefault(); if (fuAt.value) save(new Date(fuAt.value)); };
      const fuClear = document.getElementById('fuClear');
      if (fuClear) fuClear.onclick = async () => { await api(`/referrals/${r.id}/follow-up`, { method: 'PUT', body: { at: null } }); toast('Reminder cleared'); renderReferral(id); };
    }

    const editForm = document.getElementById('editForm');
    if (editForm) {
      attachAddressSuggest(editForm.address, (x) => { editForm.address.value = x.line1; if (x.city) editForm.city.value = x.city; if (x.zip) editForm.zip.value = x.zip; });
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
        const body = { account_number: acctForm.acct.value, install_date: acctForm.inst.value };
        if (acctForm.comm) body.commission = acctForm.comm.value === '' ? null : Number(acctForm.comm.value);
        await api('/referrals/' + r.id, { method: 'PATCH', body });
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
    if (!seesAll()) { location.hash = defaultRoute(); return; }
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
              <td>${d.matched_referral_id ? `<a href="#/r/${d.matched_referral_id}">${esc(d.matched_name || 'No name')}</a> ${pill(d.matched_status)}<div class="small muted">${esc(d.matched_owner_name || '')}${d.matched_owner_team ? ` · ${esc(d.matched_owner_team)}` : ''}</div>` : (/past sale/.test(d.matched_on) ? '<span class="muted">Past sale (uploaded list)</span>' : '<span class="muted">deleted</span>')}</td>
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

  // Small in-app prompt (replaces window.prompt). Resolves to the value, or null if cancelled.
  function askModal({ title, label, value = '', type = 'text', hint = '', ok = 'Save' }) {
    return new Promise((resolve) => {
      const m = modal(`<form><h2>${esc(title)}</h2>
        <div class="field"><label for="askIn">${esc(label)}</label><input id="askIn" type="${type}" value="${esc(value)}"></div>
        ${hint ? `<p class="small muted">${hint}</p>` : ''}
        <div class="row" style="justify-content:flex-end;margin-top:1rem"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${esc(ok)}</button></div></form>`);
      const input = m.querySelector('#askIn');
      input.select();
      m.querySelector('form').onsubmit = (e) => { e.preventDefault(); const v = input.value; closeModal(); resolve(v); };
      m.parentElement.addEventListener('click', (e) => { if (e.target === m.parentElement || e.target.closest('[data-close]')) resolve(null); });
    });
  }

  const ago = (iso) => (iso ? `<span title="${esc(fullDate(iso))}">${when(iso)}</span>` : '<span class="muted">never</span>');
  const daysSince = (iso) => (iso ? (Date.now() - parseDate(iso)) / 86400000 : Infinity);
  function browserName(ua) {
    const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${b} on ${os}` : b;
  }

  // Admin → Settings: link a phone's WhatsApp by QR code, pick the dispatch group.
  let waPoll = null;
  async function drawWaLink() {
    clearTimeout(waPoll);
    const card = document.getElementById('waLinkCard');
    if (!card) return;
    let s;
    try { s = await api('/whatsapp/status'); } catch (err) { card.innerHTML = `<h2>WhatsApp alerts</h2><div class="alert err small">${esc(err.message)}</div>`; return; }
    if (!document.getElementById('waLinkCard')) return;
    const chip = { off: ['Off', ''], starting: ['Connecting…', 'wait'], qr: ['Scan the QR code', 'wait'], connected: ['Connected', 'ok'], reconnecting: ['Reconnecting…', 'wait'], logged_out: ['Disconnected — scan again', 'bad'], replaced: ['Linked somewhere else', 'bad'] }[s.status] || [s.status, ''];
    const intro = `<p class="small muted" style="margin-top:0">Link a phone's WhatsApp (like WhatsApp Web) so the app can post every new lead to your dispatch group and send people their alerts. <b>Use a separate number just for alerts</b> — WhatsApp doesn't officially allow this kind of link and can block the number. The app's own notifications keep working either way.</p>`;
    let body = '';
    if (s.status === 'off' || s.status === 'logged_out' || s.status === 'replaced') {
      body = `${s.status !== 'off' ? `<div class="alert warn small">${s.status === 'replaced' ? 'This WhatsApp was linked to another computer, so it disconnected here. Connect again to take it back.' : 'The phone disconnected this link. Connect and scan again.'}</div>` : ''}
        <button class="btn primary" id="waConnect">Connect WhatsApp</button>`;
    } else if (s.status === 'qr' && s.qr) {
      body = `<div class="wa-qr"><img src="${s.qr}" alt="WhatsApp QR code" width="240" height="240">
        <ol class="small"><li>On the alerts phone, open <b>WhatsApp</b>.</li><li>Tap <b>Settings</b> (iPhone) or <b>⋮</b> (Android) → <b>Linked devices</b> → <b>Link a device</b>.</li><li>Point the phone at this code. It refreshes by itself.</li></ol></div>
        <button class="btn" id="waCancel">Cancel</button>`;
    } else if (s.status === 'connected') {
      body = `<p style="margin:.2rem 0 .8rem">Linked to <b>${esc(s.me && s.me.name ? s.me.name : 'WhatsApp')}</b>${s.me && s.me.number ? ` · +${esc(s.me.number)}` : ''}. ${s.people} ${s.people === 1 ? 'person gets' : 'people get'} their alerts on WhatsApp.${s.queued ? ` ${s.queued} message${s.queued === 1 ? '' : 's'} waiting to send.` : ''}</p>
        <div class="field"><label for="waGroup">Post new leads to this group</label>
          <div class="row" style="flex-wrap:nowrap"><select id="waGroup" style="flex:1;min-width:0"><option value="">${s.group ? esc(s.group.name) : 'Loading groups…'}</option></select><button type="button" class="btn" id="waTestGroup" ${s.group ? '' : 'disabled'}>Send a test</button></div>
          <p class="small muted" style="margin:.3rem 0 0">Add the alerts number to your dispatch group first, then pick it here.</p></div>
        <label class="check"><input type="checkbox" id="waNewLead" ${s.new_lead_group ? 'checked' : ''}> Post every new lead to the group (in the format below)</label>
        <div style="margin-top:.9rem"><button type="button" class="btn danger" id="waDisconnect">Disconnect</button></div>`;
    } else {
      body = `<p class="small">${s.status === 'reconnecting' ? 'The link dropped; reconnecting by itself…' : 'Connecting…'}${s.error ? ` <span class="muted">(${esc(s.error)})</span>` : ''}</p><button type="button" class="btn danger" id="waDisconnect">Disconnect</button>`;
    }
    card.innerHTML = `<div class="row between"><h2 style="margin:0">WhatsApp alerts</h2><span class="wa-state ${chip[1]}">${chip[0]}</span></div>${intro}${body}`;
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on('waConnect', async () => { await api('/whatsapp/connect', { method: 'POST', body: {} }).catch((e) => toast(e.message)); drawWaLink(); });
    on('waCancel', async () => { await api('/whatsapp/disconnect', { method: 'POST', body: {} }).catch(() => {}); drawWaLink(); });
    on('waDisconnect', async () => {
      if (!confirm('Disconnect WhatsApp alerts? New leads will only alert in the app until you connect again.')) return;
      await api('/whatsapp/disconnect', { method: 'POST', body: {} }).catch((e) => toast(e.message)); drawWaLink();
    });
    on('waTestGroup', async () => { try { await api('/whatsapp/test', { method: 'POST', body: { target: 'group' } }); toast('Test sent to the group'); } catch (err) { toast(err.message); } });
    const nl = document.getElementById('waNewLead');
    if (nl) nl.onchange = async () => { try { await api('/whatsapp/settings', { method: 'PATCH', body: { new_lead_group: nl.checked } }); toast(nl.checked ? 'New leads will be posted' : 'New leads won\'t be posted'); } catch (err) { toast(err.message); } };
    const sel = document.getElementById('waGroup');
    if (sel) {
      try {
        const groups = await api('/whatsapp/groups');
        sel.innerHTML = `<option value="">— pick a group —</option>${groups.map((g) => `<option value="${esc(g.id)}" ${s.group && s.group.id === g.id ? 'selected' : ''}>${esc(g.name)} (${g.size})</option>`).join('')}`;
      } catch (err) { sel.innerHTML = `<option value="">${esc(err.message)}</option>`; }
      sel.onchange = async () => {
        const opt = sel.selectedOptions[0];
        try {
          await api('/whatsapp/settings', { method: 'PATCH', body: { group_id: sel.value, group_name: sel.value ? opt.textContent.replace(/ \(\d+\)$/, '') : '' } });
          toast(sel.value ? 'Dispatch group saved' : 'Group cleared');
          document.getElementById('waTestGroup').disabled = !sel.value;
        } catch (err) { toast(err.message); }
      };
    }
    // Keep the QR code and status fresh while something is happening.
    if (['starting', 'qr', 'reconnecting'].includes(s.status)) waPoll = setTimeout(drawWaLink, 2500);
  }

  async function renderTeam() {
    if (!managesUsers()) { location.hash = defaultRoute(); return; }
    const onSettingsTab = isAdmin() && query().tab === 'settings';
    const [users, teams, settings, security, emailCfg, speedCfg] = await Promise.all([
      api('/users'), api('/teams'),
      isAdmin() ? api('/settings') : Promise.resolve(null),
      isAdmin() ? api('/admin/security') : Promise.resolve(null),
      isAdmin() ? api('/admin/email') : Promise.resolve(null),
      onSettingsTab ? api('/speed/settings') : Promise.resolve(null),
    ]);
    const emailOn = state.me.email_enabled;
    const flash = state.flash; state.flash = null;
    const roles = ['rep', 'manager', 'dispatch', 'admin'];
    const q = query();
    // Admins see one section at a time (sub-tabs); managers see their one page.
    const tab = isAdmin() ? (['invites', 'past-sales', 'settings'].includes(q.tab) ? q.tab : 'users') : 'users';
    const filter = q.show || 'active';
    const shown = users.filter((u) => (filter === 'all' ? true : filter === 'inactive' ? !u.active : u.active));

    shell(`
      ${flash ? `<div class="card flash">
        <div class="alert ok" style="margin-bottom:.6rem">${esc(flash.title)}</div>
        ${flash.emailed ? `<p style="margin:0">✉ We emailed the sign-in details to <b>${esc(flash.emailed)}</b>.</p>`
          : `${flash.emailError ? `<div class="alert warn small" style="margin-bottom:.6rem">The email didn't go out: ${esc(flash.emailError)}</div>` : ''}
            <p style="margin:0 0 .4rem">Give <b>${esc(flash.username)}</b> this temporary password. They'll pick their own when they sign in:</p>
            <span class="secret">${esc(flash.password)}</span> <button class="btn small" id="copyPw">Copy</button>`}</div>` : ''}
      ${isAdmin() && tab === 'users' ? `
      <div class="card">
        <div class="row between"><h2 style="margin:0">Account activity</h2><span class="small muted">Signed-in = used the app in that window</span></div>
        <div class="stats sec-stats" style="margin-top:.8rem">
          <div class="stat"><div class="n">${security.active_today}<span class="of">/${security.users}</span></div><div class="l">Active today</div></div>
          <div class="stat"><div class="n">${security.active_7d}</div><div class="l">Active this week</div></div>
          <div class="stat"><div class="n">${security.never_signed_in}</div><div class="l">Never signed in</div></div>
          <div class="stat"><div class="n">${security.inactive_30d}</div><div class="l">Away 30+ days</div></div>
          <div class="stat"><div class="n">${security.old_passwords}</div><div class="l">Password 90+ days old</div></div>
          <div class="stat ${security.failed_24h >= 5 ? 'warn' : ''}"><div class="n">${security.failed_24h}</div><div class="l">Failed sign-ins (24h)</div></div>
        </div>
        ${security.recent_failed.length ? `<details style="margin-top:.8rem"><summary class="small">Recent failed sign-ins</summary>
          <div class="table-wrap"><table class="rtable"><thead><tr><th>When</th><th>Tried as</th><th>Why</th><th>IP</th></tr></thead><tbody>
          ${security.recent_failed.map((f) => `<tr><td data-label="When">${ago(f.created_at)}</td><td data-label="Tried as"><b>${esc(f.username)}</b>${f.full_name ? ` <span class="muted small">${esc(f.full_name)}</span>` : ''}</td><td data-label="Why">${esc(f.reason)}</td><td data-label="IP" class="small muted">${esc(f.ip)}</td></tr>`).join('')}
          </tbody></table></div></details>` : ''}
      </div>` : ''}
      ${isAdmin() && tab === 'invites' ? `
      <div class="card" id="invitesCard">
        <div class="row between"><h2 style="margin:0">Invite links</h2><span class="small muted">People sign themselves up; you pick their role and team.</span></div>
        <form class="invite-form" id="inviteForm">
          <div><label for="iv_role">Role</label><select id="iv_role">${roles.map((r) => `<option value="${r}">${roleLabel(r)}</option>`).join('')}</select></div>
          <div><label for="iv_team">Team</label><select id="iv_team"><option value="">— none (admin &amp; dispatch only) —</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
          <div><label for="iv_uses">Can be used</label><select id="iv_uses"><option value="1">Once (one person)</option><option value="5">Up to 5 people</option><option value="10">Up to 10 people</option><option value="25">Up to 25 people</option><option value="100">Up to 100 people</option></select></div>
          <div><label for="iv_days">Expires after</label><select id="iv_days"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></div>
          <div class="iv-note"><label for="iv_note">Note <span class="muted small">(optional, only you see it)</span></label><input id="iv_note" maxlength="120" placeholder="e.g. October hires, North Crew"></div>
          <div class="iv-emails"><label for="iv_emails">Email it to <span class="muted small">(optional — separate addresses with commas)</span></label>
            <textarea id="iv_emails" rows="2" autocapitalize="none" placeholder="${emailOn ? 'maria@email.com, james@email.com' : 'Available once email is switched on'}" ${emailOn ? '' : 'disabled'}></textarea></div>
          <div class="iv-emails"><label for="iv_msg">Personal message <span class="muted small">(optional, goes in the email)</span></label><input id="iv_msg" maxlength="500" placeholder="e.g. Welcome to the North Crew — sign up before Monday's meeting" ${emailOn ? '' : 'disabled'}></div>
          <div class="iv-go"><button class="btn primary" id="ivGo">Create invite link</button></div>
        </form>
        <div id="inviteNew"></div>
        <div id="inviteList" class="small muted">Loading invites…</div>
      </div>` : ''}
      ${isAdmin() && tab === 'past-sales' ? `
      <div class="card" id="historyCard">
        <div class="row between"><h2 style="margin:0">Past sales</h2><span class="small muted">Blocks old customers as duplicates. Never shown in the portal.</span></div>
        <p class="small muted" style="margin:.4rem 0 .8rem">Upload old sales spreadsheets (.xlsx or .csv). Every phone number and street address in them is added to the duplicate check, so nobody can enter those customers again. Only the phone and address are kept — no names, account numbers or amounts — and they don't appear in customer lists, search or reports.</p>
        <form class="history-form" id="historyForm">
          <div><label for="hs_file">Spreadsheet</label><input type="file" id="hs_file" accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" required></div>
          <div><label for="hs_note">Note <span class="muted small">(optional)</span></label><input id="hs_note" maxlength="200" placeholder="e.g. Pay reports May–Sep 2026"></div>
          <div class="iv-go"><button class="btn" id="hsCheck">Check file</button></div>
        </form>
        <div id="historyPreview"></div>
        <div id="historyList" class="small muted">Loading uploads…</div>
      </div>` : ''}
      ${tab === 'users' ? `
      <div class="grid-2">
        <form class="card" id="addUser">
          <h2>Add a ${isAdmin() ? 'user' : 'rep to ' + esc(state.me.team_name || 'your team')}</h2>
          <div class="field"><label for="au_name">Full name</label><input id="au_name" name="full_name" required></div>
          <div class="field"><label for="au_user">Username</label><input id="au_user" name="username" autocapitalize="none" placeholder="e.g. jsmith" required></div>
          <div class="field"><label for="au_email">Email</label><input id="au_email" name="email" type="email" autocapitalize="none" placeholder="for alerts, welcome email and password resets"></div>
          ${isAdmin() ? `
            <div class="field"><label for="au_role">Role</label><select id="au_role" name="role">${roles.map((r) => `<option value="${r}">${roleLabel(r)}</option>`).join('')}</select>
              <p class="small muted" style="margin:.3rem 0 0" id="roleHelp"></p></div>
            <div class="field"><label for="au_team">Team</label><select id="au_team" name="team_id"><option value="">— none (admin & dispatch only) —</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>` : ''}
          <label class="check" style="margin-top:.9rem"><input type="checkbox" id="au_welcome" ${emailOn ? 'checked' : 'disabled'}> Email them a welcome with their sign-in details</label>
          ${emailOn ? '' : '<p class="small muted" style="margin:.2rem 0 0">Available once email is switched on.</p>'}
          <div id="addErr" style="margin-top:.6rem"></div>
          <button class="btn primary" style="margin-top:.8rem">Add user</button>
        </form>
        ${isAdmin() ? `
        <div class="card">
          <h2>Teams</h2>
          <ul class="lead-list">${teams.map((t) => `<li style="cursor:default"><div class="who"><b>${esc(t.name)}</b><span>${t.members} active member${t.members === 1 ? '' : 's'}</span></div><button class="btn small" data-rename="${t.id}" data-name="${esc(t.name)}">Rename</button></li>`).join('') || '<li class="muted">No teams yet — add one below.</li>'}</ul>
          <form class="row" id="addTeam" style="margin-top:.8rem"><input name="name" placeholder="New team name" style="flex:1;width:auto;min-width:0" required><button class="btn">Add team</button></form>
        </div>` : `
        <div class="card"><h2>Tips</h2><p class="muted small">Add each rep's email so they get a welcome email, alerts, and can reset their own password with an emailed code.<br><br>If someone is locked out, hit <b>Reset password</b>. You can email them the new temporary password or read it to them.<br><br>Deactivated users can't sign in, but their sales stay on the books.</p></div>`}
      </div>` : ''}
      ${isAdmin() && tab === 'settings' ? `
      <div class="grid-2">
        <form class="card" id="settingsForm">
          <h2>Settings</h2>
          <label class="check"><input type="checkbox" name="auto_assign" ${settings.auto_assign === '1' ? 'checked' : ''}> Automatically assign new leads to dispatch</label>
          <p class="small muted" style="margin:.2rem 0 1rem">Each new lead goes to the active dispatcher with the fewest open leads. Off: leads wait in <b>Unassigned</b> until someone takes them.</p>
          <label class="check"><input type="checkbox" name="new_lead_alert" ${settings.new_lead_alert !== '0' ? 'checked' : ''}> Alert every dispatcher the moment a new lead comes in</label>
          <p class="small muted" style="margin:.2rem 0 1rem">In the app, on their phone, and on WhatsApp for anyone who turned WhatsApp alerts on.</p>
          <label for="tpl">Entry template</label>
          <textarea id="tpl" name="entry_template" rows="7" style="font-family:ui-monospace,Menlo,monospace;font-size:.9rem">${esc(settings.entry_template)}</textarea>
          <p class="small muted" style="margin:.3rem 0 .8rem">Reps can tap <b>Use template</b> to fill the entry box with this. Use labels like Name:, Phone:, Email:, Address:, City:, Zip:, Services:, Notes: — any other label is kept in the notes.</p>
          <button class="btn primary">Save settings</button>
        </form>
        <form class="card" id="emailForm">
          <h2>Email</h2>
          ${emailCfg.enabled ? `<p class="small" style="margin:0 0 .8rem"><b class="ok-text">✓ On.</b> Emails arrive from <b>${esc(emailCfg.from)}</b></p>`
            : '<p class="small" style="margin:0 0 .8rem"><b>Off.</b> In Render, open your service → <b>Environment</b> and add <code>RESEND_API_KEY</code>. The app restarts and email switches on.</p>'}
          <div class="field"><label for="fromName">Sender name</label><input id="fromName" value="${esc(settings.email_from_name)}" placeholder="E&amp;O Referrals" maxlength="60">
            <p class="small muted" style="margin:.3rem 0 0">What people see in their inbox instead of “noreply”. Sending address: <b>${esc(emailCfg.address)}</b>${emailCfg.address === 'onboarding@resend.dev' ? ' (Resend\'s test address — set <code>EMAIL_FROM</code> in Render to use your own domain)' : ''}.</p></div>
          <div class="field"><label for="replyTo">Replies go to <span class="muted small">(optional)</span></label><input id="replyTo" type="email" value="${esc(settings.email_reply_to)}" placeholder="office@yourcompany.com">
            <p class="small muted" style="margin:.3rem 0 0">When someone hits Reply, it goes here instead of the no-reply address.</p></div>
          <div class="row" style="margin-top:.9rem"><button class="btn primary">Save</button>${emailCfg.enabled ? '<button type="button" class="btn" id="testEmail">✉ Send me a test</button>' : ''}</div>
          <div id="testRes" class="small" style="margin-top:.5rem"></div>
          <h2 style="margin-top:1.4rem">Backup & export</h2>
          <div class="row"><a class="btn small" href="/api/admin/backup" download>⬇ Download backup</a><a class="btn small" href="/api/referrals.csv?scope=all">⬇ Export all referrals (CSV)</a></div>
        </form>
      </div>
      <div class="card" id="waLinkCard"><h2>WhatsApp alerts</h2><p class="small muted">Loading…</p></div>
      <form class="card" id="waForm">
        <h2>WhatsApp message for dispatch</h2>
        <p class="small muted" style="margin-top:0">What <b>Copy for WhatsApp</b> puts on the clipboard for every lead. Use <code>*bold*</code> like in WhatsApp. Fields:
          ${WaFormat.FIELDS.map((k) => `<code>{${k}}</code>`).join(' ')}</p>
        <div class="grid-2" style="gap:1rem">
          <div><textarea id="waTpl" rows="11" style="font-family:ui-monospace,Menlo,monospace;font-size:.88rem">${esc(settings.whatsapp_template)}</textarea>
            <div class="field"><label for="waNum">Dispatch WhatsApp number <span class="muted small">(optional — Open WhatsApp goes straight to this chat)</span></label><input id="waNum" inputmode="tel" value="${esc(settings.whatsapp_number)}" placeholder="1 512 555 0142"></div></div>
          <div><label class="small">Preview</label><pre class="wa-preview" id="waPreview"></pre></div>
        </div>
        <div class="row" style="margin-top:.8rem"><button class="btn primary">Save</button><button type="button" class="btn" id="waReset">Reset to default</button></div>
      </form>
      <form class="card" id="speedForm">
        <h2>Speed to lead</h2>
        <p class="small muted" style="margin-top:0">A lead counts as answered the first time dispatch, a manager or an admin changes its status, comments on it, or takes it. Only working hours count, so a lead that comes in at night starts its clock in the morning.</p>
        <label class="check"><input type="checkbox" name="enabled" ${speedCfg.enabled ? 'checked' : ''}> Alert when new leads wait too long</label>
        <div class="speed-grid">
          <div class="field"><label for="sp_min">Alert dispatch after (minutes)</label><input id="sp_min" name="minutes" type="number" min="1" max="1440" value="${speedCfg.minutes}"></div>
          <div class="field"><label for="sp_esc">Alert admins after (minutes)</label><input id="sp_esc" name="escalate" type="number" min="2" max="2880" value="${speedCfg.escalate}"></div>
          <div class="field"><label for="sp_from">Working hours</label>
            <div class="row" style="flex-wrap:nowrap;gap:.4rem"><select id="sp_from">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${+speedCfg.hours.split('-')[0] === h ? 'selected' : ''}>${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>`).join('')}</select>
            <span class="muted">to</span><select id="sp_to">${Array.from({ length: 24 }, (_, i) => i + 1).map((h) => `<option value="${h}" ${+speedCfg.hours.split('-')[1] === h ? 'selected' : ''}>${h === 24 ? 'midnight' : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>`).join('')}</select></div></div>
          <div class="field"><label for="sp_tz">Time zone</label><select id="sp_tz">${[['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'], ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'], ['America/Puerto_Rico', 'Atlantic (Puerto Rico)']].map(([z, l]) => `<option value="${z}" ${speedCfg.tz === z ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        <label class="check" style="margin-top:.6rem"><input type="checkbox" name="auto_reassign" ${speedCfg.autoReassign ? 'checked' : ''}> When admins are alerted, hand the lead to the least-busy other dispatcher</label>
        <div style="margin-top:.9rem"><button class="btn primary">Save</button></div>
      </form>` : ''}
      ${tab === 'users' ? `
      <div class="card">
        <div class="row between"><h2 style="margin:0">${isAdmin() ? 'All users' : 'Team members'}</h2>
          <div class="seg" id="showSeg">${[['active', 'Active'], ['inactive', 'Deactivated'], ['all', 'All']].map(([k, l]) => `<button data-k="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="table-wrap" style="margin-top:.6rem"><table class="rtable users-table">
          <thead><tr><th>Name</th><th>Role</th>${isAdmin() ? '<th>Team</th>' : ''}<th>Last active</th><th>Password changed</th><th class="num">Referrals</th><th class="num">Ordered</th><th></th></tr></thead>
          <tbody>${shown.map((u) => {
            const manageable = isAdmin() || (u.role === 'rep');
            const self = u.id === state.me.id;
            const pwOld = !u.must_change_password && daysSince(u.password_changed_at) > 90;
            return `<tr class="${u.active ? '' : 'inactive'}">
              <td data-label="Name"><b>${esc(u.full_name)}</b><div class="small muted">@${esc(u.username)}${u.active ? '' : ' · deactivated'}${u.must_change_password ? ' · <span class="warn-text">temp password</span>' : ''}</div>
                <div class="small">${u.email ? esc(u.email) : '<span class="muted">no email</span>'}${manageable ? ` <button class="link-btn small" data-email="${u.id}" data-current="${esc(u.email)}">edit</button>` : ''}</div></td>
              <td data-label="Role">${isAdmin() && !self ? `<select data-role="${u.id}" style="width:auto">${roles.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}</select>` : roleLabel(u.role)}
                ${isAdmin() && ['rep', 'dispatch'].includes(u.role) ? `<label class="check small pay-toggle"><input type="checkbox" data-pay="${u.id}" ${u.payments_enabled ? 'checked' : ''}> Payments tab</label>` : ''}</td>
              ${isAdmin() ? `<td data-label="Team"><select data-team="${u.id}" style="width:auto"><option value="">—</option>${teams.map((t) => `<option value="${t.id}" ${u.team_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>` : ''}
              <td data-label="Last active">${ago(u.last_seen_at || u.last_login_at)}<div class="small muted">${u.login_count} sign-in${u.login_count === 1 ? '' : 's'}${u.failed_7d ? ` · <span class="warn-text">${u.failed_7d} failed</span>` : ''}</div></td>
              <td data-label="Password changed">${u.password_changed_at ? `${ago(u.password_changed_at)}${pwOld ? ' <span class="tag">90+ days</span>' : ''}` : '<span class="muted">never</span>'}</td>
              <td data-label="Referrals" class="num"><a href="#/referrals?scope=${isAdmin() ? 'all' : 'team'}&user_id=${u.id}">${u.referral_count}</a>${u.role === 'dispatch' || u.open_assigned ? `<div class="small muted">${u.open_assigned} in queue</div>` : ''}</td>
              <td data-label="Ordered" class="num">${u.ordered_count}</td>
              <td class="actions">${manageable ? `<button class="btn small" data-history="${u.id}" data-name="${esc(u.full_name)}">History</button>` : ''}${manageable && !self ? `
                <button class="btn small" data-reset="${u.id}" data-username="${esc(u.username)}" data-name="${esc(u.full_name)}" data-hasemail="${u.email ? 1 : 0}" data-mail="${esc(u.email)}">Reset password</button>
                <button class="btn small ${u.active ? 'danger' : ''}" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}</td>
            </tr>`;
          }).join('') || `<tr><td colspan="8" class="muted">Nobody here.</td></tr>`}</tbody>
        </table></div>
      </div>` : ''}`);

    document.querySelectorAll('#showSeg button').forEach((b) => { b.onclick = () => { location.hash = `#/team?show=${b.dataset.k}`; }; });
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

    if (tab === 'invites') setupInvites(teams);
    if (tab === 'past-sales') setupHistory();

    const addUser = document.getElementById('addUser');
    if (addUser) addUser.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      body.send_welcome = document.getElementById('au_welcome').checked;
      try {
        const r = await api('/users', { method: 'POST', body });
        peopleCache = null;
        state.flash = { title: `${body.full_name} was added.`, username: r.username, password: r.temp_password,
          emailed: r.welcome && r.welcome.sent ? r.welcome.to : null, emailError: r.welcome && r.welcome.error };
        renderTeam();
        window.scrollTo(0, 0);
      } catch (err) {
        document.getElementById('addErr').innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
    };

    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) settingsForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/settings', { method: 'PATCH', body: { auto_assign: settingsForm.auto_assign.checked, new_lead_alert: settingsForm.new_lead_alert.checked, entry_template: settingsForm.entry_template.value } });
        toast('Settings saved');
      } catch (err) { toast(err.message); }
    };
    const emailForm = document.getElementById('emailForm');
    if (emailForm) {
      emailForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/settings', { method: 'PATCH', body: { email_from_name: document.getElementById('fromName').value, email_reply_to: document.getElementById('replyTo').value } });
          toast('Email settings saved');
          renderTeam();
        } catch (err) { toast(err.message); }
      };
      const tb = document.getElementById('testEmail');
      if (tb) tb.onclick = async () => {
        const out = document.getElementById('testRes');
        tb.disabled = true;
        try {
          const r = await api('/admin/test-email', { method: 'POST', body: {} });
          out.innerHTML = `<span class="ok-text">✓ Sent to ${esc(r.to)}</span>`;
        } catch (err) {
          out.innerHTML = `<span class="err-text">${esc(err.message)}</span>`;
        } finally { tb.disabled = false; }
      };
    }

    document.querySelectorAll('[data-email]').forEach((b) => {
      b.onclick = async () => {
        const email = await askModal({ title: 'Email address', label: 'Email', type: 'email', value: b.dataset.current, hint: 'Used for alerts, the welcome email and password-reset codes. Leave empty to remove.' });
        if (email === null) return;
        try { await api('/users/' + b.dataset.email, { method: 'PATCH', body: { email } }); toast('Email saved'); renderTeam(); } catch (err) { toast(err.message); }
      };
    });
    if (document.getElementById('waLinkCard')) drawWaLink();
    const waForm = document.getElementById('waForm');
    if (waForm) {
      const tpl = document.getElementById('waTpl');
      const sample = { id: 1024, customer_name: 'Maria Lopez', phone: '(512) 867-5309', address: '1010 Ogden Ave, Dallas, TX 75211', dob: '1985-03-14',
        email: 'maria.lopez@gmail.com', services: 'Internet, Mobile', notes: 'Call after 5pm', created_by_name: state.me.full_name, team_name: 'North Crew', status: 'New' };
      const preview = () => { document.getElementById('waPreview').textContent = whatsappMessage(sample, tpl.value).text; };
      tpl.oninput = preview; preview();
      document.getElementById('waReset').onclick = () => { tpl.value = DEFAULT_WA; preview(); };
      waForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          state.appSettings = await api('/settings', { method: 'PATCH', body: { whatsapp_template: tpl.value, whatsapp_number: document.getElementById('waNum').value } });
          toast('WhatsApp message saved');
        } catch (err) { toast(err.message); }
      };
    }

    const speedForm = document.getElementById('speedForm');
    if (speedForm) speedForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/speed/settings', { method: 'PATCH', body: {
          enabled: speedForm.enabled.checked, auto_reassign: speedForm.auto_reassign.checked,
          minutes: Number(speedForm.minutes.value), escalate: Number(speedForm.escalate.value),
          hours: `${document.getElementById('sp_from').value}-${document.getElementById('sp_to').value}`, timezone: document.getElementById('sp_tz').value,
        } });
        toast('Speed-to-lead settings saved');
      } catch (err) { toast(err.message); }
    };

    const addTeam = document.getElementById('addTeam');
    if (addTeam) addTeam.onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/teams', { method: 'POST', body: { name: addTeam.name.value } }); toast('Team added'); renderTeam(); } catch (err) { toast(err.message); }
    };
    document.querySelectorAll('[data-rename]').forEach((b) => {
      b.onclick = async () => {
        const name = await askModal({ title: 'Rename team', label: 'Team name', value: b.dataset.name });
        if (!name) return;
        try { await api('/teams/' + b.dataset.rename, { method: 'PATCH', body: { name } }); renderTeam(); } catch (err) { toast(err.message); }
      };
    });
    document.querySelectorAll('[data-history]').forEach((b) => {
      b.onclick = async () => {
        const rows = await api(`/users/${b.dataset.history}/logins`);
        modal(`<h2>Sign-in history — ${esc(b.dataset.name)}</h2>
          ${rows.length ? `<div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="rtable"><thead><tr><th>When</th><th>Result</th><th>Device</th><th>IP</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td data-label="When">${esc(fullDate(r.created_at))}</td><td data-label="Result">${r.success ? `<span class="ok-text">✓ Signed in</span>${r.reason ? ` <span class="small muted">(${esc(r.reason)})</span>` : ''}` : `<span class="err-text">✕ ${esc(r.reason || 'failed')}</span>`}</td><td data-label="Device" class="small">${esc(browserName(r.user_agent))}</td><td data-label="IP" class="small muted">${esc(r.ip)}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">No sign-ins recorded yet.</p>'}
          <div class="row" style="justify-content:flex-end;margin-top:1rem"><button class="btn" data-close>Close</button></div>`, { wide: true });
      };
    });
    document.querySelectorAll('[data-reset]').forEach((b) => {
      b.onclick = () => {
        const hasEmail = b.dataset.hasemail === '1';
        const m = modal(`<form><h2>Reset password for ${esc(b.dataset.name)}?</h2>
          <p>Their current password stops working and they're signed out everywhere. They'll get a temporary password and pick a new one when they sign in.</p>
          ${hasEmail && emailOn ? `<label class="check"><input type="checkbox" id="rsEmail" checked> Email the temporary password to ${esc(b.dataset.mail)}</label>` : ''}
          <div class="row" style="justify-content:flex-end;margin-top:1rem"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Reset password</button></div></form>`);
        m.querySelector('form').onsubmit = async (e) => {
          e.preventDefault();
          const sendEmail = !!m.querySelector('#rsEmail')?.checked;
          closeModal();
          try {
            const r = await api(`/users/${b.dataset.reset}/reset-password`, { method: 'POST', body: { send_email: sendEmail } });
            state.flash = { title: 'Password reset.', username: b.dataset.username, password: r.temp_password,
              emailed: r.emailed && r.emailed.sent ? r.emailed.to : null, emailError: r.emailed && r.emailed.error };
            renderTeam();
            window.scrollTo(0, 0);
          } catch (err) { toast(err.message); }
        };
      };
    });
    document.querySelectorAll('[data-active]').forEach((b) => {
      b.onclick = async () => {
        try { await api('/users/' + b.dataset.active, { method: 'PATCH', body: { active: b.dataset.to === '1' } }); peopleCache = null; renderTeam(); } catch (err) { toast(err.message); }
      };
    });
    document.querySelectorAll('select[data-role]').forEach((sel) => {
      sel.onchange = async () => { try { await api('/users/' + sel.dataset.role, { method: 'PATCH', body: { role: sel.value } }); peopleCache = null; toast('Role updated'); renderTeam(); } catch (err) { toast(err.message); } };
    });
    document.querySelectorAll('select[data-team]').forEach((sel) => {
      sel.onchange = async () => { try { await api('/users/' + sel.dataset.team, { method: 'PATCH', body: { team_id: sel.value || null } }); peopleCache = null; toast('Team updated'); } catch (err) { toast(err.message); } };
    });
    document.querySelectorAll('input[data-pay]').forEach((cb) => {
      cb.onchange = async () => {
        try { await api(`/users/${cb.dataset.pay}/payments`, { method: 'PATCH', body: { enabled: cb.checked } }); toast(cb.checked ? 'Payments tab switched on' : 'Payments tab switched off'); } catch (err) { cb.checked = !cb.checked; toast(err.message); }
      };
    });
  }

  // ---------- dashboard ----------

  const WIDGET_INFO = {
    kpis: { title: 'Key numbers', size: 'full', about: 'Entered, ordered, conversion and more, compared with the previous period.' },
    insights: { title: 'Insights', size: 'full', about: 'Things worth knowing, worked out from your numbers.' },
    trend: { title: 'Daily trend', size: 'full', about: 'Referrals entered and orders marked, day by day.' },
    status: { title: 'Status mix', size: 'half', about: 'Where the period\'s referrals stand now.' },
    funnel: { title: 'Funnel', size: 'half', about: 'Entered → worked → ordered.' },
    services: { title: 'Services', size: 'half', about: 'What customers want, and what converts.' },
    leaderboard: { title: 'Leaderboard', size: 'half', about: 'Top reps by orders.' },
    teams: { title: 'Teams', size: 'half', about: 'Every team side by side.' },
    dispatch: { title: 'Dispatch workload', size: 'half', about: 'Open leads per dispatcher, and unassigned leads.' },
    stale: { title: 'Needs attention', size: 'half', about: 'Leads still New after 3+ days.' },
    installs: { title: 'Upcoming installs', size: 'half', about: 'Installs in the next two weeks.' },
    activity: { title: 'Recent activity', size: 'half', about: 'Latest status changes and comments.' },
    speed: { title: 'Speed to lead', size: 'half', about: 'How fast new leads get a first response, in working hours, and who is waiting right now.' },
    followups: { title: 'My call-backs', size: 'half', about: 'Call-back reminders you\'ve set, soonest first.' },
  };

  const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function dashRange(key, custom) {
    const d = new Date();
    const back = (n) => { const x = new Date(d); x.setDate(d.getDate() - n); return localYmd(x); };
    switch (key) {
      case 'today': return { from: localYmd(d), to: localYmd(d) };
      case '7d': return { from: back(6), to: localYmd(d) };
      case '30d': return { from: back(29), to: localYmd(d) };
      case 'month': return { from: localYmd(new Date(d.getFullYear(), d.getMonth(), 1)), to: localYmd(d) };
      case 'lastmonth': return { from: localYmd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: localYmd(new Date(d.getFullYear(), d.getMonth(), 0)) };
      case '90d': return { from: back(89), to: localYmd(d) };
      case 'year': return { from: `${d.getFullYear()}-01-01`, to: localYmd(d) };
      case 'custom': return custom;
      default: return {};
    }
  }
  const PERIODS = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['90d', '90 days'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Custom']];

  async function renderHome() {
    const params = query();
    const period = params.period || 'month';
    const range = dashRange(period, { from: params.from, to: params.to });
    const qs = new URLSearchParams({ tz: String(new Date().getTimezoneOffset()) });
    if (range.from) { qs.set('from', range.from); qs.set('to', range.to || range.from); }
    if (params.team_id) qs.set('team_id', params.team_id);
    if (params.user_id) qs.set('user_id', params.user_id);
    const [d, ppl, teams] = await Promise.all([
      api('/dashboard?' + qs.toString()), people(), seesAll() ? api('/teams') : Promise.resolve([]),
    ]);
    const layout = (state.me.dashboard_layout || d.layout_default).filter((w) => d.allowed.includes(w));
    const editing = !!state.dashEdit;
    const draft = editing ? state.dashEdit : layout;
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const periodLabel = period === 'custom' && range.from ? `${dayDate(range.from)} – ${dayDate(range.to || range.from)}` : (PERIODS.find((p) => p[0] === period) || [0, 'All time'])[1];

    shell(`
      <div class="dash-head">
        <div><h1 style="margin:0">${hello}, ${esc(state.me.full_name.split(' ')[0])}</h1>
          <p class="muted" style="margin:.2rem 0 0">${esc(periodLabel)}${d.prev ? ` · compared with ${esc(dayDate(d.prev.from))} – ${esc(dayDate(d.prev.to))}` : ''}</p></div>
        <div class="row">
          <a class="btn primary" href="#/new">➕ New referral</a>
          <button class="btn" id="customize">${editing ? '✓ Done' : '⚙ Customize'}</button>
        </div>
      </div>
      <div class="dash-filters">
        <div class="seg" id="periodSeg">${PERIODS.map(([k, l]) => `<button data-k="${k}" class="${period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${period === 'custom' ? `<span class="row" style="gap:.4rem"><input type="date" id="cFrom" value="${esc(range.from || '')}"><span class="muted">to</span><input type="date" id="cTo" value="${esc(range.to || '')}"></span>` : ''}
        ${seesAll() ? `<select id="dTeam"><option value="">All teams</option>${teams.map((t) => `<option value="${t.id}" ${params.team_id === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
        ${worksLeads() ? `<select id="dUser"><option value="">${isManager() ? 'Whole team' : 'Everyone'}</option>${ppl.credit.filter((p) => !params.team_id || String(p.team_id) === params.team_id).map((p) => `<option value="${p.id}" ${params.user_id === String(p.id) ? 'selected' : ''}>${esc(p.full_name)}</option>`).join('')}</select>` : ''}
      </div>
      ${editing ? `<div class="card edit-bar"><b>Customize your dashboard.</b> <span class="muted small">Use ↑ ↓ to reorder and ✕ to remove. Add widgets below. Your layout is saved to your account.</span>
        <div class="row" style="margin-top:.6rem"><button class="btn small" id="resetLayout">Reset to default</button></div></div>` : ''}
      <div class="dash" id="dash">
        ${draft.map((w, i) => `
          <section class="card widget ${WIDGET_INFO[w].size}" data-w="${w}">
            <header class="wh"><h2>${WIDGET_INFO[w].title}</h2>
              ${editing ? `<span class="wtools"><button class="icon-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="icon-btn" data-down="${i}" ${i === draft.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button><button class="icon-btn" data-rm="${i}" aria-label="Remove">✕</button></span>` : ''}
            </header>
            <div class="wb" data-body="${w}"></div>
          </section>`).join('') || '<p class="muted">No widgets. Add some below.</p>'}
      </div>
      ${editing ? `<div class="card" style="margin-top:1rem"><h2>Add widgets</h2>
        <div class="add-grid">${d.allowed.filter((w) => !draft.includes(w)).map((w) => `<button class="add-w" data-add="${w}"><b>＋ ${WIDGET_INFO[w].title}</b><span class="small muted">${WIDGET_INFO[w].about}</span></button>`).join('') || '<p class="muted small">Everything is already on your dashboard.</p>'}</div></div>` : ''}`);

    const setParam = (patch) => {
      const p = { ...query(), ...patch };
      for (const k of Object.keys(p)) if (!p[k]) delete p[k];
      location.hash = '#/home?' + new URLSearchParams(p).toString();
    };
    document.querySelectorAll('#periodSeg button').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.k === 'custom') {
          const r = range.from ? range : dashRange('30d');
          setParam({ period: 'custom', from: r.from, to: r.to });
        } else setParam({ period: b.dataset.k, from: '', to: '' });
      };
    });
    const cFrom = document.getElementById('cFrom');
    if (cFrom) {
      const upd = () => { const f = cFrom.value; const t = document.getElementById('cTo').value; if (f && t) setParam({ from: f, to: t }); };
      cFrom.onchange = upd; document.getElementById('cTo').onchange = upd;
    }
    const dTeam = document.getElementById('dTeam'); if (dTeam) dTeam.onchange = () => setParam({ team_id: dTeam.value, user_id: '' });
    const dUser = document.getElementById('dUser'); if (dUser) dUser.onchange = () => setParam({ user_id: dUser.value });

    const saveLayout = async (list) => {
      try {
        await api('/me', { method: 'PATCH', body: { dashboard_layout: list } });
        await refreshMe();
      } catch (err) { toast(err.message); }
    };
    document.getElementById('customize').onclick = async () => {
      if (editing) {
        await saveLayout(state.dashEdit);
        state.dashEdit = null;
        toast('Dashboard saved');
      } else {
        state.dashEdit = [...layout];
      }
      renderHome();
    };
    if (editing) {
      const move = (i, j) => { const a = state.dashEdit; [a[i], a[j]] = [a[j], a[i]]; renderHome(); };
      document.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => move(+b.dataset.up, +b.dataset.up - 1); });
      document.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => move(+b.dataset.down, +b.dataset.down + 1); });
      document.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { state.dashEdit.splice(+b.dataset.rm, 1); renderHome(); }; });
      document.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => { state.dashEdit.push(b.dataset.add); renderHome(); }; });
      document.getElementById('resetLayout').onclick = async () => {
        await saveLayout(null);
        state.dashEdit = [...d.layout_default];
        renderHome();
      };
    }

    for (const w of draft) {
      const el = document.querySelector(`[data-body="${w}"]`);
      try { WIDGET_RENDER[w](el, d); } catch (e) { el.innerHTML = `<p class="muted small">Couldn't draw this widget.</p>`; console.error(e); }
    }
    // Redraw the trend line when the width changes.
    clearTimeout(renderHome._rs);
    window.onresize = () => {
      clearTimeout(renderHome._rs);
      renderHome._rs = setTimeout(() => {
        const el = document.querySelector('[data-body="trend"]');
        if (el && location.hash.startsWith('#/home')) WIDGET_RENDER.trend(el, d);
      }, 150);
    };
  }

  const fmt = (n) => Number(n || 0).toLocaleString();
  const empty = (msg) => `<p class="muted small empty-w">${msg}</p>`;

  // A delta chip: arrow + words, never color alone. `better` says which direction is good.
  function delta(cur, prev, { unit = '', better = 'up', points = false } = {}) {
    if (prev == null || cur == null) return '';
    const diff = points ? Math.round((cur - prev) * 10) / 10 : prev ? Math.round(((cur - prev) / prev) * 100) : null;
    if (diff == null) return prev === 0 && cur > 0 ? '<span class="delta up good">▲ new</span>' : '';
    if (diff === 0) return '<span class="delta flat">— same</span>';
    const up = diff > 0;
    const good = better === 'none' ? 'neutral' : (up === (better === 'up') ? 'good' : 'bad');
    return `<span class="delta ${up ? 'up' : 'down'} ${good}">${up ? '▲' : '▼'} ${Math.abs(diff)}${points ? ' pts' : '%'}${unit}</span>`;
  }

  // Horizontal bars (one hue). rows: [{label, value, sub, tip, href}]
  function barList(rows, { max } = {}) {
    const m = max || Math.max(1, ...rows.map((r) => r.value));
    return `<div class="bars">${rows.map((r) => `
      <${r.href ? `a href="${r.href}"` : 'div'} class="bar-row" data-tip="${esc(r.tip || `${r.label}: ${fmt(r.value)}`)}">
        <span class="bar-label">${r.label}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(r.value ? 1.5 : 0, (r.value / m) * 100)}%"></span></span>
        <span class="bar-val">${fmt(r.value)}${r.sub ? ` <span class="muted small">${r.sub}</span>` : ''}</span>
      </${r.href ? 'a' : 'div'}>`).join('')}</div>`;
  }

  const WIDGET_RENDER = {
    speed(el, d) {
      const x = d.speed;
      if (!x) { el.innerHTML = ''; return; }
      const tone = x.within_pct == null ? '' : x.within_pct >= 80 ? 'ok-text' : x.within_pct >= 50 ? 'warn-text' : 'danger-text';
      el.innerHTML = `<div class="speed-tiles">
          <div><div class="n">${fmtMins(x.avg)}</div><div class="l">Average first response</div></div>
          <div><div class="n">${fmtMins(x.median)}</div><div class="l">Typical (median)</div></div>
          <div><div class="n ${tone}">${x.within_pct == null ? '—' : `${x.within_pct}%`}</div><div class="l">Answered within ${x.target} min</div></div>
        </div>
        ${x.waiting.length ? `<p class="small" style="margin:.8rem 0 .3rem"><b>Waiting now</b></p><ul class="mini-list">${x.waiting.map((w) => `
          <li><a href="#/r/${w.id}"><b>${esc(leadName(w))}</b><span class="muted small">${w.assigned_name ? `🎧 ${esc(w.assigned_name)}` : 'Unassigned'}${w.phone ? ` · ${esc(w.phone)}` : ''}</span></a>
          <span class="age ${w.minutes >= x.escalate ? 'old' : w.minutes >= x.target ? '' : 'fresh'}">${fmtMins(w.minutes)}</span></li>`).join('')}</ul>`
          : '<p class="small muted" style="margin:.8rem 0 0">✓ No new lead is waiting for a first response.</p>'}
        ${x.count ? '' : '<p class="small muted" style="margin:.4rem 0 0">No responses in this period yet.</p>'}`;
    },

    followups(el, d) {
      const list = d.followups || [];
      el.innerHTML = list.length ? `<ul class="mini-list">${list.map((f) => {
        const due = parseDate(f.follow_up_at);
        const late = due < new Date();
        return `<li><a href="#/r/${f.id}"><b>${esc(leadName(f))}</b><span class="muted small">${f.follow_up_note ? esc(f.follow_up_note) : esc(f.phone || '')}</span></a>
          <span class="when-chip ${late ? 'today' : ''}">${due.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>${f.phone ? `<a class="btn small" href="tel:${esc(f.phone.replace(/[^\d+]/g, ''))}" aria-label="Call">📞</a>` : ''}</li>`;
      }).join('')}</ul>` : empty('No call-backs set. Open a lead and tap “Tomorrow 10am” to get a reminder.');
    },

    kpis(el, d) {
      const k = d.kpis;
      const p = d.prev_kpis || {};
      const tiles = [
        ['Entered', fmt(k.entered), delta(k.entered, p.entered)],
        ['Ordered', fmt(k.ordered), delta(k.ordered, p.ordered)],
        ['Conversion', `${k.conversion}%`, delta(k.conversion, p.conversion, { points: true })],
        ['Open', fmt(k.open), delta(k.open, p.open, { better: 'none' }), 'New + Passed'],
        ['Days to order', k.avg_days_to_order == null ? '—' : k.avg_days_to_order, delta(k.avg_days_to_order, p.avg_days_to_order, { better: 'down' }), 'average'],
      ];
      el.innerHTML = `<div class="kpis">${tiles.map(([l, v, dl, sub]) => `<div class="kpi"><div class="kl">${l}</div><div class="kv">${v}</div><div class="kd">${dl || (sub ? `<span class="muted small">${sub}</span>` : '&nbsp;')}</div></div>`).join('')}</div>`;
    },

    insights(el, d) {
      const icon = { good: '▲', warn: '⚠', info: 'ℹ' };
      el.innerHTML = d.insights.length ? `<ul class="insights">${d.insights.map((i) => `
        <li class="ins ${i.tone}"><span class="ins-i" aria-hidden="true">${icon[i.tone]}</span><span>${esc(i.text)}</span>${i.link ? `<a class="small" href="${i.link}">View</a>` : ''}</li>`).join('')}</ul>`
        : empty('Nothing stands out yet. Insights appear as referrals come in.');
    },

    trend(el, d) {
      const pts = d.trend;
      if (!pts.length || pts.every((p) => !p.entered && !p.ordered)) { el.innerHTML = empty('No referrals in this period yet.'); return; }
      const W = Math.max(280, el.clientWidth || 600);
      const H = 220;
      const pad = { l: 34, r: 64, t: 12, b: 26 };
      const iw = W - pad.l - pad.r;
      const ih = H - pad.t - pad.b;
      const maxV = Math.max(1, ...pts.map((p) => Math.max(p.entered, p.ordered)));
      const step = maxV <= 4 ? 1 : Math.ceil(maxV / 4);
      const top = Math.ceil(maxV / step) * step;
      const x = (i) => pad.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
      const y = (v) => pad.t + ih - (v / top) * ih;
      const line = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
      const grid = [];
      for (let v = 0; v <= top; v += step) grid.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${pad.l - 6}" y="${y(v) + 4}" class="axt" text-anchor="end">${v}</text>`);
      const lbl = (i) => new Date(pts[i].date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const xl = [...new Set([0, Math.floor((pts.length - 1) / 2), pts.length - 1])];
      const last = pts.length - 1;
      const tot = pts.reduce((a, p) => ({ e: a.e + p.entered, o: a.o + p.ordered }), { e: 0, o: 0 });
      // Direct labels at the line ends, nudged apart if they'd overlap.
      let yE = y(pts[last].entered) + 4;
      let yO = y(pts[last].ordered) + 4;
      if (Math.abs(yE - yO) < 13) { if (yE <= yO) { yE -= 7; yO += 7; } else { yE += 7; yO -= 7; } }
      el.innerHTML = `
        <div class="legend"><span><i class="sw s1"></i>Entered <b>${fmt(tot.e)}</b></span><span><i class="sw s2"></i>Marked ordered <b>${fmt(tot.o)}</b></span></div>
        <div class="chart-wrap">
          <svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Daily referrals entered and orders marked">
            ${grid.join('')}
            ${xl.map((i) => `<text x="${x(i)}" y="${H - 6}" class="axt" text-anchor="${i === 0 ? 'start' : i === last ? 'end' : 'middle'}">${lbl(i)}</text>`).join('')}
            <path d="${line('entered')}" class="ln s1"/>
            <path d="${line('ordered')}" class="ln s2"/>
            <text x="${x(last) + 8}" y="${yE}" class="dl">Entered</text>
            <text x="${x(last) + 8}" y="${yO}" class="dl">Ordered</text>
            <g class="xh" style="display:none"><line class="xl" y1="${pad.t}" y2="${pad.t + ih}"/><circle r="4.5" class="dot s1"/><circle r="4.5" class="dot s2"/></g>
            <rect class="chart-hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"/>
          </svg>
        </div>
        <details class="tview"><summary class="small muted">Show as table</summary>
          <div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Entered</th><th class="num">Marked ordered</th></tr></thead>
          <tbody>${pts.filter((p) => p.entered || p.ordered).reverse().map((p) => `<tr><td>${esc(dayDate(p.date))}</td><td class="num">${p.entered}</td><td class="num">${p.ordered}</td></tr>`).join('')}</tbody></table></div></details>`;
      const svg = el.querySelector('svg');
      const hit = svg.querySelector('.chart-hit');
      const xh = svg.querySelector('.xh');
      const [d1, d2] = xh.querySelectorAll('circle');
      const xline = xh.querySelector('line');
      const move = (clientX, clientY) => {
        const r = svg.getBoundingClientRect();
        const sx = ((clientX - r.left) / r.width) * W;
        const i = Math.max(0, Math.min(last, Math.round(((sx - pad.l) / iw) * last)));
        const p = pts[i];
        xh.style.display = '';
        xline.setAttribute('x1', x(i)); xline.setAttribute('x2', x(i));
        d1.setAttribute('cx', x(i)); d1.setAttribute('cy', y(p.entered));
        d2.setAttribute('cx', x(i)); d2.setAttribute('cy', y(p.ordered));
        showTip(`<b>${esc(dayDate(p.date))}</b><div><i class="sw s1"></i>Entered <b>${p.entered}</b></div><div><i class="sw s2"></i>Marked ordered <b>${p.ordered}</b></div>`, clientX, clientY);
      };
      hit.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
      hit.addEventListener('mouseleave', () => { xh.style.display = 'none'; hideTip(); });
      hit.addEventListener('touchmove', (e) => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
      hit.addEventListener('touchstart', (e) => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
    },

    status(el, d) {
      const k = d.kpis;
      if (!k.entered) { el.innerHTML = empty('No referrals in this period.'); return; }
      el.innerHTML = barList(STATUSES.map((s) => ({
        label: pill(s), value: k.by_status[s], sub: `${Math.round((k.by_status[s] / k.entered) * 100)}%`,
        tip: `${s}: ${k.by_status[s]} of ${k.entered}`, href: `#/referrals?status=${s}`,
      })), { max: k.entered });
    },

    funnel(el, d) {
      const top = d.funnel[0].n;
      if (!top) { el.innerHTML = empty('No referrals in this period.'); return; }
      el.innerHTML = barList(d.funnel.map((f, i) => ({
        label: esc(f.stage), value: f.n, sub: i ? `${Math.round((f.n / top) * 100)}%` : '',
        tip: `${f.stage}: ${f.n}${i ? ` (${Math.round((f.n / top) * 100)}% of entered)` : ''}`,
      })), { max: top }) + '<p class="small muted" style="margin:.5rem 0 0">Worked = moved past New.</p>';
    },

    services(el, d) {
      const any = d.services.some((s) => s.entered);
      el.innerHTML = any ? barList(d.services.map((s) => ({
        label: esc(s.service), value: s.entered, sub: s.entered ? `${s.conversion}% ordered` : '',
        tip: `${s.service}: ${s.entered} referrals, ${s.ordered} ordered (${s.conversion}%)`, href: `#/referrals?service=${s.service}`,
      }))) : empty('No services recorded in this period.');
    },

    leaderboard(el, d) {
      const lb = d.leaderboard;
      if (!lb.length) { el.innerHTML = empty('No referrals from the team in this period.'); return; }
      el.innerHTML = barList(lb.map((r, i) => ({
        label: `<span class="rank">${i + 1}</span>${esc(r.full_name)}${r.me ? ' <span class="tag">you</span>' : ''}${seesAll() && r.team_name ? ` <span class="muted small">${esc(r.team_name)}</span>` : ''}`,
        value: r.ordered, sub: `of ${r.entered} · ${r.conversion}%`,
        tip: `${r.full_name}: ${r.ordered} ordered of ${r.entered} entered (${r.conversion}%)`,
        href: worksLeads() ? `#/referrals?user_id=${r.id}` : undefined,
      })));
    },

    teams(el, d) {
      if (!d.teams || !d.teams.length) { el.innerHTML = empty('No teams yet.'); return; }
      el.innerHTML = barList(d.teams.map((t) => ({
        label: esc(t.name), value: t.ordered, sub: `of ${t.entered} · ${t.conversion}%`,
        tip: `${t.name}: ${t.ordered} ordered of ${t.entered} entered (${t.conversion}%)`, href: `#/home?${new URLSearchParams({ ...query(), team_id: t.id })}`,
      }))) + '<p class="small muted" style="margin:.5rem 0 0">Bars show orders. Click a team to focus the dashboard on it.</p>';
    },

    dispatch(el, d) {
      if (!d.dispatch) { el.innerHTML = ''; return; }
      const x = d.dispatch;
      el.innerHTML = `<p style="margin:0 0 .6rem">${x.unassigned ? `<a href="#/referrals?scope=unassigned"><b>${x.unassigned}</b> open lead${x.unassigned === 1 ? '' : 's'} unassigned</a>` : '✓ Every open lead has a dispatcher.'}</p>`
        + (x.people.length ? barList(x.people.map((p) => ({
          label: esc(p.full_name), value: p.open, sub: `open · ${p.ordered} ordered`,
          tip: `${p.full_name}: ${p.open} open, ${p.ordered} ordered this period`, href: `#/referrals?scope=all&assigned_to=${p.id}`,
        }))) : empty('No dispatchers yet. Add one under Admin.'));
    },

    stale(el, d) {
      el.innerHTML = d.stale.length ? `<ul class="mini-list">${d.stale.map((r) => `
        <li><a href="#/r/${r.id}"><b>${esc(leadName(r))}</b><span class="muted small">${esc(r.rep)}${r.phone ? ` · ${esc(r.phone)}` : ''}</span></a><span class="age ${r.days >= 7 ? 'old' : ''}">${r.days}d</span></li>`).join('')}</ul>
        ${d.stale_count > d.stale.length ? `<a class="small" href="#/referrals?status=New">All ${d.stale_count} →</a>` : ''}`
        : empty('✓ Nothing waiting. No lead has sat in New for 3+ days.');
    },

    installs(el, d) {
      el.innerHTML = d.installs.length ? `<ul class="mini-list">${d.installs.map((r) => `
        <li><a href="#/r/${r.id}"><b>${esc(leadName(r))}</b><span class="muted small">${esc(r.address || r.rep)}</span></a><span class="when-chip ${r.install_date === d.today ? 'today' : ''}">${r.install_date === d.today ? 'Today' : esc(dayDate(r.install_date))}</span></li>`).join('')}</ul>`
        : empty('No installs scheduled in the next two weeks.');
    },

    activity(el, d) {
      el.innerHTML = d.activity.length ? `<ul class="feed">${d.activity.map((a) => `
        <li><a href="#/r/${a.referral_id}">${a.kind === 'comment'
          ? `💬 <b>${esc(a.actor)}</b> commented on <b>${esc(leadName(a))}</b><span class="muted small feed-q">${esc(a.body)}</span>`
          : a.from_status ? `🔄 <b>${esc(a.actor)}</b> moved <b>${esc(leadName(a))}</b> to ${pill(a.to_status)}`
            : `➕ <b>${esc(a.actor)}</b> entered <b>${esc(leadName(a))}</b>`}</a><span class="muted small">${when(a.at)}</span></li>`).join('')}</ul>`
        : empty('No activity yet.');
    },
  };

  // ---------- past sales upload (admin) ----------

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('Couldn’t read that file.'));
      fr.readAsDataURL(file);
    });
  }

  function setupHistory() {
    const form = document.getElementById('historyForm');
    const preview = document.getElementById('historyPreview');
    const n = (x) => Number(x).toLocaleString();
    const load = async () => {
      const box = document.getElementById('historyList');
      if (!box) return;
      let d;
      try { d = await api('/history/imports'); } catch (err) { box.innerHTML = `<div class="alert err">${esc(err.message)}</div>`; return; }
      box.classList.remove('muted');
      box.innerHTML = `<div class="stats sec-stats" style="margin:.8rem 0">
          <div class="stat"><div class="n">${n(d.totals.phones)}</div><div class="l">Phone numbers blocked</div></div>
          <div class="stat"><div class="n">${n(d.totals.addresses)}</div><div class="l">Addresses blocked</div></div>
          <div class="stat"><div class="n">${n(d.totals.blocked)}</div><div class="l">Leads stopped so far</div></div></div>
        ${d.imports.length ? `<div class="table-wrap"><table class="rtable"><thead><tr><th>File</th><th class="num">Rows</th><th class="num">Phones</th><th class="num">Addresses</th><th>Uploaded</th><th></th></tr></thead><tbody>
        ${d.imports.map((i) => `<tr><td data-label="File"><b>${esc(i.file_name)}</b>${i.note ? `<div class="small muted">${esc(i.note)}</div>` : ''}</td>
          <td data-label="Rows" class="num">${n(i.rows_read)}</td><td data-label="Phones" class="num">${n(i.phones)}</td><td data-label="Addresses" class="num">${n(i.addresses)}</td>
          <td data-label="Uploaded">${when(i.created_at)}<div class="small muted">${esc(i.uploaded_by_name || '')}</div></td>
          <td class="actions"><button class="btn small danger" data-hdel="${i.id}" data-name="${esc(i.file_name)}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Nothing uploaded yet.</p>'}`;
      box.querySelectorAll('[data-hdel]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm(`Remove “${b.dataset.name}”? Its phones and addresses stop blocking new leads (unless another upload has them too).`)) return;
          try { await api(`/history/imports/${b.dataset.hdel}`, { method: 'DELETE', body: {} }); toast('Upload removed'); load(); } catch (err) { toast(err.message); }
        };
      });
    };
    let pending = null;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const file = document.getElementById('hs_file').files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { preview.innerHTML = '<div class="alert err small">That file is over 10 MB. Split it into smaller files.</div>'; return; }
      const btn = document.getElementById('hsCheck');
      btn.disabled = true; btn.textContent = 'Reading…';
      try {
        pending = { file_name: file.name, data: await fileToBase64(file), note: document.getElementById('hs_note').value };
        const r = await api('/history/import', { method: 'POST', body: pending });
        preview.innerHTML = `<div class="invite-new">
          <div><b>${esc(r.file_name)}</b>: found <b>${n(r.phones)}</b> phone number${r.phones === 1 ? '' : 's'} and <b>${n(r.addresses)}</b> address${r.addresses === 1 ? '' : 'es'} in ${n(r.rows)} rows
            <span class="muted">(${n(r.new_phones)} phones and ${n(r.new_addresses)} addresses aren't blocked yet)</span>.</div>
          <div class="small muted" style="margin:.3rem 0 .6rem">${r.sheets.map((sh) => `${esc(sh.name)}: ${n(sh.phones)} phones, ${n(sh.addresses)} addresses${sh.mode === 'scan' ? ' (no header row — addresses picked out of the cells)' : ''}`).join(' · ')}</div>
          <div class="row"><button class="btn primary" id="hsSave">Add to the block list</button><button class="btn" id="hsCancel">Cancel</button></div></div>`;
        document.getElementById('hsCancel').onclick = () => { preview.innerHTML = ''; pending = null; };
        document.getElementById('hsSave').onclick = async (ev) => {
          ev.target.disabled = true;
          try {
            const saved = await api('/history/import', { method: 'POST', body: { ...pending, commit: true } });
            preview.innerHTML = `<div class="alert ok small">✓ Added ${n(saved.phones)} phones and ${n(saved.addresses)} addresses from ${esc(saved.file_name)}. New leads matching them are now blocked.</div>`;
            form.reset(); pending = null; load();
          } catch (err) { ev.target.disabled = false; toast(err.message); }
        };
      } catch (err) {
        preview.innerHTML = `<div class="alert err small">${esc(err.message)}</div>`;
      } finally { btn.disabled = false; btn.textContent = 'Check file'; }
    };
    load();
  }

  // ---------- affiliate program ----------

  const usd = (n) => `${n < 0 ? '−' : ''}$${Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  async function renderAffiliate() {
    if (!state.me.affiliate && !isAdmin()) { location.hash = defaultRoute(); return; }
    const [mine, adm] = await Promise.all([
      state.me.affiliate ? api('/affiliate/me') : Promise.resolve(null),
      isAdmin() ? api('/affiliate/admin') : Promise.resolve(null),
    ]);
    const lvlText = (levels) => levels.map((p, i) => `<b>${p}%</b> ${i === 0 ? 'on sales by people you invite' : i === 1 ? 'on sales by the people they invite' : `on level ${i + 1}`}`)
      .join(', ').replace(/, ([^,]*)$/, ' and $1');
    const kindLabel = { sale: 'Sale', adjustment: 'Commission changed', reversal: 'Cancelled — taken back' };
    shell(`
      ${mine ? `
      <div class="card aff-hero">
        <div>
          <h1 style="margin:0">Make extra money 💸</h1>
          <p style="margin:.4rem 0 0">Invite friends to sell with E&amp;O. You earn ${lvlText(mine.levels)}, as a share of each sale's commission and on top of your own pay.</p>
          <p class="small muted" style="margin:.3rem 0 0">You earn when their customer orders, not when they sign up.${mine.approval ? ' New sign-ups are approved by an admin first.' : ''}</p>
        </div>
        <div class="aff-link">
          <label for="affLink" class="small">Your personal sign-up link</label>
          <div class="row" style="flex-wrap:nowrap"><input id="affLink" readonly value="${esc(mine.link)}" style="flex:1;min-width:0"><button class="btn primary" id="affCopy">Copy</button></div>
          <div class="row" style="margin-top:.5rem">${navigator.share ? '<button class="btn small" id="affShare">📤 Share</button>' : ''}<a class="btn small" href="sms:?&body=${encodeURIComponent(`Want to make extra money selling Spectrum? Join my team: ${mine.link}`)}">💬 Text it</a>${state.me.email_enabled ? '<button class="btn small" id="affEmail">✉ Email it</button>' : ''}</div>
        </div>
      </div>
      <div class="stats aff-stats">
        <div class="stat"><div class="n">${usd(mine.stats.owed)}</div><div class="l">Owed to you</div></div>
        <div class="stat"><div class="n">${usd(mine.stats.month)}</div><div class="l">Earned this month</div></div>
        <div class="stat"><div class="n">${usd(mine.stats.paid)}</div><div class="l">Paid to you so far</div></div>
        <div class="stat"><div class="n">${mine.stats.by_level[1] || 0}<span class="of"> + ${Object.entries(mine.stats.by_level).filter(([l]) => l !== '1').reduce((n, [, c]) => n + c, 0)}</span></div><div class="l">Your recruits + theirs</div></div>
      </div>
      <div class="grid-2">
        <div class="card"><h2>People you invited</h2>
          ${mine.direct.length ? `<ul class="lead-list">${mine.direct.map((d) => `<li style="cursor:default"><div class="who"><b>${esc(d.full_name)}</b><span>joined ${when(d.created_at)}${d.approval_pending ? ' · <span class="warn-text">waiting for approval</span>' : ''}${d.recruits ? ` · invited ${d.recruits}` : ''}</span></div>
            <div style="text-align:right"><b>${usd(d.earned_from)}</b><div class="small muted">${d.orders_month} order${d.orders_month === 1 ? '' : 's'} this month</div></div></li>`).join('')}</ul>`
            : '<p class="muted">Nobody yet. Share your link to get started.</p>'}
        </div>
        <div class="card"><h2>Your earnings</h2>
          ${mine.earnings.length ? `<div class="table-wrap"><table class="rtable"><thead><tr><th>When</th><th>Sale by</th><th>Level</th><th class="num">Amount</th></tr></thead><tbody>
            ${mine.earnings.map((e) => `<tr><td data-label="When">${when(e.created_at)}</td><td data-label="Sale by">${esc(e.seller_name || '—')}<div class="small muted">${kindLabel[e.kind]} · ${e.pct}% of ${usd(e.base)}</div></td>
              <td data-label="Level">${e.level}</td><td data-label="Amount" class="num ${e.amount < 0 ? 'warn-text' : ''}"><b>${usd(e.amount)}</b>${e.payout_id ? '<div class="small muted">paid</div>' : ''}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No earnings yet. You earn when someone you invited makes a sale.</p>'}
          ${state.me.payments ? '<p class="small muted" style="margin:.8rem 0 0">Make sure your <a href="#/payments">payout details</a> are up to date.</p>' : ''}
        </div>
      </div>` : ''}
      ${adm ? `
      <div class="card">
        <h2>Affiliate program settings <span class="small muted">(admins)</span></h2>
        <form id="affSettings" class="aff-settings">
          <label class="check"><input type="checkbox" name="enabled" ${adm.settings.enabled ? 'checked' : ''}> Program on (everyone gets a personal sign-up link)</label>
          <div class="field"><label for="aff_levels">Percent of the commission, per level</label><input id="aff_levels" name="levels" value="${esc(adm.settings.levels.join(', '))}" placeholder="15, 5">
            <p class="small muted" style="margin:.3rem 0 0">Level 1 is the person who invited the seller, level 2 the person who invited them, and so on. Up to 5 levels, 0–50% each.</p></div>
          <div class="field"><label for="aff_comm">Default commission per sale ($)</label><input id="aff_comm" name="commission" type="number" min="0" step="0.01" value="${esc(adm.settings.commission)}">
            <p class="small muted" style="margin:.3rem 0 0">Filled in when a lead is marked Ordered. Change it per lead on the lead's page.</p></div>
          <label class="check"><input type="checkbox" name="approval" ${adm.settings.approval ? 'checked' : ''}> New sign-ups need my approval</label>
          <div style="margin-top:.9rem"><button class="btn primary">Save</button></div>
        </form>
      </div>
      ${adm.pending.length ? `<div class="card"><h2>Waiting for approval (${adm.pending.length})</h2>
        <div class="table-wrap"><table class="rtable"><thead><tr><th>Name</th><th>Contact</th><th>Invited by</th><th>Signed up</th><th></th></tr></thead><tbody>
        ${adm.pending.map((u) => `<tr><td data-label="Name"><b>${esc(u.full_name)}</b><div class="small muted">@${esc(u.username)}${u.team_name ? ` · ${esc(u.team_name)}` : ''}</div></td>
          <td data-label="Contact" class="small">${esc(u.email)}${u.phone ? `<div>${esc(u.phone)}</div>` : ''}</td><td data-label="Invited by">${esc(u.sponsor_name || '—')}</td><td data-label="Signed up">${when(u.created_at)}</td>
          <td class="actions"><button class="btn small primary" data-approve="${u.id}">Approve</button> <button class="btn small danger" data-reject="${u.id}" data-name="${esc(u.full_name)}">Reject</button></td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
      <div class="card"><div class="row between"><h2 style="margin:0">Affiliate earnings by person</h2><span class="small muted">“Mark paid” after you've sent the money.</span></div>
        <div class="table-wrap" style="margin-top:.6rem"><table class="rtable"><thead><tr><th>Person</th><th>Invited by</th><th class="num">Recruits</th><th class="num">Owed</th><th class="num">All-time</th><th></th></tr></thead><tbody>
        ${adm.members.map((m) => `<tr class="${m.active ? '' : 'inactive'}"><td data-label="Person"><b>${esc(m.full_name)}</b><div class="small muted">${roleLabel(m.role)}${m.last_paid ? ` · last paid ${when(m.last_paid)}` : ''}</div></td>
          <td data-label="Invited by"><select data-sponsor="${m.id}" style="width:auto;max-width:180px"><option value="">— nobody —</option>${adm.members.filter((x) => x.id !== m.id).map((x) => `<option value="${x.id}" ${m.sponsor_id === x.id ? 'selected' : ''}>${esc(x.full_name)}</option>`).join('')}</select></td>
          <td data-label="Recruits" class="num">${m.recruits}</td><td data-label="Owed" class="num"><b class="${m.owed < 0 ? 'warn-text' : ''}">${usd(m.owed)}</b></td><td data-label="All-time" class="num">${usd(m.lifetime)}</td>
          <td class="actions">${m.owed > 0 ? `<button class="btn small" data-paid="${m.id}" data-name="${esc(m.full_name)}" data-amt="${m.owed}">Mark paid</button>${m.has_payout_details ? '' : '<div class="small warn-text">no payout details</div>'}` : ''}</td></tr>`).join('')}
        </tbody></table></div></div>
      ${adm.payouts.length ? `<div class="card"><h2>Recent affiliate payouts</h2><div class="table-wrap"><table class="rtable"><thead><tr><th>When</th><th>To</th><th class="num">Amount</th><th>Note</th><th>By</th></tr></thead><tbody>
        ${adm.payouts.map((p) => `<tr><td data-label="When">${when(p.created_at)}</td><td data-label="To">${esc(p.full_name)}</td><td data-label="Amount" class="num">${usd(p.amount)}</td><td data-label="Note" class="small">${esc(p.note)}</td><td data-label="By" class="small muted">${esc(p.paid_by || '')}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}` : ''}`);

    if (mine) {
      document.getElementById('affLink').onfocus = (e) => e.target.select();
      document.getElementById('affCopy').onclick = async () => toast((await copyText(mine.link)) ? 'Link copied' : 'Copy failed — select the link and copy it');
      const share = document.getElementById('affShare');
      if (share) share.onclick = () => navigator.share({ title: 'Join my team', text: 'Want to make extra money selling Spectrum? Join my team:', url: mine.link }).catch(() => {});
      const em = document.getElementById('affEmail');
      if (em) em.onclick = () => {
        const m = modal(`<h2>Email your link</h2>
          <form id="affMail"><div class="field"><label for="am_to">To <span class="muted small">(up to 10, separated by commas)</span></label><textarea id="am_to" rows="2" autocapitalize="none" required></textarea></div>
          <div class="field"><label for="am_msg">Personal message <span class="muted small">(optional)</span></label><input id="am_msg" maxlength="500" placeholder="Hey! I've been making extra money with this…"></div>
          <div id="amErr"></div>
          <div class="row" style="justify-content:flex-end;margin-top:.8rem"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Send</button></div></form>`);
        m.querySelector('#affMail').onsubmit = async (e) => {
          e.preventDefault();
          try {
            const r = await api('/affiliate/invite', { method: 'POST', body: { emails: m.querySelector('#am_to').value, message: m.querySelector('#am_msg').value } });
            closeModal();
            const ok = r.emailed.filter((x) => x.sent).map((x) => x.email);
            toast(ok.length ? `Sent to ${ok.join(', ')}` : 'Nothing was sent');
          } catch (err) { m.querySelector('#amErr').innerHTML = `<div class="alert err small">${esc(err.message)}</div>`; }
        };
      };
    }
    if (adm) {
      const f = document.getElementById('affSettings');
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/affiliate/settings', { method: 'PATCH', body: { enabled: f.enabled.checked, approval: f.approval.checked, levels: f.levels.value, commission: f.commission.value || 0 } });
          await refreshMe(); toast('Affiliate settings saved'); renderAffiliate();
        } catch (err) { toast(err.message); }
      };
      document.querySelectorAll('[data-approve]').forEach((b) => { b.onclick = async () => { try { await api(`/affiliate/approve/${b.dataset.approve}`, { method: 'POST', body: { approve: true } }); toast('Approved — they can sign in now'); renderAffiliate(); } catch (err) { toast(err.message); } }; });
      document.querySelectorAll('[data-reject]').forEach((b) => { b.onclick = async () => { if (!confirm(`Reject ${b.dataset.name}? Their sign-up is deleted.`)) return; try { await api(`/affiliate/approve/${b.dataset.reject}`, { method: 'POST', body: { approve: false } }); toast('Sign-up rejected'); renderAffiliate(); } catch (err) { toast(err.message); } }; });
      document.querySelectorAll('[data-sponsor]').forEach((sel) => { sel.onchange = async () => { try { await api(`/affiliate/sponsor/${sel.dataset.sponsor}`, { method: 'PATCH', body: { sponsor_id: sel.value || null } }); toast('Saved'); } catch (err) { toast(err.message); renderAffiliate(); } }; });
      document.querySelectorAll('[data-paid]').forEach((b) => {
        b.onclick = async () => {
          const note = prompt(`Mark ${usd(b.dataset.amt)} as paid to ${b.dataset.name}? Add a note if you like (e.g. "Zelle 10/3"):`, '');
          if (note === null) return;
          try { await api('/affiliate/payouts', { method: 'POST', body: { user_id: Number(b.dataset.paid), note } }); toast('Marked as paid'); renderAffiliate(); } catch (err) { toast(err.message); }
        };
      });
    }
  }

  // ---------- payments ----------

  const PAY_METHODS = { bank: 'Bank account', bit: 'Bit', bitcoin: 'Bitcoin wallet' };
  let countriesCache = null;

  async function renderPayments() {
    if (!state.me.payments) { location.hash = defaultRoute(); return; }
    const [mine, meta, everyone] = await Promise.all([
      api('/payments/me'),
      countriesCache ? Promise.resolve(countriesCache) : api('/payments/meta'),
      isAdmin() ? api('/payments') : Promise.resolve(null),
    ]);
    countriesCache = meta;
    const cur = mine.payout;
    const countries = meta.countries;
    const cName = (c) => (countries.find((x) => x.code === c) || {}).name || c;
    shell(`
      <div class="card">
        <h1>Payments</h1>
        <p class="muted small" style="margin-top:0">Tell us where to send your pay. Only admins can see your full details, and you get an email whenever they change.</p>
        ${cur ? `<div class="pay-current"><div class="pay-ico">${cur.method === 'bank' ? '🏦' : cur.method === 'bit' ? '📱' : '₿'}</div>
          <div><b>${esc(cur.summary)}</b><div class="small muted">${esc(PAY_METHODS[cur.method])} · ${esc(cur.country_name)} · ${esc(cur.holder_name)} · updated ${when(cur.updated_at)}</div></div>
          <button class="btn small" id="payEdit">Change</button></div>` : '<div class="alert warn small">You haven\'t added payout details yet.</div>'}
        <form id="payForm" class="pay-form" ${cur ? 'hidden' : ''} autocomplete="off">
          <label>How do you want to be paid?</label>
          <div class="seg pay-methods" id="payMethod">${Object.entries(PAY_METHODS).map(([k, l]) => `<button type="button" data-m="${k}" class="${(cur ? cur.method : 'bank') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div class="grid-2 pay-grid">
            <div class="field"><label for="p_country">Country</label><select id="p_country" required>${countries.map((c) => `<option value="${c.code}" ${(cur ? cur.country : 'US') === c.code ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
            <div class="field"><label for="p_holder">Account holder's full name</label><input id="p_holder" required maxlength="120" value="${esc(cur ? cur.holder_name : state.me.full_name)}"></div>
          </div>
          <div id="payFields"></div>
          <div class="field"><label for="p_pw">Your sign-in password <span class="muted small">(to confirm it's you)</span></label><input id="p_pw" type="password" required autocomplete="current-password"></div>
          <div id="payErr"></div>
          <div class="row" style="margin-top:.8rem"><button class="btn primary">Save payout details</button>${cur ? '<button type="button" class="btn" id="payCancel">Cancel</button><button type="button" class="btn danger" id="payRemove" style="margin-left:auto">Remove</button>' : ''}</div>
          <p class="small muted" style="margin:.8rem 0 0">🔒 Account numbers are encrypted when saved. You'll only ever see the last 4 digits here.</p>
        </form>
      </div>
      ${everyone ? `<div class="card">
        <div class="row between"><h2 style="margin:0">Everyone's payout details</h2><span class="small muted">Managers always have the Payments tab; switch it on for reps under Admin → All users.</span></div>
        <div class="table-wrap" style="margin-top:.6rem"><table class="rtable"><thead><tr><th>Person</th><th>Method</th><th>Country</th><th>Details</th><th>Updated</th><th></th></tr></thead><tbody>
        ${everyone.map((p) => `<tr class="${p.active ? '' : 'inactive'}">
          <td data-label="Person"><b>${esc(p.full_name)}</b><div class="small muted">${roleLabel(p.role)}${p.team_name ? ` · ${esc(p.team_name)}` : ''}${p.access ? '' : ' · <span class="warn-text">tab off</span>'}</div></td>
          <td data-label="Method">${p.method ? esc(PAY_METHODS[p.method]) : '<span class="muted">not added</span>'}</td>
          <td data-label="Country">${esc(p.country_name || '')}</td>
          <td data-label="Details">${esc(p.summary || '')}${p.holder_name ? `<div class="small muted">${esc(p.holder_name)}</div>` : ''}</td>
          <td data-label="Updated">${p.updated_at ? when(p.updated_at) : ''}</td>
          <td class="actions">${p.method ? `<button class="btn small" data-reveal="${p.id}">Show full details</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}`);

    const form = document.getElementById('payForm');
    let method = cur ? cur.method : 'bank';
    const country = document.getElementById('p_country');
    const ibanCountry = () => (countries.find((c) => c.code === country.value) || {}).iban > 0;
    let format = null;
    const fields = () => {
      const box = document.getElementById('payFields');
      if (method === 'bank') {
        if (format === null || !ibanCountry()) format = ibanCountry() ? 'iban' : 'account';
        const us = country.value === 'US';
        box.innerHTML = `
          <div class="field"><label for="p_bank">Bank name</label><input id="p_bank" required maxlength="120" placeholder="${us ? 'e.g. Chase' : 'e.g. BBVA'}"></div>
          ${ibanCountry() ? `<div class="seg small-seg" id="payFormat" style="margin:.6rem 0 0"><button type="button" data-f="iban" class="${format === 'iban' ? 'on' : ''}">IBAN</button><button type="button" data-f="account" class="${format === 'account' ? 'on' : ''}">Account number</button></div>` : ''}
          ${format === 'iban' ? `<div class="field"><label for="p_iban">IBAN</label><input id="p_iban" required maxlength="42" autocapitalize="characters" spellcheck="false" placeholder="${esc(country.value)}00 0000 0000 0000 0000 00" class="mono"></div>`
            : `<div class="grid-2 pay-grid">
                <div class="field"><label for="p_acct">Account number</label><input id="p_acct" required maxlength="40" inputmode="${us ? 'numeric' : 'text'}" spellcheck="false" class="mono"></div>
                ${us ? `<div class="field"><label for="p_routing">Routing number <span class="muted small">(9 digits)</span></label><input id="p_routing" required maxlength="9" inputmode="numeric" class="mono"></div>`
                  : `<div class="field"><label for="p_code">Bank / branch code <span class="muted small">(if your bank uses one)</span></label><input id="p_code" maxlength="40" placeholder="CLABE, sort code, BSB, IFSC…"></div>`}
              </div>
              ${us ? '<div class="field"><label for="p_type">Account type</label><select id="p_type"><option value="checking">Checking</option><option value="savings">Savings</option></select></div>' : ''}`}
          <div class="field"><label for="p_swift">SWIFT / BIC <span class="muted small">(${us ? 'optional' : 'needed for international transfers'})</span></label><input id="p_swift" maxlength="11" autocapitalize="characters" spellcheck="false" class="mono" placeholder="e.g. BOFAUS3N"></div>`;
        box.querySelectorAll('#payFormat button').forEach((b) => { b.onclick = () => { format = b.dataset.f; fields(); }; });
      } else if (method === 'bit') {
        box.innerHTML = '<div class="field"><label for="p_bit">Phone number on your Bit account</label><input id="p_bit" required type="tel" maxlength="20" placeholder="+972 50-123-4567"></div>';
      } else {
        box.innerHTML = '<div class="field"><label for="p_wallet">Bitcoin wallet address</label><input id="p_wallet" required maxlength="90" spellcheck="false" class="mono" placeholder="bc1q…"><p class="small muted" style="margin:.3rem 0 0">Double-check it: payments to a wrong address can\'t be undone.</p></div>';
      }
    };
    fields();
    country.onchange = () => { format = null; fields(); };
    document.querySelectorAll('#payMethod button').forEach((b) => {
      b.onclick = () => {
        method = b.dataset.m;
        document.querySelectorAll('#payMethod button').forEach((x) => x.classList.toggle('on', x === b));
        if (method === 'bit' && country.value === 'US' && !cur) country.value = 'IL';
        fields();
      };
    });
    const edit = document.getElementById('payEdit');
    if (edit) edit.onclick = () => { form.hidden = false; edit.hidden = true; form.querySelector('select, input').focus(); };
    const cancel = document.getElementById('payCancel');
    if (cancel) cancel.onclick = () => { form.hidden = true; edit.hidden = false; };
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('.primary');
      btn.disabled = true;
      try {
        await api('/payments/me', { method: 'PUT', body: {
          method, country: country.value, holder_name: v('p_holder'), password: v('p_pw'),
          bank_name: v('p_bank'), format, iban: v('p_iban'), account_number: v('p_acct'), routing_number: v('p_routing'),
          account_type: v('p_type'), bank_code: v('p_code'), swift: v('p_swift'), bit_phone: v('p_bit'), wallet: v('p_wallet'),
        } });
        toast('Payout details saved');
        renderPayments();
      } catch (err) {
        document.getElementById('payErr').innerHTML = `<div class="alert err small">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    };
    const remove = document.getElementById('payRemove');
    if (remove) remove.onclick = async () => {
      const pw = v('p_pw');
      if (!pw) { document.getElementById('payErr').innerHTML = '<div class="alert err small">Enter your password first, then tap Remove.</div>'; return; }
      if (!confirm('Remove your payout details?')) return;
      try { await api('/payments/me', { method: 'DELETE', body: { password: pw } }); toast('Payout details removed'); renderPayments(); } catch (err) { document.getElementById('payErr').innerHTML = `<div class="alert err small">${esc(err.message)}</div>`; }
    };
    const LABELS = { holder_name: 'Account holder', bank_name: 'Bank', iban: 'IBAN', account_number: 'Account number', routing_number: 'Routing number',
      account_type: 'Account type', bank_code: 'Bank / branch code', swift: 'SWIFT / BIC', bit_phone: 'Bit phone', wallet: 'Bitcoin address' };
    document.querySelectorAll('[data-reveal]').forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await api(`/payments/${b.dataset.reveal}/reveal`, { method: 'POST', body: {} });
          const rows = Object.entries(r.details).filter(([k]) => LABELS[k]).map(([k, val]) => `<tr><td class="muted">${LABELS[k]}</td><td class="mono"><b>${esc(k === 'iban' ? val.replace(/(.{4})/g, '$1 ').trim() : val)}</b></td><td><button class="btn small" data-cp="${esc(val)}">Copy</button></td></tr>`).join('');
          const m = modal(`<h2>${esc(PAY_METHODS[r.method])} · ${esc(cName(r.country))}</h2>
            <table class="pay-reveal">${rows}</table>
            <p class="small muted">Viewing is recorded in the audit log.</p>
            <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div>`);
          m.querySelectorAll('[data-cp]').forEach((c) => { c.onclick = async () => toast((await copyText(c.dataset.cp)) ? 'Copied' : 'Copy failed'); });
        } catch (err) { toast(err.message); }
      };
    });
  }

  // ---------- invite links (admin) ----------

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => false);
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return Promise.resolve(ok);
  }

  function setupInvites(teams) {
    const form = document.getElementById('inviteForm');
    const roleSel = document.getElementById('iv_role');
    const teamSel = document.getElementById('iv_team');
    const syncTeam = () => {
      const needs = !['admin', 'dispatch'].includes(roleSel.value);
      teamSel.required = needs;
      if (needs && !teamSel.value && teams[0]) teamSel.value = String(teams[0].id);
    };
    roleSel.onchange = syncTeam; syncTeam();
    const emailsBox = document.getElementById('iv_emails');
    const usesSel = document.getElementById('iv_uses');
    emailsBox.oninput = () => {
      const n = emailsBox.value.split(/[\s,;]+/).filter((x) => x.includes('@')).length;
      if (n > Number(usesSel.value)) {
        const fit = [...usesSel.options].find((o) => Number(o.value) >= n);
        if (fit) usesSel.value = fit.value;
      }
      document.getElementById('ivGo').textContent = n ? `Create link and email ${n === 1 ? 'it' : `${n} people`}` : 'Create invite link';
    };
    const statusChip = { active: '<span class="iv-st active">Active</span>', used: '<span class="iv-st">Used up</span>', expired: '<span class="iv-st">Expired</span>', revoked: '<span class="iv-st">Turned off</span>' };
    const load = async () => {
      const box = document.getElementById('inviteList');
      if (!box) return;
      let list;
      try { list = await api('/invites'); } catch (err) { box.innerHTML = `<div class="alert err">${esc(err.message)}</div>`; return; }
      box.classList.remove('muted');
      box.innerHTML = list.length ? `<div class="table-wrap"><table class="rtable invites-table"><thead><tr><th>Invite</th><th>Status</th><th class="num">Used</th><th>Expires</th><th>Joined</th><th></th></tr></thead><tbody>
        ${list.map((i) => `<tr>
          <td data-label="Invite"><b>${roleLabel(i.role)}</b>${i.team_name ? ` · ${esc(i.team_name)}` : ''}${i.note ? `<div class="small muted">${esc(i.note)}</div>` : ''}<div class="small muted">by ${esc(i.created_by_name || '—')}, ${when(i.created_at)}</div></td>
          <td data-label="Status">${statusChip[i.status]}</td>
          <td data-label="Used" class="num">${i.uses} of ${i.max_uses}</td>
          <td data-label="Expires">${esc(fullDate(i.expires_at))}</td>
          <td data-label="Joined" class="small">${i.joined.length ? i.joined.map((j) => esc(j.full_name)).join(', ') : '<span class="muted">nobody yet</span>'}
            ${i.emailed.length ? `<div class="muted">✉ ${i.emailed.map((e) => `${esc(e.email)}${e.ok ? '' : ' <span class="warn-text">(failed)</span>'}`).join(', ')}</div>` : ''}</td>
          <td class="actions">${i.status === 'active' ? `<button class="btn small" data-copy-invite="${esc(i.url)}">Copy link</button>${state.me.email_enabled ? ` <button class="btn small" data-email-invite="${i.id}" data-left="${i.max_uses - i.uses}">Email</button>` : ''} <button class="btn small danger" data-revoke="${i.id}">Turn off</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No invite links yet.</p>';
      box.querySelectorAll('[data-copy-invite]').forEach((b) => { b.onclick = async () => toast((await copyText(b.dataset.copyInvite)) ? 'Link copied' : 'Copy failed — select the link and copy it'); });
      box.querySelectorAll('[data-email-invite]').forEach((b) => {
        b.onclick = () => {
          const m = modal(`<h2>Email this invite link</h2>
            <p class="small muted" style="margin-top:0">It has ${b.dataset.left} sign-up${b.dataset.left === '1' ? '' : 's'} left.</p>
            <form id="ivMail"><div class="field"><label for="ivm_to">To <span class="muted small">(separate addresses with commas)</span></label><textarea id="ivm_to" rows="2" autocapitalize="none" required placeholder="manager@email.com"></textarea></div>
            <div class="field"><label for="ivm_msg">Personal message <span class="muted small">(optional)</span></label><input id="ivm_msg" maxlength="500"></div>
            <div id="ivmErr"></div>
            <div class="row" style="justify-content:flex-end;margin-top:.8rem"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Send</button></div></form>`);
          m.querySelector('#ivMail').onsubmit = async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('.primary');
            btn.disabled = true;
            try {
              const r = await api(`/invites/${b.dataset.emailInvite}/email`, { method: 'POST', body: { emails: m.querySelector('#ivm_to').value, message: m.querySelector('#ivm_msg').value } });
              const bad = r.emailed.filter((x) => !x.sent);
              closeModal();
              toast(bad.length ? `Sent ${r.emailed.length - bad.length}; failed: ${bad.map((x) => x.email).join(', ')}` : `Emailed to ${r.emailed.map((x) => x.email).join(', ')}`);
              load();
            } catch (err) {
              m.querySelector('#ivmErr').innerHTML = `<div class="alert err small">${esc(err.message)}</div>`;
              btn.disabled = false;
            }
          };
        };
      });
      box.querySelectorAll('[data-revoke]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Turn this link off? Nobody else will be able to sign up with it. Accounts already created stay.')) return;
          try { await api(`/invites/${b.dataset.revoke}`, { method: 'DELETE', body: {} }); toast('Invite turned off'); load(); } catch (err) { toast(err.message); }
        };
      });
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const emails = document.getElementById('iv_emails').value;
        const r = await api('/invites', { method: 'POST', body: {
          role: roleSel.value, team_id: teamSel.value || null, max_uses: Number(document.getElementById('iv_uses').value),
          expires_days: Number(document.getElementById('iv_days').value), note: document.getElementById('iv_note').value,
          emails, message: document.getElementById('iv_msg').value,
        } });
        const sentTo = (r.emailed || []).filter((x) => x.sent).map((x) => x.email);
        const failed = (r.emailed || []).filter((x) => !x.sent);
        document.getElementById('inviteNew').innerHTML = `<div class="invite-new">
          ${sentTo.length ? `<div class="alert ok small" style="margin-bottom:.5rem">✉ Emailed to ${sentTo.map(esc).join(', ')}</div>` : ''}
          ${failed.length ? `<div class="alert warn small" style="margin-bottom:.5rem">Didn't go out to ${failed.map((f) => `${esc(f.email)} (${esc(f.error || 'error')})`).join(', ')}. Copy the link and send it another way.</div>` : ''}
          <div class="small"><b>New invite link</b> — ${sentTo.length ? 'you can also copy it and text it.' : 'send it by text or email.'} Whoever opens it can sign up as a <b>${roleLabel(roleSel.value)}</b>.</div>
          <div class="row" style="margin-top:.4rem;flex-wrap:nowrap"><input id="inviteUrl" readonly value="${esc(r.url)}" style="flex:1;min-width:0"><button type="button" class="btn primary" id="copyInvite">Copy</button></div></div>`;
        const input = document.getElementById('inviteUrl');
        input.onfocus = () => input.select();
        document.getElementById('copyInvite').onclick = async () => toast((await copyText(r.url)) ? 'Link copied' : 'Copy failed — select the link and copy it');
        document.getElementById('iv_note').value = '';
        document.getElementById('iv_emails').value = '';
        document.getElementById('iv_msg').value = '';
        load();
      } catch (err) { toast(err.message); } finally { btn.disabled = false; }
    };
    load();
  }

  // ---------- join with an invite link (public) ----------

  async function renderJoin(token, affiliate) {
    const joinApi = `/api/${affiliate ? 'join-a' : 'join'}/${encodeURIComponent(token)}`;
    $app.innerHTML = '<div class="login-wrap"><div class="card login"><p class="muted">Checking your invite…</p></div></div>';
    let info;
    try {
      const res = await fetch(joinApi, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'This invite link isn’t valid.');
      info = data;
    } catch (err) {
      $app.innerHTML = `<div class="login-wrap"><div class="card login">${lockup()}
        <h1>Invite link problem</h1><div class="alert warn">${esc(err.message)}</div>
        <p style="margin-top:1rem"><a class="btn" href="#/">Go to sign in</a></p></div></div>`;
      return;
    }
    const signedIn = state.me ? `<div class="alert warn small">You're signed in as <b>${esc(state.me.full_name)}</b>. <button type="button" class="link-btn small" id="joinSignOut">Sign out</button> to create a new account.</div>` : '';
    $app.innerHTML = `
      <div class="login-wrap"><form class="card login join" id="joinForm" autocomplete="on">
        ${lockup()}
        <h1>Create your account</h1>
        <p class="muted" style="margin-top:0">${esc(info.invited_by)} invited you to join as a <b>${esc(info.role_label)}</b>${info.team_name ? ` on <b>${esc(info.team_name)}</b>` : ''}.${info.affiliate ? ' You earn commission on every sale you make.' : ''}</p>
        ${info.approval ? '<p class="small muted" style="margin-top:0">An admin approves new accounts. We\'ll email you when yours is ready.</p>' : ''}
        ${signedIn}
        <div class="field"><label for="j_name">Full name</label><input id="j_name" autocomplete="name" required maxlength="100"></div>
        <div class="field"><label for="j_email">Email</label><input id="j_email" type="email" autocomplete="email" autocapitalize="none" required>
          <p class="small muted" style="margin:.25rem 0 0">For your welcome email, alerts and password resets.</p></div>
        <div class="field"><label for="j_phone">Mobile phone <span class="muted small">(optional)</span></label><input id="j_phone" type="tel" autocomplete="tel" inputmode="tel"></div>
        <div class="field"><label for="j_user">Username</label><input id="j_user" autocomplete="username" autocapitalize="none" required pattern="[A-Za-z0-9._-]{2,40}">
          <p class="small muted" style="margin:.25rem 0 0">What you'll sign in with. Letters, numbers, dots, dashes.</p></div>
        <div class="field"><label for="j_pw">Password <span class="muted small">(8+ characters)</span></label><input id="j_pw" type="password" autocomplete="new-password" minlength="8" required></div>
        <div class="field"><label for="j_pw2">Type it again</label><input id="j_pw2" type="password" autocomplete="new-password" minlength="8" required></div>
        <div id="joinErr" style="margin-top:.8rem" role="alert"></div>
        <button class="btn primary big" style="margin-top:1rem">Create account</button>
        <p class="small muted" style="margin:.8rem 0 0;text-align:center">Already have an account? <a href="#/">Sign in</a></p>
      </form></div>`;
    const nameIn = document.getElementById('j_name');
    const userIn = document.getElementById('j_user');
    let userTouched = false;
    userIn.oninput = () => { userTouched = true; };
    nameIn.oninput = () => {
      if (userTouched) return;
      const parts = nameIn.value.trim().toLowerCase().normalize('NFD').replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
      userIn.value = parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1]}` : (parts[0] || '');
    };
    nameIn.focus();
    const out = document.getElementById('joinSignOut');
    if (out) out.onclick = async () => { await api('/logout', { method: 'POST', body: {} }).catch(() => {}); state.me = null; renderJoin(token, affiliate); };
    document.getElementById('joinForm').onsubmit = async (e) => {
      e.preventDefault();
      const err = document.getElementById('joinErr');
      const pw = document.getElementById('j_pw').value;
      if (pw !== document.getElementById('j_pw2').value) { err.innerHTML = '<div class="alert err">The two passwords don\'t match.</div>'; return; }
      const btn = e.target.querySelector('.btn.primary');
      btn.disabled = true;
      try {
        const res = await fetch(joinApi, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full_name: nameIn.value, email: document.getElementById('j_email').value, phone: document.getElementById('j_phone').value,
            username: userIn.value, password: pw, password_confirm: document.getElementById('j_pw2').value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Something went wrong.');
        if (data.pending) {
          $app.innerHTML = `<div class="login-wrap"><div class="card login">${lockup()}
            <h1>You're signed up 🎉</h1>
            <p>An admin will approve your account shortly. We'll email <b>${esc(document.getElementById('j_email').value)}</b> when it's ready, then you can sign in with <b>${esc(userIn.value.toLowerCase())}</b> and the password you chose.</p>
            <p style="margin-top:1rem"><a class="btn" href="#/">Go to sign in</a></p></div></div>`;
          return;
        }
        state.welcome = { emailed: data.welcome && data.welcome.sent };
        await refreshMe();
        location.hash = '#/help?welcome=1';
      } catch (ex) {
        err.innerHTML = `<div class="alert err">${esc(ex.message)}</div>`;
      } finally { btn.disabled = false; }
    };
  }

  // ---------- help / how-to guide ----------

  function helpSections() {
    const r = role();
    const S = [];
    S.push({ id: 'start', title: 'Getting started', roles: 'all', body: `
      <p>Sign in with your <b>username</b> (or email) and password. On your phone, open the app and choose <b>Share → Add to Home Screen</b> (iPhone) or <b>⋮ → Add to Home screen</b> (Android) so it opens like an app.</p>
      <ul><li><b>Search</b> the top bar (or press <kbd>/</kbd>) to find a customer by name, phone, email, address or account number.</li>
      <li>The <b>bell</b> shows mentions, status changes and assignments. Add your email under <a href="#/account">My account</a> to get them by email too.</li>
      <li>The <b>account menu</b> has My account, Help, light or dark appearance, and Sign out.</li>
      <li><b>Forgot your password?</b> Use the link on the sign-in page to get a 6-digit code by email.</li></ul>` });
    S.push({ id: 'enter', title: 'Entering a lead', roles: 'all', body: `
      <p>It takes about 30 seconds — the app reads what you type.</p>
      <ol><li>Tap <a href="#/new"><b>New Referral</b></a>.</li>
      <li>Type or paste the customer's details into the box, in any order. For example:<div class="help-example">Jane Smith 512-555-0142 jane@email.com<br>123 Main St, Austin TX 78701<br>wants internet + mobile, call after 5</div></li>
      <li>Check the green ticks under the box (Name, Phone, Email, Address) and the <b>Services</b> buttons: Internet, TV, Mobile, Voice.</li>
      <li>Tap <b>Send referral</b>, or press <kbd>Ctrl</kbd> + <kbd>Enter</kbd>.</li></ol>
      <ul><li>You need the customer's <b>name</b> and at least a <b>phone, email or address</b>. The contact details are how duplicates are checked.</li>
      <li>Something read wrong? Tap <b>Something wrong? Fix the details</b> before sending.</li>
      <li><b>Use template</b> fills the box with labels (Name:, Phone:, Address:…) if your admin set one up.</li>
      <li><b>Date of birth</b>: type it with a label (<i>DOB: 01/31/1980</i>) or just the date; dispatch needs it.</li>
      <li><b>Send it to dispatch on WhatsApp:</b> after sending, tap <b>📋 Copy for WhatsApp</b> and paste it in the dispatch chat, or tap <b>🟢 Open WhatsApp</b>. The same buttons are on every lead's page. If something dispatch needs is missing (name, phone, address, date of birth, email), it tells you.</li>
      <li>Anything extra — current provider, best time to call, a second number — is kept in the notes. Your original text is always saved.</li></ul>` });
    S.push({ id: 'quality', title: 'Lead quality score', roles: 'all', body: `
      <p>While you type a lead, a bar under the box shows its <b>quality from 0 to 100%</b>, from <span style="color:${LeadScore.scoreColor(10)}"><b>red</b></span> to <span style="color:${LeadScore.scoreColor(100)}"><b>green</b></span>. It tells you what would raise it.</p>
      <table class="help-table"><thead><tr><th>Detail</th><th>Worth</th><th>Full marks when…</th></tr></thead><tbody>
      <tr><td>Name</td><td>25%</td><td>First and last name, spelled out</td></tr>
      <tr><td>Phone</td><td>25%</td><td>A real 10-digit number</td></tr>
      <tr><td>Address</td><td>25%</td><td>House number, street, city and zip</td></tr>
      <tr><td>Email</td><td>15%</td><td>A real mailbox (not a throw-away service)</td></tr>
      <tr><td>Services</td><td>10%</td><td>At least one of Internet, TV, Mobile, Voice picked</td></tr></tbody></table>
      <p><b>Made-up details are refused</b>, with a message saying what's wrong. That covers names like “Test”, “asdf” or “N/A”, and names with numbers. It covers phone numbers like 123-456-7890, 111-111-1111 or a fake area code. It also covers throw-away or placeholder emails like mailinator.com or test@…. Common email typos get a “Did you mean @gmail.com?” with a one-tap fix.</p>
      <p>The score shows as a coloured % on every lead, in the list and on the Board${worksLeads() ? ', so you can work the strongest leads first' : ''}.</p>` });
    S.push({ id: 'phone', title: 'The app on your phone', roles: 'all', body: `
      <ul><li><b>Install it:</b> on iPhone, open the site in Safari, tap <b>Share → Add to Home Screen</b>. On Android, tap <b>Install</b> when asked, or <b>⋮ → Install app</b>. It then opens full-screen like any app.</li>
      <li><b>Notifications:</b> go to ${isAdmin() ? '<a href="#/account">Admin → My account</a>' : '<a href="#/account">Account → Profile</a>'} → <b>Phone notifications</b> and tap <b>Turn on</b>. You'll get alerts for orders 🎉, leads assigned to you, @mentions and call-back reminders, even when the app is closed. On iPhone this works once the app is on your Home Screen.</li>
      <li><b>No signal?</b> Enter the lead as usual. It's <b>saved on your phone</b> and sent automatically when you're back online. The New Referral page shows anything still waiting.</li>
      <li><b>Address suggestions:</b> as you type an address, the app suggests the full one with city and zip. Tap it to use it. Complete addresses mean better duplicate checks and a higher lead score.</li>
      <li><b>WhatsApp alerts:</b> add your WhatsApp number under ${isAdmin() ? 'Admin → My account' : 'Account → Profile'} → <b>WhatsApp alerts</b> and switch it on to get your alerts there too${role() === 'dispatch' ? ', including every new lead the moment it comes in' : ''}.${isAdmin() ? ' <b>Admins:</b> link the alerts phone under Admin → Settings → WhatsApp alerts (scan the QR code with a separate number) and pick the dispatch group; every new lead is then posted there automatically.' : ''}</li>
      <li><b>Call-back reminders:</b> on any lead, tap <b>In 1 hour</b>, <b>Tomorrow 10am</b> or pick a time. You'll get a notification when it's time to call, and your call-backs show on Home.</li></ul>` });
    if (r !== 'rep') {
      S.push({ id: 'speed', title: 'Speed to lead', roles: 'lead', body: `
        <p>The faster a new lead gets a call, the more of them order. Each new lead shows <b>⏱ Waiting</b> until someone works it, then <b>⚡ Answered in …</b>.</p>
        <ul><li>A lead is answered the first time dispatch, a manager or an admin changes its status, comments on it, or takes it. The rep's own comments don't count.</li>
        <li>If nobody has answered it after <b>15 minutes</b>, the assigned dispatcher gets an alert (every dispatcher if it's unassigned). After <b>60 minutes</b> admins are alerted${isAdmin() ? ', and the lead can move to the least-busy other dispatcher automatically' : ''}.</li>
        <li>Only working hours count, so night-time leads start their clock in the morning.</li>
        <li>The <b>Speed to lead</b> widget on Home shows average and typical first-response times, how many leads were answered on time, and who is waiting right now.</li></ul>
        ${isAdmin() ? '<p><b>Admins:</b> change the minutes, working hours, time zone and automatic hand-off under Admin → Settings → Speed to lead.</p>' : ''}` });
    }
    S.push({ id: 'dupes', title: 'Duplicates', roles: 'all', body: `
      <p>If the phone, email or address matches <b>any</b> referral already in the system, from any team, you'll see <i>“This lead is a duplicate and cannot be entered.”</i> You won't be shown whose lead it is.</p>
      <p>Addresses match even when written differently (“123 N. Main St #4b” = “123 North Main Street Apt 4B”), but a different apartment is a different address. ${seesAll() ? 'The <a href="#/duplicates">Duplicates</a> page shows every blocked attempt and the lead it matched.' : 'If you think it\'s wrong, ask your manager — dispatch and admins can see what it matched.'}</p>` });
    S.push({ id: 'track', title: 'Following your leads', roles: 'all', body: `
      <table class="help-table"><thead><tr><th>Status</th><th>What it means</th></tr></thead><tbody>
      <tr><td>${pill('New')}</td><td>Just entered; not worked yet.</td></tr>
      <tr><td>${pill('Passed')}</td><td>Checked and qualified; being worked.</td></tr>
      <tr><td>${pill('DNQ')}</td><td>Did not qualify.</td></tr>
      <tr><td>${pill('Ordered')}</td><td>The customer ordered. An account number and install date may be added.</td></tr>
      <tr><td>${pill('Cancelled')}</td><td>Cancelled, before or after ordering.</td></tr></tbody></table>
      <ul><li><a href="#/referrals"><b>${worksLeads() ? 'Customers' : 'My Referrals'}</b></a> lists your leads — search, filter by status or service, and tap one to open it.</li>
      <li>On a lead's page, use <b>Comments</b> when something doesn't add up. Type <b>@</b> to tag a manager or dispatcher; they get notified.</li>
      <li>${r === 'rep' ? 'You can edit your own lead while it is still New. Status changes are made by your manager or dispatch.' : 'Edit details, change the status and add the account number and install date from the lead\'s page.'}</li></ul>` });
    S.push({ id: 'board', title: 'The Board', roles: 'all', body: `
      <p><a href="#/board"><b>Board</b></a> shows leads as cards in a column per status. ${worksLeads() ? 'Drag a card to another column to change its status; tap a card to open it.' : 'Tap a card to open it. (Your manager or dispatch moves cards between columns.)'} Pick how far back closed leads go with <b>Closed: last 7/30/90 days</b>.</p>` });
    if (r === 'dispatch') {
      S.push({ id: 'dispatch', title: 'Dispatch', roles: 'dispatch', body: `
        <ol><li>Open <a href="#/referrals?scope=assigned"><b>My Queue</b></a> for the open leads assigned to you.</li>
        <li>Tap <b>Take it</b> on the Board or a lead's page to claim an unassigned lead, or pick a dispatcher under <b>Dispatch</b> to hand it on.</li>
        <li>When the customer orders, set the status to <b>Ordered</b> and add the <b>account / order #</b> and <b>install date</b>.</li></ol>` });
    }
    if (worksLeads()) {
      S.push({ id: 'enter-for', title: 'Entering a lead for someone else', roles: 'lead', body: `
        <p>On <a href="#/new">New Referral</a>, choose the rep under <b>Entering this for someone else?</b> They get the credit and a notification.</p>` });
    }
    S.push({ id: 'numbers', title: 'Dashboard and reports', roles: 'all', body: `
      <p><a href="#/home"><b>Home</b></a> shows your numbers for the chosen period, compared with the period before. ${worksLeads() ? 'Use <b>Customize</b> to add, remove and reorder widgets. ' : ''}<a href="#/analytics"><b>Analytics</b></a> has reports you can filter, save, export and schedule by email.</p>` });
    if (managesUsers()) {
      S.push({ id: 'team', title: isAdmin() ? 'Managing users and teams' : 'Managing your team', roles: 'manager', body: `
        <ul><li><a href="#/team"><b>${isAdmin() ? 'Admin' : 'My Team'}</b></a> → <b>Add a ${isAdmin() ? 'user' : 'rep'}</b>: enter their name, username and email. Tick <b>Email them a welcome</b> and they get their sign-in details and a quick guide.</li>
        <li><b>Reset password</b> gives them a temporary one (emailed if you like). <b>Deactivate</b> blocks sign-in but keeps their sales.</li>
        <li><b>History</b> shows every sign-in; the table shows when each person was last active.</li></ul>` });
    }
    if (isAdmin()) {
      S.push({ id: 'invites', title: 'Invite links (admins)', roles: 'admin', body: `
        <ol><li>Go to <a href="#/team"><b>Admin</b></a> → <b>Invite links</b>.</li>
        <li>Pick the <b>role</b> and <b>team</b> new people get, how many people can use the link, and when it expires. Tap <b>Create invite link</b>.</li>
        <li>Copy the link and send it by text or email. Each person opens it, enters their name, email, phone, username and password, and is signed straight in — with a welcome email that explains how to enter leads.</li>
        <li>The list shows who joined with each link. <b>Turn off</b> stops a link working; accounts already created stay.</li></ol>
        <p>To <b>email</b> the link instead, type the addresses in <b>Email it to</b> before creating it (or use <b>Email</b> on a link in the list). Each person gets a “Create my account” button. Email needs to be switched on.</p>
        <p>The role and team always come from the link, not from what someone types. Every sign-up is in the audit log and you get a notification.</p>` });
      S.push({ id: 'past-sales', title: 'Past sales (admins)', roles: 'admin', body: `
        <ol><li>Go to <a href="#/team"><b>Admin</b></a> → <b>Past sales</b> and choose a spreadsheet (.xlsx or .csv). In Excel, an old .xls file needs <b>Save As → .xlsx</b> first.</li>
        <li>Tap <b>Check file</b>. You'll see how many phone numbers and addresses were found. Nothing is saved yet.</li>
        <li>Tap <b>Add to the block list</b>. From now on, a new lead with any of those phones or addresses gets “This lead is a duplicate and cannot be entered.”</li></ol>
        <ul><li>Columns named like <i>Phone</i>, <i>Address</i> / <i>Address Line 1</i>, <i>Line 2</i>, <i>City</i>, <i>State</i> and <i>Zip</i> are read automatically. Sheets without a header row (like pay reports) have their street addresses picked out of the cells.</li>
        <li>Only the phone and address are kept. Past sales never show up in customer lists, search or reports. On the <a href="#/duplicates">Duplicates</a> page they show as <i>Past sale (uploaded list)</i>.</li>
        <li><b>Remove</b> an upload to stop blocking its phones and addresses.</li></ul>` });
      S.push({ id: 'admin', title: 'Settings (admins)', roles: 'admin', body: `
        <ul><li><b>Automatically assign new leads to dispatch</b> sends each new lead to the least-busy dispatcher.</li>
        <li><b>Entry template</b> sets what <b>Use template</b> puts in the entry box.</li>
        <li><b>Email</b>: set the sender name and reply-to address; <b>Send me a test</b> checks it works. Email needs <code>RESEND_API_KEY</code> in Render.</li>
        <li><b>Backup</b> downloads the whole database; export all referrals as a spreadsheet.</li></ul>` });
    }
    if (state.me.payments) {
      S.push({ id: 'payments', title: 'Payments', roles: 'all', body: `
        <ol><li>Open <a href="#/payments"><b>${isAdmin() ? 'Admin' : 'Account'} → Payments</b></a>.</li>
        <li>Pick <b>Bank account</b>, <b>Bit</b> or <b>Bitcoin wallet</b>, choose your <b>country</b> and enter the account holder's name.</li>
        <li>For a bank: enter the bank name and either your <b>IBAN</b> (most of Europe, the Middle East and more) or your <b>account number</b>. US accounts also need the 9-digit <b>routing number</b>.</li>
        <li>Enter your sign-in password and tap <b>Save payout details</b>.</li></ol>
        <p>Account numbers are encrypted. You only see the last 4 digits; admins can see the full details, and every look is recorded. You get an email each time your details change. If you didn't change them, change your password and tell your admin.</p>
        ${isAdmin() ? '<p><b>Admins:</b> managers always have the Payments tab. Switch it on for a rep or dispatcher with the <b>Payments tab</b> box under Admin → All users. <b>Show full details</b> on the Payments page reveals what you need to pay someone.</p>' : ''}` });
    }
    if (state.me.affiliate || isAdmin()) {
      S.push({ id: 'affiliate', title: 'Affiliate program: invite friends, earn extra', roles: 'all', body: `
        <ol><li>Open <a href="#/affiliate"><b>${isAdmin() ? 'Admin' : 'Account'} → Affiliate</b></a> and copy <b>your personal sign-up link</b>, or tap Share, Text it or Email it.</li>
        <li>Friends who sign up with it join as reps${state.me.team_name ? ` on ${esc(state.me.team_name)}` : ''}. You're recorded as the person who invited them.</li>
        <li>When one of them makes a sale and the customer <b>orders</b>, you earn a percentage of that sale's commission, <b>15%</b> by default. When the people <i>they</i> invite sell, you earn <b>5%</b>. This is on top of your own pay.</li></ol>
        <ul><li>You earn from sales only, never just for someone signing up.</li>
        <li>If an order is cancelled, that earning is taken back. If it was already paid, it comes off your next payout.</li>
        <li>The Affiliate page shows who you invited, what you've earned from each person, and what you're owed.</li></ul>
        ${isAdmin() ? '<p><b>Admins:</b> switch the program on, set the percentages per level and the default commission per sale, and choose whether new sign-ups need your approval, all on the Affiliate page. Set or change a sale\'s commission on the lead\'s page (Update Status → Commission). Use <b>Mark paid</b> after sending someone their earnings. For people who were here before the program, set <b>Invited by</b> in the table.</p>' : ''}` });
    }
    S.push({ id: 'faq', title: 'Common questions', roles: 'all', body: `
      <dl class="help-faq">
      <dt>I don't get the reset code.</dt><dd>Check spam and that your email is under <a href="#/account">My account</a>. Otherwise ask your manager to reset your password.</dd>
      <dt>Can I change a lead after sending it?</dt><dd>${r === 'rep' ? 'Yes, while it is still New: open it and tap <b>Edit details</b>. After that, add a comment and tag your manager.' : 'Yes — open it and tap <b>Edit details</b>.'}</dd>
      <dt>Why can't I see a colleague's leads?</dt><dd>Reps see their own leads, managers their team's, dispatch and admins everyone's.</dd>
      <dt>The screen looks out of date.</dt><dd>Refresh (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>), or close and reopen the app on your phone.</dd></dl>` });
    return S;
  }

  async function renderHelp() {
    const sections = helpSections();
    const params = query();
    const welcome = params.welcome === '1';
    const hi = state.welcome; state.welcome = null;
    shell(`
      <div class="help-page">
        ${welcome ? `<div class="card help-welcome"><h1 style="margin:0 0 .3rem">Welcome, ${esc(state.me.full_name.split(' ')[0])}! 🎉</h1>
          <p style="margin:0">Your account is ready.${hi && hi.emailed ? ' We also emailed you a copy of the quick guide.' : ''} Here's how everything works — start with <b>Entering a lead</b>.</p>
          <p style="margin:.7rem 0 0"><a class="btn primary" href="#/new">Enter your first lead</a></p></div>` : ''}
        <div class="help-layout">
          <nav class="card help-toc" aria-label="Help topics">
            <input id="helpSearch" type="search" placeholder="Search help…" aria-label="Search help">
            <ol>${sections.map((x) => `<li><a href="#/help?topic=${x.id}" data-toc="${x.id}">${esc(x.title)}</a></li>`).join('')}</ol>
          </nav>
          <div class="help-body">
            ${welcome ? '' : '<h1 style="margin:0 0 .8rem">Help</h1>'}
            ${sections.map((x) => `<section class="card help-sec" id="help-${x.id}" data-sec="${x.id}"><h2>${esc(x.title)}</h2>${x.body}</section>`).join('')}
            <p class="muted small" id="helpNone" hidden>Nothing matches. Try another word, or ask your manager.</p>
          </div>
        </div>
      </div>`);
    try { localStorage.setItem('eo-help-seen', '1'); } catch { /* private mode */ }
    if (params.topic) document.getElementById(`help-${params.topic}`)?.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
    document.querySelectorAll('[data-toc]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); document.getElementById(`help-${a.dataset.toc}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    });
    const search = document.getElementById('helpSearch');
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      document.querySelectorAll('[data-sec]').forEach((sec) => {
        const hit = !q || sec.textContent.toLowerCase().includes(q);
        sec.hidden = !hit;
        if (hit) shown++;
      });
      document.getElementById('helpNone').hidden = shown > 0;
    };
  }

  // A one-time nudge for people who haven't opened Help yet.
  // ---------- WhatsApp hand-off to dispatch ----------

  async function appSettings() {
    if (state.appSettings) return state.appSettings;
    try {
      state.appSettings = await api('/settings');
      lsSet('eo-settings', state.appSettings);
    } catch { state.appSettings = lsGet('eo-settings', {}) || {}; }
    return state.appSettings;
  }
  const usDate = (ymd) => WaFormat.usDate(ymd);
  const DEFAULT_WA = WaFormat.DEFAULT_TEMPLATE;
  const whatsappMessage = (r, template) => WaFormat.fill(r, template, state.me && state.me.full_name);

  const waButtonsHtml = () => '<button type="button" class="btn small wa-btn" data-wa-copy>📋 Copy for WhatsApp</button><button type="button" class="btn small wa-btn" data-wa-open>🟢 Open WhatsApp</button>';
  function bindWhatsapp(root, r) {
    const run = async (open) => {
      const s = await appSettings();
      const { text, missing } = whatsappMessage(r, s.whatsapp_template);
      const warn = missing.length ? ` Missing for dispatch: ${missing.join(', ')}.` : '';
      if (open) {
        window.open(`https://wa.me/${(s.whatsapp_number || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
        if (warn) toast(warn.trim());
        return;
      }
      toast((await copyText(text)) ? `Copied — paste it in WhatsApp.${warn}` : 'Copy failed — use Open WhatsApp instead');
    };
    root.querySelectorAll('[data-wa-copy]').forEach((b) => { b.onclick = () => run(false); });
    root.querySelectorAll('[data-wa-open]').forEach((b) => { b.onclick = () => run(true); });
  }

  // ---------- phone app: install, notifications, working without signal ----------

  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } };
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isPhone = () => matchMedia('(max-width: 760px)').matches;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const fmtMins = (m) => (m == null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim());

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

  function urlB64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function pushState() {
    if (!pushSupported()) return { supported: false };
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return { supported: true, reg, sub, permission: Notification.permission };
  }

  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed. You can allow them in your browser or phone settings.');
    const { reg } = await pushState();
    const { key } = await api('/push/key');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) });
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  }

  // One gentle prompt on Home / New Referral: install the app on a phone, then turn on alerts.
  async function phoneNudge() {
    const box = document.getElementById('phoneNudge');
    if (!box || lsGet('eo-phone-nudge-off', false)) return;
    let html = '';
    if (isPhone() && !isStandalone() && (installEvent || isIOS())) {
      html = `<span>📲 <b>Install the app</b> — it opens full-screen from your home screen${isIOS() ? '. Tap <b>Share</b> then <b>Add to Home Screen</b>.' : ' and gets alerts.'}</span>
        ${installEvent ? '<button class="btn small primary" id="installBtn">Install</button>' : ''}`;
    } else {
      const st = await pushState().catch(() => ({ supported: false }));
      if (st.supported && !st.sub && st.permission === 'default') {
        html = '<span>🔔 <b>Get alerts on this device</b> — orders, new leads and call-back reminders.</span><button class="btn small primary" id="pushOnBtn">Turn on</button>';
      }
    }
    if (!html) return;
    box.innerHTML = `<div class="help-nudge phone-nudge">${html}<button class="link-btn small" id="phoneNudgeX">Not now</button></div>`;
    document.getElementById('phoneNudgeX').onclick = () => { lsSet('eo-phone-nudge-off', true); box.innerHTML = ''; };
    const ib = document.getElementById('installBtn');
    if (ib) ib.onclick = async () => { installEvent.prompt(); await installEvent.userChoice.catch(() => {}); installEvent = null; box.innerHTML = ''; };
    const pb = document.getElementById('pushOnBtn');
    if (pb) pb.onclick = async () => { try { await enablePush(); toast('🔔 Alerts are on for this device'); box.innerHTML = ''; } catch (err) { toast(err.message); } };
  }

  // Leads typed with no signal wait here and are sent when the connection is back.
  const OUTBOX = 'eo-outbox';
  const outbox = () => lsGet(OUTBOX, []).filter((x) => state.me && x.user_id === state.me.id);
  function queueLead(body) {
    const all = lsGet(OUTBOX, []);
    all.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, user_id: state.me.id, body, saved_at: new Date().toISOString() });
    lsSet(OUTBOX, all);
  }
  const dropFromOutbox = (id) => lsSet(OUTBOX, lsGet(OUTBOX, []).filter((x) => x.id !== id));
  let flushing = false;
  async function flushOutbox() {
    if (flushing || !navigator.onLine || !state.me || state.offline) return;
    const items = outbox();
    if (!items.length) return;
    flushing = true;
    try {
      for (const item of items) {
        try {
          const ref = await api('/referrals', { method: 'POST', body: item.body });
          dropFromOutbox(item.id);
          toast(`📶 Sent your saved lead: ${leadName(ref)}`);
        } catch (err) {
          if (!err.status) break; // still offline
          dropFromOutbox(item.id);
          const failed = lsGet('eo-outbox-failed', []);
          failed.push({ ...item, error: err.message });
          lsSet('eo-outbox-failed', failed.slice(-20));
          toast(`A saved lead wasn't sent: ${err.message}`);
        }
      }
    } finally {
      flushing = false;
      drawOutbox();
    }
  }
  function drawOutbox() {
    const box = document.getElementById('outboxBox');
    if (!box) return;
    const waiting = outbox();
    const failed = lsGet('eo-outbox-failed', []).filter((x) => state.me && x.user_id === state.me.id);
    const nameOf = (b) => (b.body.name || (b.body.text || '').split('\n')[0] || 'Lead').slice(0, 40);
    box.innerHTML = (waiting.length ? `<div class="alert warn small">📶 ${waiting.length} lead${waiting.length === 1 ? ' is' : 's are'} saved on this phone and will send when you're back online: ${waiting.map((w) => esc(nameOf(w))).join(', ')}. <button class="link-btn small" id="outboxRetry">Try now</button></div>` : '')
      + (failed.length ? `<div class="alert err small">These saved leads couldn't be sent: ${failed.map((w) => `<b>${esc(nameOf(w))}</b> (${esc(w.error)})`).join(', ')}. <button class="link-btn small" id="outboxClear">Dismiss</button></div>` : '');
    const retry = document.getElementById('outboxRetry');
    if (retry) retry.onclick = () => { state.offline = false; flushOutbox(); };
    const clear = document.getElementById('outboxClear');
    if (clear) clear.onclick = () => { lsSet('eo-outbox-failed', lsGet('eo-outbox-failed', []).filter((x) => x.user_id !== state.me.id)); drawOutbox(); };
  }
  window.addEventListener('online', () => { state.offline = false; document.body.classList.remove('is-offline'); flushOutbox(); });
  window.addEventListener('offline', () => document.body.classList.add('is-offline'));
  setInterval(flushOutbox, 30000);

  // Address suggestions under an input. onPick(suggestion) fills the form.
  function attachAddressSuggest(input, onPick) {
    if (!input) return;
    const box = document.createElement('div');
    box.className = 'addr-suggest';
    box.hidden = true;
    box.setAttribute('role', 'listbox');
    input.parentNode.classList.add('addr-wrap');
    input.after(box);
    input.setAttribute('autocomplete', 'off');
    let last = input.value.trim();
    let items = [];
    let idx = -1;
    const close = () => { box.hidden = true; idx = -1; };
    const draw = () => {
      box.innerHTML = items.map((x, i) => `<button type="button" role="option" data-i="${i}" class="${i === idx ? 'on' : ''}">📍 ${esc(x.label)}</button>`).join('');
      box.hidden = !items.length;
    };
    const pick = (i) => { const x = items[i]; if (!x) return; last = x.label; onPick(x); close(); };
    const run = debounce(async () => {
      const q = input.value.trim();
      if (q === last) return;
      last = q;
      if (q.length < 6 || !/\d/.test(q)) { close(); return; }
      try { items = (await api('/address/suggest?q=' + encodeURIComponent(q))).suggestions || []; idx = -1; draw(); } catch { close(); }
    }, 300);
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(); } else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); } else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); pick(idx); } else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pick(Number(b.dataset.i)); });
  }

  function helpNudge() {
    let seen = false;
    try { seen = localStorage.getItem('eo-help-seen') === '1'; } catch { seen = true; }
    if (seen) return '';
    return `<div class="help-nudge"><span>New here? The <b>2-minute guide</b> shows how to enter leads and follow them.</span>
      <a class="btn small" href="#/help">Open the guide</a><button class="link-btn small" id="helpNudgeX" aria-label="Dismiss">Not now</button></div>`;
  }
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'helpNudgeX') {
      try { localStorage.setItem('eo-help-seen', '1'); } catch { /* ignore */ }
      e.target.closest('.help-nudge')?.remove();
    }
  });

  // ---------- my account ----------

  async function renderAccount() {
    const me = state.me;
    shell(`
      <form class="card narrow" id="acctForm">
        <h1>My account</h1>
        <p class="muted" style="margin-top:0">${esc(me.full_name)} · @${esc(me.username)} · ${roleLabel(me.role)}${me.team_name ? ` · ${esc(me.team_name)}` : ''}</p>
        <div class="field"><label for="em">Email</label><input id="em" type="email" autocapitalize="none" placeholder="you@example.com" value="${esc(me.email)}"></div>
        <label class="check" style="margin-top:.9rem"><input type="checkbox" id="ea" ${me.email_alerts ? 'checked' : ''}> Email me my alerts</label>
        <p class="small muted" style="margin:.3rem 0 0">Status changes on your leads, @mentions, comments on your leads, and leads assigned to you or entered for you. Your email also lets you reset a forgotten password yourself.</p>
        ${me.email_enabled ? '' : '<div class="alert warn small" style="margin-top:.8rem">Email alerts aren\'t switched on for this app yet. You\'ll still see everything under 🔔.</div>'}
        <div id="acctErr" style="margin-top:.8rem"></div>
        <div class="row" style="margin-top:1rem"><button class="btn primary">Save</button><button type="button" class="btn" id="pwBtn">Change password</button></div>
      </form>
      <div class="card narrow" id="pushCard"><h2>Phone notifications</h2><p class="small muted">Checking this device…</p></div>
      <form class="card narrow" id="waMeForm">
        <h2>WhatsApp alerts</h2>
        <p class="small muted" style="margin-top:0">Get your alerts as WhatsApp messages too: ${role() === 'dispatch' ? 'every new lead, leads assigned to you' : 'orders on your leads'}, @mentions and call-back reminders.</p>
        <div class="field"><label for="waMe">Your WhatsApp number</label><input id="waMe" type="tel" inputmode="tel" autocomplete="tel" placeholder="(512) 555-0142" value="${esc(me.whatsapp || '')}"></div>
        <label class="check" style="margin-top:.6rem"><input type="checkbox" id="waMeOn" ${me.whatsapp_alerts ? 'checked' : ''}> Send my alerts to WhatsApp</label>
        ${me.whatsapp_ready ? '' : '<p class="small muted" style="margin:.4rem 0 0">WhatsApp alerts aren\'t switched on for the app yet. Your number is saved, and alerts start as soon as your admin connects WhatsApp.</p>'}
        <div class="row" style="margin-top:.9rem"><button class="btn primary">Save</button>${me.whatsapp_ready && me.whatsapp ? '<button type="button" class="btn" id="waMeTest">Send me a test</button>' : ''}</div>
      </form>
      <div class="card narrow">
        <h2>Appearance</h2>
        <div class="seg" id="themeSeg">${[['system', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-t="${k}" class="${getTheme() === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <h2 style="margin-top:1.4rem">Security</h2>
        <p class="small muted" style="margin-top:0">Signed in on a shared or lost device? Sign out everywhere except here.</p>
        <button class="btn" id="logoutAll">Sign out other devices</button>
      </div>`);
    document.getElementById('pwBtn').onclick = () => renderChangePassword(false);
    drawPushCard();
    document.getElementById('waMeForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const num = document.getElementById('waMe').value;
        await api('/me', { method: 'PATCH', body: { whatsapp: num, whatsapp_alerts: !!num.trim() && document.getElementById('waMeOn').checked } });
        await refreshMe();
        toast(state.me.whatsapp_alerts ? 'Saved — your alerts will also come on WhatsApp' : 'Saved');
        renderAccount();
      } catch (err) { toast(err.message); }
    };
    const waTest = document.getElementById('waMeTest');
    if (waTest) waTest.onclick = async () => { try { await api('/whatsapp/test-me', { method: 'POST', body: {} }); toast('Sent — check WhatsApp'); } catch (err) { toast(err.message); } };
    document.querySelectorAll('#themeSeg button').forEach((b) => {
      b.onclick = () => { setTheme(b.dataset.t); document.querySelectorAll('#themeSeg button').forEach((x) => x.classList.toggle('on', x === b)); };
    });
    document.getElementById('logoutAll').onclick = async () => {
      const r = await api('/me/logout-all', { method: 'POST', body: {} });
      toast(r.signed_out ? `Signed out ${r.signed_out} other session${r.signed_out === 1 ? '' : 's'}` : 'No other sessions');
    };
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

  async function drawPushCard() {
    const card = document.getElementById('pushCard');
    if (!card) return;
    const st = await pushState().catch(() => ({ supported: false }));
    let body;
    if (!st.supported) {
      body = isIOS() && !isStandalone()
        ? '<p>On iPhone, first add the app to your Home Screen: tap <b>Share</b> then <b>Add to Home Screen</b>. Open it from there, come back here, and turn notifications on.</p>'
        : '<p class="muted">This browser can\'t show notifications. Try Chrome, Edge, Firefox or Safari.</p>';
    } else if (st.sub) {
      body = `<p><b class="ok-text">✓ On for this device.</b> You'll get alerts here: orders, leads assigned to you, @mentions and call-back reminders.</p>
        <div class="row"><button class="btn" id="pushTest">Send me a test</button><button class="btn" id="pushOff">Turn off on this device</button></div>`;
    } else if (st.permission === 'denied') {
      body = '<p>Notifications are blocked for this site. Allow them in your browser or phone settings, then reload this page.</p>';
    } else {
      body = `<p>Get alerts on this ${isPhone() ? 'phone' : 'device'} even when the app is closed: orders 🎉, leads assigned to you, @mentions and call-back reminders.</p>
        <button class="btn primary" id="pushOn">Turn on notifications</button>`;
    }
    const install = isPhone() && !isStandalone()
      ? `<p class="small muted" style="margin-top:.8rem">${installEvent ? '<button class="btn small" id="installBtn2">📲 Install the app</button> Opens full-screen from your home screen.' : isIOS() ? '📲 Tip: tap <b>Share → Add to Home Screen</b> to use it like an app.' : '📲 Tip: use your browser menu → <b>Install app</b> / <b>Add to Home screen</b>.'}</p>` : '';
    card.innerHTML = `<h2>Phone notifications</h2>${body}${install}`;
    const on = document.getElementById('pushOn');
    if (on) on.onclick = async () => { try { await enablePush(); toast('🔔 Notifications are on'); drawPushCard(); } catch (err) { toast(err.message); } };
    const test = document.getElementById('pushTest');
    if (test) test.onclick = async () => { try { await api('/push/test', { method: 'POST', body: {} }); toast('Sent — check your notifications'); } catch (err) { toast(err.message); } };
    const off = document.getElementById('pushOff');
    if (off) off.onclick = async () => { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: st.sub.endpoint } }).catch(() => {}); await st.sub.unsubscribe().catch(() => {}); toast('Notifications off on this device'); drawPushCard(); };
    const ib = document.getElementById('installBtn2');
    if (ib) ib.onclick = async () => { installEvent.prompt(); await installEvent.userChoice.catch(() => {}); installEvent = null; drawPushCard(); };
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

  // ---------- analytics & report builder ----------

  let filterOptsCache = null;
  async function getFilterOpts() {
    if (!filterOptsCache) filterOptsCache = await api('/filter-options');
    return filterOptsCache;
  }

  async function renderAnalytics() {
    const params = query();
    const activeTab = params.tab || 'overview';
    const [opts, reports, schedules] = await Promise.all([
      getFilterOpts(),
      api('/reports'),
      api('/analytics/schedules'),
    ]);

    shell(`
      <div class="breadcrumbs">
        <a href="#/home">Home</a>
        <span class="crumb-sep">/</span>
        <span class="crumb-active">Analytics &amp; Custom Reports</span>
      </div>
      <div class="card" style="margin-bottom: 1.2rem;">
        <div class="row between">
          <div>
            <h1 style="margin:0">Analytics &amp; Intelligence</h1>
            <p class="muted small" style="margin:.2rem 0 0">Salesforce-inspired reporting engine, custom builder, and automated schedule deliveries.</p>
          </div>
          <div class="seg" id="analyticsTabSeg">
            <button data-tab="overview" class="${activeTab === 'overview' ? 'on' : ''}">📊 Overview</button>
            <button data-tab="library" class="${activeTab === 'library' ? 'on' : ''}">📁 Report Library (${reports.length})</button>
            <button data-tab="builder" class="${activeTab === 'builder' ? 'on' : ''}">⚡ Report Builder</button>
            <button data-tab="schedules" class="${activeTab === 'schedules' ? 'on' : ''}">📅 Scheduled (${schedules.length})</button>
          </div>
        </div>
      </div>
      <div id="analyticsBody"></div>
    `, { wide: true });

    document.querySelectorAll('#analyticsTabSeg button').forEach((b) => {
      b.onclick = () => { location.hash = '#/analytics?' + new URLSearchParams({ ...params, tab: b.dataset.tab }).toString(); };
    });

    const bodyEl = document.getElementById('analyticsBody');
    if (activeTab === 'overview') renderAnalyticsOverview(bodyEl, opts);
    else if (activeTab === 'library') renderReportLibrary(bodyEl, reports);
    else if (activeTab === 'builder') renderReportBuilder(bodyEl, opts, params.report_id);
    else if (activeTab === 'schedules') renderScheduledReports(bodyEl, schedules, reports);
  }

  async function renderAnalyticsOverview(container, opts) {
    const data = await api('/reports/0/run', {
      method: 'POST',
      body: { config: { group_by: 'state', date_field: 'created_at', relative_date: 'this_month' } },
    });

    container.innerHTML = `
      <div class="stack">
        <div class="card">
          <h2>Executive Summary (This Month)</h2>
          <div class="stats" style="margin-top:.8rem">
            <div class="stat"><div class="n">${data.totals.total_records}</div><div class="l">Total Referrals</div></div>
            <div class="stat Ordered"><div class="n">${data.totals.ordered_count}</div><div class="l">Orders Closed</div></div>
            <div class="stat"><div class="n">${data.totals.conversion_rate}%</div><div class="l">Overall Conversion</div></div>
            <div class="stat"><div class="n">${(data.summary || []).length}</div><div class="l">Active States</div></div>
          </div>
        </div>
        <div class="grid-2">
          <div class="card">
            <div class="row between">
              <h2>Performance by State</h2>
              <button class="btn small" id="openStateReport">Build Full State Report ↗</button>
            </div>
            <div class="table-wrap" style="margin-top:.6rem">
              <table class="matrix-table">
                <thead><tr><th>State</th><th class="num">Leads</th><th class="num">Orders</th><th class="num">Conversion</th></tr></thead>
                <tbody>
                  ${(data.summary || []).map((g) => `
                    <tr>
                      <td><b>${esc(g.group)}</b></td>
                      <td class="num">${g.count}</td>
                      <td class="num"><b>${g.ordered}</b></td>
                      <td class="num">${g.conversion_rate}%</td>
                    </tr>
                  `).join('') || '<tr><td colspan="4" class="muted">No state data yet.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
          <div class="card">
            <h2>Quick Insights &amp; Bottlenecks</h2>
            <div class="insights" style="margin-top:.8rem">
              <div class="insight-card good">
                <div class="insight-title">Top State Conversion</div>
                <div class="insight-body">
                  ${data.summary && data.summary.length ? `State <b>${esc(data.summary[0].group)}</b> leads with <b>${data.summary[0].conversion_rate}%</b> conversion rate.` : 'Gathering period data...'}
                </div>
              </div>
              <div class="insight-card warn">
                <div class="insight-title">Scheduled Delivery Health</div>
                <div class="insight-body">Automated background scheduler is active and evaluating daily cron triggers.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('openStateReport').onclick = () => {
      location.hash = '#/analytics?tab=builder&group_by=state&relative_date=this_month';
    };
  }

  function renderReportLibrary(container, reports) {
    const defaultReports = [
      { id: 0, name: 'State Conversion & Regional Performance', description: 'Breakdown of referrals, orders, and conversion rates grouped by US state.', data_source: 'referrals', is_public: 1, creator_name: 'System Default', group_by: 'state' },
      { id: -1, name: 'Monthly Sales Representative Leaderboard', description: 'Per-rep breakdown of total leads entered vs orders placed with conversion rate.', data_source: 'referrals', is_public: 1, creator_name: 'System Default', group_by: 'created_by_name' },
      { id: -2, name: 'Service Product Mix & Demand Analysis', description: 'Distribution of requested Spectrum services (Internet, TV, Mobile, Voice).', data_source: 'referrals', is_public: 1, creator_name: 'System Default', group_by: 'services' },
      { id: -3, name: 'Blocked Duplicate Attempts Audit Log', description: 'Log of all duplicate lead submissions rejected by multi-team matching.', data_source: 'duplicates', is_public: 1, creator_name: 'System Default', group_by: 'matched_on' },
    ];

    const allReports = [...defaultReports, ...reports];

    container.innerHTML = `
      <div class="card">
        <div class="row between" style="margin-bottom: 1rem;">
          <h2>Report Library</h2>
          <button class="btn primary" id="createNewReportBtn">⚡ Build Custom Report</button>
        </div>
        <div class="table-wrap">
          <table class="rtable">
            <thead>
              <tr><th>Report Name</th><th>Owner</th><th>Visibility</th><th>Data Source</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${allReports.map((r) => `
                <tr>
                  <td data-label="Name">
                    <b>${esc(r.name)}</b>
                    <div class="small muted">${esc(r.description || '')}</div>
                  </td>
                  <td data-label="Owner" class="small">${esc(r.creator_name || 'Me')}</td>
                  <td data-label="Visibility"><span class="badge-status ${r.is_public ? 'success' : 'skipped'}">${r.is_public ? 'Public' : 'Private'}</span></td>
                  <td data-label="Data Source" class="small muted">${esc(r.data_source)}</td>
                  <td data-label="Actions" class="actions">
                    <button class="btn small primary" data-run-rep="${r.id}" data-grp="${r.group_by || ''}">Run</button>
                    ${r.id > 0 ? `<button class="btn small" data-edit-rep="${r.id}">Edit</button>` : ''}
                    ${r.id > 0 ? `<button class="btn small danger" data-del-rep="${r.id}">Delete</button>` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('createNewReportBtn').onclick = () => {
      location.hash = '#/analytics?tab=builder';
    };

    container.querySelectorAll('[data-run-rep]').forEach((b) => {
      b.onclick = () => {
        const id = Number(b.dataset.runRep);
        if (id > 0) location.hash = `#/analytics?tab=builder&report_id=${id}`;
        else location.hash = `#/analytics?tab=builder&group_by=${b.dataset.grp}`;
      };
    });

    container.querySelectorAll('[data-edit-rep]').forEach((b) => {
      b.onclick = () => {
        location.hash = `#/analytics?tab=builder&report_id=${b.dataset.editRep}`;
      };
    });

    container.querySelectorAll('[data-del-rep]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Are you sure you want to delete this saved report?')) return;
        try {
          await api(`/reports/${b.dataset.delRep}`, { method: 'DELETE' });
          toast('Report deleted');
          renderAnalytics();
        } catch (err) { toast(err.message); }
      };
    });
  }

  async function renderReportBuilder(container, opts, reportId) {
    let report = null;
    let config = {
      group_by: query().group_by || 'state',
      secondary_group_by: '',
      relative_date: query().relative_date || 'this_month',
      columns: ['id', 'created_at', 'customer_name', 'phone', 'email', 'address', 'state', 'services', 'status', 'created_by_name', 'team_name'],
      filters: [],
    };

    if (reportId && Number(reportId) > 0) {
      try {
        report = await api(`/reports/${reportId}`);
        config = report.config || config;
      } catch (err) { toast(err.message); }
    }

    container.innerHTML = `
      <div class="report-builder-layout">
        <form class="report-config-panel" id="reportBuilderForm">
          <h2>Report Configuration</h2>
          <div class="field">
            <label for="rb_name">Report Name</label>
            <input id="rb_name" value="${esc(report ? report.name : 'Untitled Sales Report')}" required>
          </div>
          <div class="field">
            <label for="rb_desc">Description</label>
            <input id="rb_desc" value="${esc(report ? report.description : '')}" placeholder="Optional purpose notes">
          </div>
          <div class="field">
            <label for="rb_group">Primary Grouping</label>
            <select id="rb_group">
              <option value="">None (Flat List)</option>
              <option value="state" ${config.group_by === 'state' ? 'selected' : ''}>State / Territory</option>
              <option value="status" ${config.group_by === 'status' ? 'selected' : ''}>Status</option>
              <option value="created_by_name" ${config.group_by === 'created_by_name' ? 'selected' : ''}>Sales Representative</option>
              <option value="team_name" ${config.group_by === 'team_name' ? 'selected' : ''}>Team</option>
              <option value="services" ${config.group_by === 'services' ? 'selected' : ''}>Service Type</option>
            </select>
          </div>
          <div class="field">
            <label for="rb_sec_group">Secondary Grouping</label>
            <select id="rb_sec_group">
              <option value="">None</option>
              <option value="status" ${config.secondary_group_by === 'status' ? 'selected' : ''}>Status</option>
              <option value="state" ${config.secondary_group_by === 'state' ? 'selected' : ''}>State</option>
              <option value="services" ${config.secondary_group_by === 'services' ? 'selected' : ''}>Service Type</option>
            </select>
          </div>
          <div class="field">
            <label for="rb_rel_date">Date Range Preset</label>
            <select id="rb_rel_date">
              <option value="">All Time</option>
              ${opts.date_presets.map((p) => `<option value="${p.id}" ${config.relative_date === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </div>
          <label class="check" style="margin-top:.8rem;">
            <input type="checkbox" id="rb_public" ${report && report.is_public ? 'checked' : ''}> Make report visible to team (Public)
          </label>
          <div class="row" style="margin-top:1.2rem">
            <button type="submit" class="btn primary">Run &amp; Update Preview</button>
            <button type="button" class="btn" id="saveReportBtn">Save Report</button>
          </div>
        </form>
        <div class="report-preview-panel">
          <div class="row between" style="margin-bottom:1rem">
            <div>
              <h2 id="prevTitle" style="margin:0">${esc(report ? report.name : 'Report Preview')}</h2>
              <span class="small muted" id="prevSubtitle">Run query to view matrix output</span>
            </div>
            <div class="row">
              <button class="btn small" id="exportReportCsv">⬇ Export CSV</button>
              ${report ? `<button class="btn small primary" id="scheduleReportBtn">📅 Schedule Delivery</button>` : ''}
            </div>
          </div>
          <div id="reportPreviewResults">
            <p class="muted">Click "Run &amp; Update Preview" to execute custom aggregation query.</p>
          </div>
        </div>
      </div>
    `;

    const form = document.getElementById('reportBuilderForm');
    const prevResults = document.getElementById('reportPreviewResults');

    const runPreview = async () => {
      const cfg = {
        group_by: document.getElementById('rb_group').value,
        secondary_group_by: document.getElementById('rb_sec_group').value,
        relative_date: document.getElementById('rb_rel_date').value,
        columns: ['id', 'created_at', 'customer_name', 'phone', 'email', 'address', 'state', 'services', 'status', 'created_by_name', 'team_name'],
      };

      try {
        const res = await api(reportId ? `/reports/${reportId}/run` : '/reports/0/run', {
          method: 'POST',
          body: { config: cfg },
        });

        document.getElementById('prevSubtitle').textContent = `Matched ${res.total_records} records · Overall Conversion: ${res.totals.conversion_rate}%`;

        if (cfg.group_by && res.summary) {
          prevResults.innerHTML = `
            <div class="table-wrap">
              <table class="matrix-table">
                <thead>
                  <tr>
                    <th>${esc(cfg.group_by.toUpperCase())}</th>
                    <th class="num">TOTAL LEADS</th>
                    <th class="num">ORDERED</th>
                    <th class="num">CONVERSION</th>
                  </tr>
                </thead>
                <tbody>
                  ${res.summary.map((g) => `
                    <tr>
                      <td><b>${esc(g.group)}</b></td>
                      <td class="num">${g.count}</td>
                      <td class="num"><b>${g.ordered}</b></td>
                      <td class="num">${g.conversion_rate}%</td>
                    </tr>
                    ${(g.subgroups || []).map((s) => `
                      <tr class="matrix-subrow">
                        <td style="padding-left: 1.8rem;">↳ ${esc(s.group)}</td>
                        <td class="num">${s.count}</td>
                        <td class="num">${s.ordered}</td>
                        <td class="num">${s.conversion_rate}%</td>
                      </tr>
                    `).join('')}
                  `).join('')}
                  <tr class="matrix-total">
                    <td>GRAND TOTAL</td>
                    <td class="num">${res.totals.total_records}</td>
                    <td class="num">${res.totals.ordered_count}</td>
                    <td class="num">${res.totals.conversion_rate}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          `;
        } else {
          prevResults.innerHTML = `
            <div class="table-wrap">
              <table class="rtable">
                <thead><tr><th>Customer</th><th>Status</th><th>State</th><th>Rep</th><th>Services</th></tr></thead>
                <tbody>
                  ${res.rows.map((r) => `
                    <tr>
                      <td><b>${esc(leadName(r))}</b></td>
                      <td>${pill(r.status)}</td>
                      <td>${esc(r.state)}</td>
                      <td>${esc(r.created_by_name)}</td>
                      <td>${svcTags(r.services)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `;
        }
      } catch (err) {
        prevResults.innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      }
    };

    form.onsubmit = (e) => {
      e.preventDefault();
      runPreview();
    };

    document.getElementById('saveReportBtn').onclick = async () => {
      const body = {
        name: document.getElementById('rb_name').value,
        description: document.getElementById('rb_desc').value,
        is_public: document.getElementById('rb_public').checked,
        config: {
          group_by: document.getElementById('rb_group').value,
          secondary_group_by: document.getElementById('rb_sec_group').value,
          relative_date: document.getElementById('rb_rel_date').value,
        },
      };

      try {
        if (reportId) {
          await api(`/reports/${reportId}`, { method: 'PATCH', body });
          toast('Report updated');
        } else {
          const r = await api('/reports', { method: 'POST', body });
          toast('Report created');
          location.hash = `#/analytics?tab=builder&report_id=${r.id}`;
        }
      } catch (err) { toast(err.message); }
    };

    document.getElementById('exportReportCsv').onclick = () => {
      if (reportId) location.href = `/api/reports/${reportId}/export`;
      else toast('Please save the report first to export CSV.');
    };

    const schedBtn = document.getElementById('scheduleReportBtn');
    if (schedBtn) {
      schedBtn.onclick = () => {
        openScheduleModal(reportId, opts);
      };
    }

    runPreview();
  }

  function renderScheduledReports(container, schedules, reports) {
    container.innerHTML = `
      <div class="card">
        <div class="row between" style="margin-bottom:1rem">
          <h2>Automated Scheduled Report Deliveries</h2>
          <button class="btn primary" id="addNewScheduleBtn">📅 Add New Schedule</button>
        </div>
        <div class="table-wrap">
          <table class="rtable">
            <thead>
              <tr><th>Report</th><th>Cadence</th><th>Recipients</th><th>Next Run</th><th>Last Run Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${schedules.map((s) => {
                let rec = [];
                try { rec = JSON.parse(s.recipients || '[]'); } catch { rec = []; }
                return `
                  <tr>
                    <td data-label="Report"><b>${esc(s.report_name)}</b></td>
                    <td data-label="Cadence"><span class="tag">${esc(s.cadence)} at ${esc(s.delivery_time)}</span></td>
                    <td data-label="Recipients" class="small">${esc(rec.join(', ') || 'Creator')}</td>
                    <td data-label="Next Run" class="small">${esc(fullDate(s.next_run_at))}</td>
                    <td data-label="Last Status">
                      <span class="badge-status ${s.last_status === 'success' ? 'success' : s.last_status === 'skipped' ? 'skipped' : 'failed'}">
                        ${esc(s.last_status || 'Pending')}
                      </span>
                    </td>
                    <td data-label="Actions" class="actions">
                      <button class="btn small primary" data-test-sched="${s.id}">Test Now</button>
                      <button class="btn small" data-hist-sched="${s.id}">History</button>
                      <button class="btn small danger" data-del-sched="${s.id}">Delete</button>
                    </td>
                  </tr>
                `;
              }).join('') || '<tr><td colspan="6" class="muted">No report schedules created yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('addNewScheduleBtn').onclick = () => {
      if (!reports.length) { toast('Please create a saved report first in the Report Builder.'); return; }
      openScheduleModal(reports[0].id, filterOptsCache, reports);
    };

    container.querySelectorAll('[data-test-sched]').forEach((b) => {
      b.onclick = async () => {
        try {
          const res = await api(`/schedules/${b.dataset.testSched}/test`, { method: 'POST', body: {} });
          toast(`Scheduled run test finished: ${res.count} records processed.`);
          renderAnalytics();
        } catch (err) { toast(err.message); }
      };
    });

    container.querySelectorAll('[data-hist-sched]').forEach((b) => {
      b.onclick = async () => {
        const hist = await api(`/schedules/${b.dataset.histSched}/history`);
        modal(`
          <h2>Delivery History</h2>
          <div class="table-wrap" style="max-height:50vh;overflow:auto">
            <table class="rtable">
              <thead><tr><th>Time</th><th>Status</th><th>Records</th><th>Period</th></tr></thead>
              <tbody>
                ${hist.map((h) => `
                  <tr>
                    <td>${esc(fullDate(h.run_at))}</td>
                    <td><span class="badge-status ${h.status}">${esc(h.status)}</span></td>
                    <td>${h.record_count}</td>
                    <td>${esc(h.period_label)}</td>
                  </tr>
                `).join('') || '<tr><td colspan="4" class="muted">No execution history logged.</td></tr>'}
              </tbody>
            </table>
          </div>
          <div class="row" style="justify-content:flex-end;margin-top:1rem"><button class="btn" data-close>Close</button></div>
        `, { wide: true });
      };
    });

    container.querySelectorAll('[data-del-sched]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Delete this report schedule?')) return;
        try {
          await api(`/schedules/${b.dataset.delSched}`, { method: 'DELETE' });
          toast('Schedule deleted');
          renderAnalytics();
        } catch (err) { toast(err.message); }
      };
    });
  }

  function openScheduleModal(reportId, opts, reportsList = []) {
    const m = modal(`
      <form id="schedForm">
        <h2>Schedule Report Delivery</h2>
        ${reportsList.length ? `
          <div class="field">
            <label for="sc_report">Report</label>
            <select id="sc_report">${reportsList.map((r) => `<option value="${r.id}" ${r.id === reportId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
          </div>
        ` : ''}
        <div class="field">
          <label for="sc_cadence">Cadence</label>
          <select id="sc_cadence">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly (Mondays)</option>
            <option value="monthly">Monthly (1st of month)</option>
          </select>
        </div>
        <div class="field">
          <label for="sc_time">Delivery Time (UTC/Server)</label>
          <input id="sc_time" type="time" value="08:00" required>
        </div>
        <div class="field">
          <label for="sc_rec">Recipients (Comma-separated emails)</label>
          <input id="sc_rec" value="${esc(state.me.email)}" placeholder="rep@company.com, manager@company.com">
        </div>
        <label class="check" style="margin-top:.8rem">
          <input type="checkbox" id="sc_skip" checked> Skip delivery if report returns 0 records
        </label>
        <div class="row" style="justify-content:flex-end;margin-top:1.2rem">
          <button type="button" class="btn" data-close>Cancel</button>
          <button class="btn primary">Create Schedule</button>
        </div>
      </form>
    `);

    m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const targetReportId = document.getElementById('sc_report') ? Number(document.getElementById('sc_report').value) : reportId;
      const rec = document.getElementById('sc_rec').value.split(',').map((x) => x.trim()).filter(Boolean);

      try {
        await api(`/reports/${targetReportId}/schedules`, {
          method: 'POST',
          body: {
            cadence: document.getElementById('sc_cadence').value,
            delivery_time: document.getElementById('sc_time').value,
            recipients: rec,
            skip_empty: document.getElementById('sc_skip').checked,
          },
        });
        closeModal();
        toast('Report schedule created!');
        location.hash = '#/analytics?tab=schedules';
      } catch (err) { toast(err.message); }
    };
  }

  // ---------- audit logs view ----------

  async function renderAuditLogs() {
    if (!isAdmin()) { location.hash = defaultRoute(); return; }
    const logs = await api('/audit-logs');

    shell(`
      <div class="card">
        <h1>Enterprise Security &amp; Audit Logs</h1>
        <p class="muted small" style="margin-top:0">Complete immutable record of report generation, exports, scheduling, and administrative events.</p>
        <div class="table-wrap" style="margin-top:1rem">
          <table class="rtable">
            <thead>
              <tr><th>Timestamp</th><th>User</th><th>Action</th><th>Resource</th><th>Details</th><th>IP</th></tr>
            </thead>
            <tbody>
              ${logs.map((l) => `
                <tr>
                  <td class="small muted">${esc(fullDate(l.created_at))}</td>
                  <td><b>${esc(l.full_name || l.username)}</b></td>
                  <td><span class="tag">${esc(l.action)}</span></td>
                  <td class="small">${esc(l.resource_type)} #${esc(l.resource_id)}</td>
                  <td class="small">${esc(l.details)}</td>
                  <td class="small muted">${esc(l.ip)}</td>
                </tr>
              `).join('') || '<tr><td colspan="6" class="muted">No audit logs recorded.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `);
  }



  async function route_() {
    const join = location.hash.match(/^#\/join\/(a\/)?([A-Za-z0-9_-]{6,64})$/);
    if (join) return renderJoin(join[2], !!join[1]);
    if (!state.me) return renderLogin();
    if (state.me.must_change_password) return renderChangePassword(true);
    const h = location.hash.split('?')[0] || defaultRoute();
    try {
      let m;
      if ((m = h.match(/^#\/r\/(\d+)$/))) return await renderReferral(m[1]);
      if (h === '#/referrals') return await renderReferrals();
      if (h === '#/board') return await renderBoard();
      if (h === '#/duplicates') return await renderDuplicates();
      if (h === '#/sales') return await renderSales();
      if (h === '#/analytics') return await renderAnalytics();
      if (h === '#/audit-logs') return await renderAuditLogs();
      if (h === '#/team') return await renderTeam();
      if (h === '#/payments') return await renderPayments();
      if (h === '#/affiliate') return await renderAffiliate();

      if (h === '#/notifications') return await renderNotifications();
      if (h === '#/account') return await renderAccount();
      if (h === '#/help') return await renderHelp();
      if (h === '#/home') return await renderHome();
      if (h === '#/new') return await renderNew();
      location.replace(defaultRoute());
      return undefined;
    } catch (e) {
      if (state.me) toast(e.message);
    }
  }

  window.addEventListener('hashchange', async () => {
    state.menuOpen = false;
    if (state.me) await refreshMe().catch(() => {});
    if (!location.hash.startsWith('#/r/')) state.editing = null;
    if (!location.hash.startsWith('#/home')) state.dashEdit = null;
    closeMenus(); closeModal(); hideTip();
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
      if (res.ok) { state.me = await res.json(); lsSet('eo-me', state.me); } else lsSet('eo-me', null);
    } catch {
      // No signal: open with the last signed-in user so leads can still be entered.
      state.me = lsGet('eo-me', null);
      state.offline = !!state.me;
      document.body.classList.add('is-offline');
      if (state.me && !location.hash.startsWith('#/new')) location.hash = '#/new';
    }
    route_();
    flushOutbox();
  })();
})();
