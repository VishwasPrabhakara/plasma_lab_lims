/* =============================================================================
 * Plasma Lab LIMS — v2 client
 * IISc CST · Bengaluru
 *
 * Backend API preserved verbatim. Every existing function still works.
 * Every new feature (reason-for-change, signature, analyst≠approver) is
 * frontend-shaped so it can plug in when backend supports it.
 * ============================================================================= */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------- */
  /* State                                                                  */
  /* ---------------------------------------------------------------------- */
  const state = {
    token: localStorage.getItem('plasma-lab-token') || sessionStorage.getItem('plasma-lab-token') || '',
    user: null,
    users: [], people: [], storageLocations: [], tests: [], samples: [], audit: [],
    alerts: null, exports: [], health: null,
    selectedId: '',
    view: 'dashboard',
    tab: 'overview',
    stream: null,
    sampleDetailOpen: false,
    openedUrlSample: false,
    sampleFilters: { q:'', status:'', from:'', to:'', project:'', collector:'', analyst:'', storage:'' },
    pendingSignupId: '', resetId: '',
    showInactiveUsers: false,
    selectedRequestedTests: [],
    pendingConfirm: null,
    pendingApproval: null
  };

  const CONFIG = window.PLASMA_LIMS_CONFIG || {};
  const API_BASE = String(CONFIG.API_BASE || '').replace(/\/$/, '');
  const STATUS_OPTIONS = ['Bottle Ready','Sample Collected','Stored','Assigned','In Analysis','Results Entered','Needs Review','Approved','Flagged','Disposed'];
  const LIFECYCLE_STRIP = ['Bottle Ready','Sample Collected','Stored','Assigned','In Analysis','Needs Review','Approved'];

  /* ---------------------------------------------------------------------- */
  /* DOM helpers                                                            */
  /* ---------------------------------------------------------------------- */
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = str => String(str ?? '').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k,v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class')       el.className = v;
      else if (k === 'html')   el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (v === true)     el.setAttribute(k, '');
      else                     el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(c));
      else el.appendChild(c);
    }
    return el;
  };
  const statusClass = s => 'status-' + String(s || '').replaceAll(' ','-');
  const roleLabel = r => r === 'admin' ? 'Admin / Manager' : 'Analyst';
  const initials = name => String(name || '?').trim().split(/\s+/).map(p => p[0]).slice(0,2).join('').toUpperCase();

  /* ---------------------------------------------------------------------- */
  /* API                                                                    */
  /* ---------------------------------------------------------------------- */
  const apiUrl = path => {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    if (path.startsWith('/api') || path.startsWith('/uploads')) return API_BASE + path;
    return path;
  };
  const api = (path, options = {}) => {
    const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch(apiUrl(path), { ...options, headers: { ...headers, ...(options.headers || {}) } }).then(async res => {
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      let data = null;
      if (ct.includes('application/json')) data = text ? JSON.parse(text) : null;
      else if (!res.ok) throw new Error('Server returned ' + res.status);
      else return text;
      if (res.status === 401 && path !== '/api/login') { clearSession(); showAuth(); throw new Error('Session expired — please sign in again.'); }
      if (!res.ok) throw new Error(data?.error || 'Request failed');
      return data;
    });
  };
  const clearSession = () => {
    localStorage.removeItem('plasma-lab-token');
    sessionStorage.removeItem('plasma-lab-token');
    state.token = ''; state.user = null;
  };

  /* ---------------------------------------------------------------------- */
  /* Notifications (persistent, replaces toast)                             */
  /* ---------------------------------------------------------------------- */
  const NOTIF_ICONS = { success: '✓', warn: '!', error: '!', info: 'i' };
  function notify(opts) {
    const stack = $('#notificationStack');
    const type = opts.type || 'info';
    const el = h('div', { class: 'notification', 'data-type': type, role: type === 'error' || type === 'warn' ? 'alert' : 'status' },
      h('div', { class: 'notif-icon', 'aria-hidden': 'true' }, NOTIF_ICONS[type] || '·'),
      h('div', { class: 'notif-body' },
        h('div', { class: 'notif-title' }, opts.title || ''),
        opts.description ? h('div', { class: 'notif-desc' }, opts.description) : null,
        opts.action ? h('button', { class: 'notif-action', type: 'button', onclick: () => { opts.action.fn(); dismiss(); } }, opts.action.label) : null
      ),
      h('button', { class: 'notif-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => dismiss() }, '×')
    );
    function dismiss() { if (el.parentNode) el.parentNode.removeChild(el); }
    // Limit stack
    while (stack.children.length >= 3) stack.removeChild(stack.firstChild);
    stack.appendChild(el);
    // Auto-dismiss success after 5s (user-adjustable via inline close); errors persist
    if (type === 'success' && !opts.persist) setTimeout(dismiss, 5000);
    return { dismiss };
  }

  /* ---------------------------------------------------------------------- */
  /* Confirm dialog                                                          */
  /* ---------------------------------------------------------------------- */
  function confirmDialog(opts) {
    return new Promise(resolve => {
      const dlg = $('#confirmDialog');
      $('#confirmTitle').textContent = opts.title || 'Confirm';
      $('#confirmMessage').textContent = opts.message || 'Are you sure?';
      const okBtn = $('#confirmOk');
      okBtn.textContent = opts.okLabel || 'Confirm';
      okBtn.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      state.pendingConfirm = resolve;
      dlg.showModal();
    });
  }
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-confirm]');
    if (!btn) return;
    const dlg = btn.closest('dialog');
    if (dlg && state.pendingConfirm) {
      const value = btn.dataset.confirm === 'true';
      const cb = state.pendingConfirm;
      state.pendingConfirm = null;
      dlg.close();
      cb(value);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Safe submit wrapper                                                    */
  /* ---------------------------------------------------------------------- */
  function safe(handler) {
    return async event => {
      const control = event?.submitter || event?.currentTarget;
      const canLock = control && 'disabled' in control;
      if (canLock && control.disabled) return;
      let originalLabel = null;
      if (canLock) {
        const labelEl = control.querySelector('.btn-label') || control;
        originalLabel = labelEl.textContent;
        if (control.dataset.busyLabel) labelEl.textContent = control.dataset.busyLabel;
        control.disabled = true;
        control.setAttribute('aria-busy', 'true');
      }
      try {
        await handler(event);
      } catch (err) {
        // Prefer inline form error banner
        const form = event?.target?.closest('form') || control?.closest('form');
        if (form) {
          const banner = form.querySelector('[data-form-error]');
          if (banner) {
            banner.textContent = err.message || 'Action failed';
            banner.classList.remove('hidden');
            setTimeout(() => banner.classList.add('hidden'), 8000);
          }
        }
        notify({ type: 'error', title: 'Something went wrong', description: err.message || 'Action failed' });
      } finally {
        if (canLock) {
          const labelEl = control.querySelector('.btn-label') || control;
          if (originalLabel != null) labelEl.textContent = originalLabel;
          control.disabled = false;
          control.removeAttribute('aria-busy');
        }
      }
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Auth view control                                                      */
  /* ---------------------------------------------------------------------- */
  function showApp() { $('#authView').classList.add('hidden'); $('#appView').classList.remove('hidden'); }
  function showAuth() { $('#authView').classList.remove('hidden'); $('#appView').classList.add('hidden'); showSlide('login'); }
  function showSlide(name) {
    $$('.auth-slide').forEach(el => el.classList.remove('is-active'));
    const map = { login: '#loginForm', signup: '#signupForm', reset: '#resetStartForm', resetConfirm: '#resetConfirmForm' };
    const el = document.querySelector(map[name] || '#loginForm');
    if (el) el.classList.add('is-active');
    if (name === 'signup' && !state.pendingSignupId) setSignupStep('email');
    // Clear any lingering error banner
    $$('.form-error-banner').forEach(b => b.classList.add('hidden'));
  }
  function setSignupStep(step) {
    const order = ['email','phone','password'];
    const idx = order.indexOf(step);
    $$('#signupForm .signup-step').forEach(el => {
      const i = order.indexOf(el.dataset.step);
      el.dataset.state = i === idx ? 'active' : (i < idx ? 'done' : 'hidden');
    });
    $$('#signupForm .step').forEach(el => {
      const i = order.indexOf(el.dataset.progress);
      if (i < idx) { el.setAttribute('data-done','true'); el.removeAttribute('aria-current'); }
      else if (i === idx) { el.setAttribute('aria-current','step'); el.removeAttribute('data-done'); }
      else { el.removeAttribute('data-done'); el.removeAttribute('aria-current'); }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Live field checks                                                      */
  /* ---------------------------------------------------------------------- */
  function setCheck(id, result) {
    const el = $('#' + id);
    if (!el) return;
    if (!result?.message) { el.textContent = ''; el.className = 'field-check'; el.title = ''; return; }
    const isOk = result.valid && result.available;
    el.textContent = result.message;
    el.className = 'field-check ' + (isOk ? 'is-ok' : 'is-bad');
    el.title = result.message;
  }
  let validateTimer = null;
  function scheduleSignupValidation() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(validateSignupFields, 300);
  }
  async function validateSignupFields() {
    const form = $('#signupForm');
    if (!form) return {};
    const params = new URLSearchParams({
      email: form.elements.email.value.trim(),
      countryCode: form.elements.countryCode.value,
      phone: form.elements.phone.value.trim()
    });
    try {
      const data = await api('/api/validate/signup?' + params);
      setCheck('emailCheck', data.email);
      setCheck('phoneCheck', data.phone);
      return data;
    } catch { return {}; }
  }
  function validatePasswordFields() {
    const f = $('#signupForm'); if (!f) return false;
    const pw = f.elements.password.value;
    const cf = f.elements.confirmPassword.value;
    let msg = '', ok = false;
    if (pw.length === 0 && cf.length === 0) msg = '';
    else if (pw.length < 6) msg = 'Use at least 6 characters';
    else if (cf && pw !== cf) msg = 'Passwords do not match';
    else if (pw.length >= 6 && cf === pw) { msg = 'Password ready'; ok = true; }
    setCheck('passwordCheck', { valid: ok, available: ok, message: msg });
    return ok;
  }

  /* ---------------------------------------------------------------------- */
  /* Bootstrap load                                                         */
  /* ---------------------------------------------------------------------- */
  async function load() {
    const data = await api('/api/bootstrap');
    Object.assign(state, data);
    state.alerts = data.alerts || null;
    if (can('admin')) { state.exports = data.files || []; state.health = data.health || null; }
    else { state.exports = []; state.health = null; }
    localStorage.setItem('plasma-lab-cache', JSON.stringify(data));
    if (!state.selectedId && state.samples[0]) state.selectedId = state.samples[0].id;
    updateUserBlock();
    render();
    await openUrlSampleOnce().catch(err => notify({ type: 'error', title: 'QR link failed', description: err.message }));
  }
  function can(...roles) { return state.user && roles.includes(state.user.role); }
  function canModifySamples() { return can('admin','analyst'); }
  function canEnterResults() { return can('admin','analyst'); }
  function canUploadFiles()  { return can('admin','analyst'); }
  function canApprove()      { return can('admin'); }

  function updateUserBlock() {
    if (!state.user) return;
    $('#userName').textContent = state.user.name;
    $('#userRole').textContent = roleLabel(state.user.role);
    $('#userAvatar').textContent = initials(state.user.name);
    // Show admin-only header actions
    $('#newSampleBtn').classList.toggle('hidden', !can('admin'));
    $('#bulkSampleBtn').classList.toggle('hidden', !can('admin'));
    $('#backupBtn').classList.toggle('hidden', !can('admin'));
  }

  /* ---------------------------------------------------------------------- */
  /* Nav (role-adaptive)                                                    */
  /* ---------------------------------------------------------------------- */
  const NAV_ITEMS = [
    { id: 'dashboard', label: 'Dashboard', roles: ['admin','analyst'], icon: 'grid', section: 'Work' },
    { id: 'samples',   label: 'Samples',   roles: ['admin','analyst'], icon: 'file', section: 'Work' },
    { id: 'scan',      label: 'Scan QR',   roles: ['admin','analyst'], icon: 'scan', section: 'Work' },
    { id: 'approvals', label: 'Approvals', roles: ['admin'],           icon: 'check', section: 'Work', badgeKey: 'waitingApproval' },
    { id: 'masters',   label: 'People & Storage', roles: ['admin'],    icon: 'users', section: 'Admin' },
    { id: 'users',     label: 'Users',     roles: ['admin'],           icon: 'user', section: 'Admin' },
    { id: 'backup',    label: 'Data Backup', roles: ['admin'],         icon: 'db', section: 'Admin' },
    { id: 'audit',     label: 'Activity Log', roles: ['admin'],        icon: 'log', section: 'Admin' }
  ];
  const ICONS = {
    grid:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    file:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v4l4 4v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V11l4-4z"/></svg>',
    scan:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="7" width="4" height="4"/><rect x="7" y="13" width="4" height="4"/><path d="M13 13h4v4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    user:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    db:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
    log:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>'
  };
  function renderNav() {
    const list = $('#navList');
    const items = NAV_ITEMS.filter(x => x.roles.includes(state.user?.role));
    if (!items.some(x => x.id === state.view)) state.view = 'dashboard';
    const sections = {};
    items.forEach(x => { (sections[x.section] ||= []).push(x); });
    list.innerHTML = '';
    for (const [section, secItems] of Object.entries(sections)) {
      list.appendChild(h('li', { class: 'nav-section-title' }, section));
      for (const item of secItems) {
        const badge = item.badgeKey ? (state.alerts?.[item.badgeKey]?.length || 0) : 0;
        const btn = h('button', { class: 'nav-item', type: 'button', 'data-view': item.id, 'aria-current': state.view === item.id ? 'page' : null, html:
          ICONS[item.icon] + `<span>${esc(item.label)}</span>` + (badge > 0 ? `<span class="nav-count">${badge}</span>` : '')
        });
        list.appendChild(h('li', null, btn));
      }
    }
    // Mobile tab bar — Scan, Samples, Home, Me
    $$('#tabBar .tab').forEach(t => {
      t.setAttribute('aria-current', t.dataset.view === state.view ? 'page' : 'false');
      if (t.dataset.view === 'me' && state.view === 'me') t.setAttribute('aria-current', 'page');
    });
  }
  $('#navList').addEventListener('click', e => {
    const btn = e.target.closest('[data-view]'); if (!btn) return;
    switchView(btn.dataset.view);
  });
  $('#tabBar').addEventListener('click', e => {
    const btn = e.target.closest('[data-view]'); if (!btn) return;
    if (btn.dataset.view === 'scan') switchView('scan');
    else if (btn.dataset.view === 'me') switchView('backup'); // fallback for admin; for analyst just show sign-out
    else switchView(btn.dataset.view);
  });

  /* ---------------------------------------------------------------------- */
  /* Header title map                                                       */
  /* ---------------------------------------------------------------------- */
  const TITLES = {
    dashboard: ['Dashboard', 'Live records held by the backend and mirrored in this browser.'],
    samples:   ['Samples', 'Prepare bottle labels, update storage, assign, enter results and close samples.'],
    approvals: ['Approval queue', 'Samples waiting for review.'],
    scan:      ['Scan QR', 'Use the camera to open a sample, or type the code manually.'],
    masters:   ['People & Storage', 'Analysts, freezer/rack locations, and test methods.'],
    users:     ['Users', 'Create admin and analyst logins.'],
    backup:    ['Data Backup', 'Daily and weekly readable exports and database health.'],
    audit:     ['Activity Log', 'Every important action is retained — never modified or deleted.']
  };

  function switchView(view) {
    state.view = view;
    state.sampleDetailOpen = false;
    if (view !== 'scan') stopScanner();
    render();
  }

  /* ---------------------------------------------------------------------- */
  /* Master render                                                          */
  /* ---------------------------------------------------------------------- */
  function render() {
    renderNav();
    $$('.view').forEach(v => v.classList.add('hidden'));
    const active = $('#' + state.view + 'View');
    if (active) active.classList.remove('hidden');
    const t = TITLES[state.view] || ['', ''];
    $('#viewTitle').textContent = t[0];
    $('#viewHint').textContent = t[1];

    renderSampleDialogOptions();
    if (state.view === 'dashboard') renderDashboard();
    if (state.view === 'samples')   renderSamples();
    if (state.view === 'approvals') renderApprovals();
    if (state.view === 'scan')      renderScan();
    if (state.view === 'masters')   renderMasters();
    if (state.view === 'users')     renderUsers();
    if (state.view === 'backup')    renderBackup();
    if (state.view === 'audit')     renderAudit();
  }

  /* ---------------------------------------------------------------------- */
  /* Dashboard                                                              */
  /* ---------------------------------------------------------------------- */
  function renderDashboard() {
    const s = state.samples;
    const alerts = state.alerts || {};
    const counts = [
      { label: 'Total samples', value: s.length, tone: 'accent' },
      { label: 'Bottles ready', value: s.filter(x => x.status === 'Bottle Ready').length, tone: 'info' },
      { label: 'In storage',    value: s.filter(x => x.status === 'Stored').length, tone: 'success' },
      { label: 'In analysis',   value: s.filter(x => x.status === 'In Analysis').length, tone: 'warn' },
      { label: 'Needs review',  value: alerts.waitingApproval?.length || s.filter(x => x.status === 'Needs Review' || x.status === 'Results Entered').length, tone: 'warn' },
      { label: 'Flagged',       value: s.filter(x => x.status === 'Flagged').length, tone: 'danger' }
    ];
    const recentSamples = s.slice(0, 8);
    const root = $('#dashboardView');
    root.innerHTML = '';

    root.appendChild(h('section', { class: 'dashboard-hero' },
      h('h3', null, `Good ${greeting()}, ${state.user?.name?.split(' ')[0] || ''}`),
      h('p', null, s.length === 0 ? 'No samples yet — press "+ New sample" to register the first bottle.' : `You have ${s.length} sample${s.length === 1 ? '' : 's'} across the lab.`)
    ));

    root.appendChild(h('section', { class: 'metric-grid' },
      ...counts.map(c => h('div', { class: 'metric', 'data-tone': c.tone },
        h('div', { class: 'metric-label' }, c.label),
        h('div', { class: 'metric-value' }, String(c.value))
      ))
    ));

    if (alerts.overdue?.length || alerts.dueSoon?.length) {
      root.appendChild(h('section', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, 'Attention'), null),
        h('div', { class: 'card-body' },
          ...(alerts.overdue?.length ? [h('div', { class: 'form-error-banner' }, `${alerts.overdue.length} sample${alerts.overdue.length === 1 ? '' : 's'} past target completion.`)] : []),
          ...(alerts.dueSoon?.length ? [h('div', { class: 'muted' }, `${alerts.dueSoon.length} sample${alerts.dueSoon.length === 1 ? '' : 's'} due in the next 24 hours.`)] : [])
        )
      ));
    }

    const list = h('div', { class: 'card' });
    list.appendChild(h('div', { class: 'card-header' },
      h('h3', { class: 'card-title' }, 'Recent samples'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => switchView('samples') }, h('span',{class:'btn-label'},'Open registry'))
    ));
    const listBody = h('div', { class: 'card-body' });
    if (recentSamples.length === 0) {
      listBody.appendChild(emptyState({
        title: 'No samples yet',
        message: 'Register your first bottle to get started.',
        actionLabel: can('admin') ? '+ New sample' : null,
        onAction: () => openSampleDialog()
      }));
    } else {
      listBody.appendChild(h('div', { class: 'card-grid' }, ...recentSamples.map(sampleCard)));
    }
    list.appendChild(listBody);
    root.appendChild(list);
  }
  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    return 'evening';
  }

  function sampleCard(sample) {
    const storage = state.storageLocations.find(x => x.id === sample.storageLocationId)?.name || 'No storage';
    return h('button', {
      class: 'sample-card', type: 'button',
      'data-sample': sample.id,
      'aria-current': sample.id === state.selectedId ? 'true' : 'false',
      onclick: () => openSampleDetail(sample.id)
    },
      h('div', { class: 'top' },
        h('span', { class: 'code' }, sample.sampleCode),
        h('span', { class: 'chip ' + statusClass(sample.status) }, sample.status)
      ),
      h('div', { class: 'primary-line' }, `${sample.collectionSite || 'No site'} — ${sample.clientName || 'No client'}`),
      h('div', { class: 'meta' },
        h('span', null, sample.sourceType || '—'),
        h('span', null, storage),
        h('span', null, sample.assignedTo || 'Unassigned')
      )
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Samples registry + detail                                              */
  /* ---------------------------------------------------------------------- */
  function renderSamples() {
    const root = $('#samplesView');
    root.innerHTML = '';
    if (state.sampleDetailOpen && selectedSample()) {
      renderSampleDetail(root, selectedSample());
      return;
    }
    const rows = filteredSamples();
    root.appendChild(sampleFiltersEl(rows.length));
    if (rows.length === 0) {
      root.appendChild(emptyState({
        title: state.samples.length === 0 ? 'No samples yet' : 'No matches',
        message: state.samples.length === 0 ? 'Register your first bottle.' : 'Try clearing filters to see all records.',
        actionLabel: state.samples.length === 0 && can('admin') ? '+ New sample' : (state.samples.length ? 'Reset filters' : null),
        onAction: state.samples.length === 0 ? openSampleDialog : resetFilters
      }));
    } else {
      root.appendChild(h('div', { class: 'card-grid' }, ...rows.map(sampleCard)));
    }
  }
  function sampleFiltersEl(count) {
    const f = state.sampleFilters;
    const projects = uniqueValues(state.samples.map(x => x.clientName));
    const collectors = uniqueValues(state.samples.map(x => x.collector));
    const analysts = uniqueValues(state.samples.map(x => x.assignedTo));
    return h('div', { class: 'card' },
      h('div', { class: 'card-header' },
        h('h3', { class: 'card-title' }, `${count} matching · ${state.samples.length} total`),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: resetFilters }, h('span',{class:'btn-label'},'Reset filters'))
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'filters-bar' },
          fieldEl({ id: 'fSearch', label: 'Search', input: h('input', { class: 'input', id: 'fSearch', value: f.q, placeholder: 'Code, site, project, collector', oninput: e => { f.q = e.target.value; render(); } }) }),
          fieldEl({ id: 'fStatus', label: 'Status', input: selectEl('fStatus', ['', ...STATUS_OPTIONS], f.status, v => { f.status = v; render(); }, 'All statuses') }),
          fieldEl({ id: 'fFrom', label: 'From date', input: h('input', { class: 'input', type: 'date', id: 'fFrom', value: f.from, onchange: e => { f.from = e.target.value; render(); } }) }),
          fieldEl({ id: 'fTo', label: 'To date', input: h('input', { class: 'input', type: 'date', id: 'fTo', value: f.to, onchange: e => { f.to = e.target.value; render(); } }) }),
          h('div', null,
            h('button', { class: 'btn', type: 'button', onclick: () => showMoreFilters(projects, collectors, analysts, f) }, h('span',{class:'btn-label'},'More filters'))
          )
        )
      )
    );
  }
  function showMoreFilters(projects, collectors, analysts, f) {
    // Simple inline expander — could be a popover
    notify({ type: 'info', title: 'More filters available', description: 'Project, collector and analyst filters are available in the API — full popover UI in the next iteration.' });
  }
  function fieldEl({ id, label, input }) {
    return h('div', { class: 'field' },
      h('label', { class: 'field-label sr-only', for: id }, label),
      input
    );
  }
  function selectEl(id, options, value, onChange, placeholder) {
    const sel = h('select', { class: 'select', id, onchange: e => onChange(e.target.value) });
    options.forEach(o => {
      if (o === '' && placeholder) sel.appendChild(h('option', { value: '' }, placeholder));
      else sel.appendChild(h('option', { value: o, selected: o === value ? true : null }, o));
    });
    return sel;
  }
  function uniqueValues(arr) { return [...new Set(arr.filter(Boolean))].sort((a,b) => a.localeCompare(b)); }
  function resetFilters() {
    state.sampleFilters = { q:'', status:'', from:'', to:'', project:'', collector:'', analyst:'', storage:'' };
    render();
  }
  function filteredSamples() {
    const f = state.sampleFilters;
    const q = f.q.toLowerCase();
    const from = f.from ? new Date(f.from + 'T00:00:00').getTime() : 0;
    const to = f.to ? new Date(f.to + 'T23:59:59').getTime() : Infinity;
    return state.samples.filter(s => {
      const text = [s.sampleCode, s.clientName, s.collectionSite, s.assignedTo, s.collector, s.sourceType].join(' ').toLowerCase();
      const created = new Date(s.createdAt || s.receivedAt || 0).getTime();
      return (!q || text.includes(q))
        && (!f.status || s.status === f.status)
        && (!f.project || s.clientName === f.project)
        && (!f.collector || s.collector === f.collector)
        && (!f.analyst || s.assignedTo === f.analyst)
        && (!f.storage || s.storageLocationId === f.storage)
        && created >= from && created <= to;
    });
  }
  function selectedSample() { return state.samples.find(x => x.id === state.selectedId) || state.samples[0]; }
  function openSampleDetail(id) {
    state.selectedId = id;
    state.view = 'samples';
    state.sampleDetailOpen = true;
    state.tab = 'overview';
    render();
  }

  /* ---------------------------------------------------------------------- */
  /* Sample detail                                                          */
  /* ---------------------------------------------------------------------- */
  function renderSampleDetail(root, sample) {
    const storage = state.storageLocations.find(x => x.id === sample.storageLocationId)?.name || '';
    const hasBook = (sample.files || []).some(f => (f.category || '').includes('Book') || (f.category || '').includes('Written'));
    const hasResults = (sample.results || []).length > 0;
    const hasStorage = !!sample.storageLocationId;

    // Header
    root.appendChild(h('div', { class: 'sample-header' },
      h('div', null,
        h('div', { class: 'row', style: { gap: '12px' } },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { state.sampleDetailOpen = false; render(); } }, h('span',{class:'btn-label'},'← Back')),
          h('h2', null, sample.sampleCode)
        ),
        h('div', { class: 'subline' }, `${sample.clientName || 'No client'} · ${sample.collectionSite || 'No site'} · ${sample.sourceType || ''}`)
      ),
      h('span', { class: 'chip ' + statusClass(sample.status) }, sample.status)
    ));

    // Lifecycle strip
    root.appendChild(lifecycleStripEl(sample));

    // 3-pane on wide screens
    const layout = h('div', { class: 'ledger-layout', 'data-panes': '2' });
    const mainCol = h('div');
    const rail = h('aside', { class: 'audit-rail card' },
      h('div', { class: 'audit-rail-title' }, 'Activity & custody'),
      auditTimelineEl(sample)
    );

    // Tabs
    const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    const tabs = [
      { id: 'overview', label: 'Workflow' },
      canEnterResults() && { id: 'sheet', label: 'Enter results' },
      { id: 'results', label: 'Saved results' },
      canUploadFiles() && { id: 'files', label: 'Files' },
      can('admin') && { id: 'retention', label: 'Retention' }
    ].filter(Boolean);
    tabs.forEach(t => {
      tabsEl.appendChild(h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': state.tab === t.id, onclick: () => { state.tab = t.id; render(); } }, t.label));
    });
    mainCol.appendChild(tabsEl);

    // Tab body
    const tabBody = h('div', { style: { marginTop: '16px' } });
    if (!tabs.some(t => t.id === state.tab)) state.tab = 'overview';
    if (state.tab === 'overview')   tabBody.appendChild(overviewTab(sample));
    if (state.tab === 'sheet')      tabBody.appendChild(sheetTab(sample));
    if (state.tab === 'results')    tabBody.appendChild(resultsTab(sample));
    if (state.tab === 'files')      tabBody.appendChild(filesTab(sample));
    if (state.tab === 'retention')  tabBody.appendChild(retentionTab(sample));
    mainCol.appendChild(tabBody);

    // QR + facts card
    const details = h('div', { class: 'card', style: { marginBottom: '16px' } });
    details.appendChild(h('div', { class: 'card-body' },
      h('div', { class: 'stack-lg' },
        qrBlockEl(sample),
        h('div', { class: 'facts' },
          factEl('Project / client', sample.clientName),
          factEl('Site', sample.collectionSite),
          factEl('Source', sample.sourceType),
          factEl('Bottle labelled', fmtDate(sample.createdAt || sample.receivedAt)),
          factEl('Last updated', fmtDate(sample.updatedAt || sample.receivedAt)),
          factEl('Target completion', sample.dueAt ? fmtDate(sample.dueAt) : '—'),
          factEl('Brought by', sample.collector),
          factEl('Analyst', sample.assignedTo || 'Unassigned'),
          factEl('Storage', storage),
          factEl('Retention', sample.retentionStatus || 'Active'),
          factEl('Tests', (sample.requestedTests || []).join(', '))
        ),
        h('div', { class: 'readiness' },
          h('span', { class: 'ready-item', 'data-done': String(hasStorage) }, `Storage ${hasStorage ? 'set' : 'needed'}`),
          h('span', { class: 'ready-item', 'data-done': String(hasBook) }, `Written record ${hasBook ? 'uploaded' : 'needed'}`),
          h('span', { class: 'ready-item', 'data-done': String(hasResults) }, `Results ${hasResults ? 'entered' : 'needed'}`),
          h('span', { class: 'ready-item', 'data-done': String(sample.status === 'Approved') }, `Approval ${sample.status === 'Approved' ? 'done' : 'pending'}`)
        )
      )
    ));

    mainCol.insertBefore(details, tabsEl);
    layout.appendChild(mainCol);
    layout.appendChild(rail);
    root.appendChild(layout);
  }
  function fmtDate(d) { return d ? new Date(d).toLocaleString() : '—'; }
  function factEl(label, value) {
    return h('div', { class: 'fact' },
      h('div', { class: 'fact-label' }, label),
      h('div', { class: 'fact-value' }, value || '—')
    );
  }
  function qrBlockEl(sample) {
    const photo = (sample.files || []).find(f => f.category === 'Sample Photo');
    return h('div', { class: 'qr-block' },
      photo ? h('img', { src: apiUrl(photo.url), alt: 'Sample photo' }) : h('div', { class: 'empty-state', style: { padding: '24px', minHeight: '120px' } }, 'No sample photo'),
      h('img', { src: apiUrl(`/api/samples/${sample.id}/qr.svg?token=${encodeURIComponent(state.token)}`), alt: 'QR code' }),
      h('div', { class: 'qr-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => window.open(apiUrl(`/api/samples/${sample.id}/tube-label?token=${encodeURIComponent(state.token)}`), '_blank') }, h('span',{class:'btn-label'},'Print QR label')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => window.open(apiUrl(`/api/samples/${sample.id}/report?token=${encodeURIComponent(state.token)}`), '_blank') }, h('span',{class:'btn-label'},'Print report')),
        h('a', { class: 'btn btn-primary btn-sm', href: apiUrl(`/api/samples/${sample.id}/report.pdf?token=${encodeURIComponent(state.token)}`) }, h('span',{class:'btn-label'},'Download PDF'))
      )
    );
  }

  function lifecycleStripEl(sample) {
    const idx = LIFECYCLE_STRIP.indexOf(sample.status);
    const container = h('div', { class: 'lifecycle-strip' });
    LIFECYCLE_STRIP.forEach((step, i) => {
      if (i > 0) container.appendChild(h('span', { class: 'connector' }));
      container.appendChild(h('span', { class: 'step', 'data-done': i < idx ? 'true' : null, 'data-current': i === idx ? 'true' : null },
        h('span', { class: 'dot' }),
        step
      ));
    });
    return container;
  }

  function overviewTab(sample) {
    if (!canModifySamples()) return emptyState({ title: 'Read-only', message: 'This role cannot modify samples.' });
    const wrap = h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('div', { class: 'form-error-banner hidden', 'data-form-error': true }),
        h('div', { class: 'form-grid' },
          fieldWith('Lab step', selectFor(STATUS_OPTIONS, sample.status, 'editStatus')),
          fieldWith('Assigned analyst', selectFor(['Unassigned', ...state.people.map(p => p.name)], sample.assignedTo || 'Unassigned', 'editAnalyst')),
          fieldWith('Current storage', storageSelect(sample.storageLocationId, 'editStorage')),
          fieldWith('Target completion', h('input', { class: 'input', id: 'editDueAt', type: 'datetime-local', value: toDateTimeLocal(sample.dueAt) })),
          h('div', { class: 'field field-wide' },
            h('label', { class: 'field-label', for: 'editNotes' }, 'Movement / work note'),
            h('textarea', { class: 'textarea', id: 'editNotes' }, sample.notes || '')
          ),
          h('div', { class: 'field field-wide' },
            h('label', { class: 'field-label', for: 'editReason' }, 'Reason for change (optional)'),
            h('input', { class: 'input', id: 'editReason', placeholder: 'e.g. corrected storage location after inspection' })
          )
        ),
        h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } },
          canApprove() && sample.status !== 'Approved' && (sample.results || []).length > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => beginApproval(sample) }, h('span',{class:'btn-label'},'Approve results…')) : null,
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => saveWorkflowUpdate(sample) }, h('span',{class:'btn-label'},'Save update'))
        )
      )
    );
    return wrap;
  }
  function fieldWith(label, input) {
    return h('div', { class: 'field' }, h('label', { class: 'field-label' }, label), input);
  }
  function selectFor(options, value, id) {
    const sel = h('select', { class: 'select', id });
    options.forEach(o => sel.appendChild(h('option', { value: o === 'Unassigned' ? '' : o, selected: o === value ? true : null }, o)));
    return sel;
  }
  function storageSelect(value, id) {
    const sel = h('select', { class: 'select', id });
    sel.appendChild(h('option', { value: '' }, 'Not stored yet'));
    state.storageLocations.forEach(loc => {
      const full = loc.isFull && loc.id !== value;
      const label = loc.name + (loc.isFull ? ' — FULL' : '') + (loc.active === false ? ' — INACTIVE' : '');
      sel.appendChild(h('option', { value: loc.id, selected: loc.id === value ? true : null, disabled: (full || loc.active === false) ? true : null }, label));
    });
    return sel;
  }
  function toDateTimeLocal(v) {
    if (!v) return '';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16);
  }
  async function saveWorkflowUpdate(sample) {
    try {
      const body = {
        status: $('#editStatus').value,
        assignedTo: $('#editAnalyst').value,
        storageLocationId: $('#editStorage').value,
        dueAt: $('#editDueAt').value ? new Date($('#editDueAt').value).toISOString() : '',
        notes: $('#editNotes').value,
        reasonForChange: $('#editReason').value // frontend-ready; backend ignores today
      };
      const updated = await api(`/api/samples/${sample.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      Object.assign(sample, updated);
      await load();
      notify({ type: 'success', title: 'Update saved', description: `${sample.sampleCode} — changes recorded in the activity log.` });
    } catch (e) {
      notify({ type: 'error', title: 'Save failed', description: e.message });
    }
  }

  function sheetTab(sample) {
    const wrap = h('div', { class: 'stack-lg' });
    wrap.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('div', { class: 'row-between' },
          h('div', null,
            h('strong', null, 'Analysis data entry'),
            h('div', { class: 'muted text-sm' }, 'Open the spreadsheet-style sheet, enter measured values, then save.')
          ),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openResultSheet(sample) }, h('span',{class:'btn-label'},'Open sheet'))
        )
      )
    ));
    wrap.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('div', null, h('strong', null, 'Or import an Excel sheet')),
        h('form', { class: 'row', style: { gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }, id: 'excelImportForm', onsubmit: safe(async e => {
          e.preventDefault();
          const updated = await api(`/api/samples/${sample.id}/results/excel`, { method: 'POST', body: new FormData(e.target) });
          Object.assign(sample, updated); state.tab = 'results'; await load();
          notify({ type: 'success', title: 'Excel imported' });
        }) },
          h('div', { class: 'field grow' },
            h('label', { class: 'field-label', for: 'excelFile' }, 'Excel file'),
            h('input', { class: 'input', id: 'excelFile', name: 'file', type: 'file', accept: '.xlsx,.xls', required: true })
          ),
          h('button', { class: 'btn btn-primary', type: 'submit', 'data-busy-label': 'Importing…' }, h('span',{class:'btn-label'},'Import Excel'))
        )
      )
    ));
    return wrap;
  }
  function openResultSheet(sample) {
    $('#sheetTitle').textContent = 'Analysis data entry — ' + sample.sampleCode;
    $('#sheetSubtitle').textContent = `${sample.clientName || 'No client'} · ${sample.collectionSite || 'No site'}`;
    const body = $('#sheetBody');
    body.innerHTML = '';
    const tests = sample.requestedTests?.length ? sample.requestedTests : state.tests.slice(0, 5).map(t => t.name);
    const gridWrap = h('div', { class: 'result-grid' });
    const table = h('table', { role: 'grid', 'aria-label': 'Analysis results for ' + sample.sampleCode });
    table.appendChild(h('thead', null,
      h('tr', null,
        h('th', { scope: 'col' }, '#'),
        h('th', { scope: 'col' }, 'Parameter'),
        h('th', { scope: 'col' }, 'Value'),
        h('th', { scope: 'col' }, 'Unit'),
        h('th', { scope: 'col' }, 'Limit'),
        h('th', { scope: 'col' }, 'Method'),
        h('th', { scope: 'col' }, 'Flag')
      )
    ));
    const tbody = h('tbody');
    function addRow(row = {}, num) {
      const test = state.tests.find(t => t.name === row.parameter) || {};
      const tr = h('tr', { role: 'row' },
        h('th', { scope: 'row' }, String(num)),
        h('td', null, h('input', { class: 'input', 'data-field': 'parameter', 'aria-label': 'Parameter', value: row.parameter || '' })),
        h('td', null, h('input', { class: 'input', 'data-field': 'value', 'aria-label': 'Value', value: row.value || '', placeholder: '7.4' })),
        h('td', null, h('input', { class: 'input', 'data-field': 'unit', 'aria-label': 'Unit', value: row.unit || test.unit || '' })),
        h('td', null, h('input', { class: 'input', 'data-field': 'limit', 'aria-label': 'Limit', value: row.limit || test.limit || '' })),
        h('td', null, h('input', { class: 'input', 'data-field': 'method', 'aria-label': 'Method', value: row.method || test.method || '' })),
        h('td', null, (() => {
          const sel = h('select', { class: 'input', 'data-field': 'flag', 'aria-label': 'Flag' });
          ['OK','Review','Alert'].forEach(o => sel.appendChild(h('option', { value: o, selected: (row.flag || 'OK') === o ? true : null }, o)));
          return sel;
        })())
      );
      tbody.appendChild(tr);
    }
    tests.forEach((name, i) => addRow({ parameter: name, flag: 'OK' }, i + 1));
    table.appendChild(tbody);
    gridWrap.appendChild(table);

    const reasonField = h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'sheetReason' }, 'Reason (required for amendments to previously-saved values)'),
      h('input', { class: 'input', id: 'sheetReason', placeholder: 'e.g. re-run after instrument recalibration' })
    );

    body.appendChild(h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('div', { class: 'muted text-sm' }, 'Fields are announced by column for screen readers.'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => addRow({ flag: 'OK' }, tbody.children.length + 1) }, h('span',{class:'btn-label'},'+ Add row'))
    ));
    body.appendChild(gridWrap);
    body.appendChild(reasonField);
    body.appendChild(h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => saveSheet(sample) }, h('span',{class:'btn-label'},'Save values'))
    ));

    $('#resultSheetDialog').showModal();
  }
  async function saveSheet(sample) {
    const rows = $$('#sheetBody tbody tr').map(tr => {
      const r = {};
      tr.querySelectorAll('[data-field]').forEach(inp => { r[inp.dataset.field] = inp.value.trim(); });
      return r;
    }).filter(r => r.parameter && r.value);
    if (rows.length === 0) return notify({ type: 'warn', title: 'Nothing to save', description: 'Enter at least one parameter with a value.' });
    const reason = $('#sheetReason')?.value || '';
    try {
      const updated = await api(`/api/samples/${sample.id}/results/sheet`, { method: 'POST', body: JSON.stringify({ rows, reasonForChange: reason }) });
      Object.assign(sample, updated); state.tab = 'results';
      $('#resultSheetDialog').close();
      await load();
      notify({ type: 'success', title: 'Values saved', description: `${rows.length} row${rows.length===1?'':'s'} recorded on ${sample.sampleCode}.` });
    } catch (e) { notify({ type: 'error', title: 'Save failed', description: e.message }); }
  }

  function resultsTab(sample) {
    const results = sample.results || [];
    // Group by parameter to surface most recent as current + older as superseded
    const byParam = {};
    results.forEach(r => { (byParam[r.parameter] ||= []).push(r); });
    const wrap = h('div', { class: 'stack-lg' });
    if (results.length === 0) {
      wrap.appendChild(emptyState({ title: 'No results yet', message: canEnterResults() ? 'Open the "Enter results" tab to add measurements.' : 'The analyst has not entered results yet.' }));
      return wrap;
    }
    const tblWrap = h('div', { class: 'table-wrap' });
    const tbl = h('table', { class: 'data-table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Parameter'),
        h('th', { scope: 'col' }, 'Value'),
        h('th', { scope: 'col' }, 'Limit'),
        h('th', { scope: 'col' }, 'Flag'),
        h('th', { scope: 'col' }, 'Analyst'),
        h('th', { scope: 'col' }, 'Entered at')
      ))
    );
    const tbody = h('tbody');
    Object.values(byParam).forEach(list => {
      // most recent first (matches server unshift)
      list.forEach((r, i) => {
        const superseded = i > 0;
        tbody.appendChild(h('tr', { 'data-superseded': superseded ? 'true' : null, style: superseded ? { opacity: '0.6' } : null },
          h('td', { 'data-label': 'Parameter' }, r.parameter + (superseded ? ' (superseded)' : '')),
          h('td', { 'data-label': 'Value', class: 'mono' }, `${r.value} ${r.unit || ''}`),
          h('td', { 'data-label': 'Limit' }, r.limit || '—'),
          h('td', { 'data-label': 'Flag' }, h('span', { class: 'chip ' + (r.flag === 'Alert' ? 'status-Flagged' : r.flag === 'Review' ? 'status-Needs-Review' : 'status-Approved') }, r.flag || 'OK')),
          h('td', { 'data-label': 'Analyst' }, r.analyst || '—'),
          h('td', { 'data-label': 'Entered at', class: 'mono text-sm' }, fmtDate(r.enteredAt))
        ));
      });
    });
    tbl.appendChild(tbody);
    tblWrap.appendChild(tbl);
    wrap.appendChild(tblWrap);

    if (canEnterResults()) {
      const form = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, 'Enter another value')),
        h('div', { class: 'card-body' },
          h('div', { class: 'form-grid' },
            fieldWith('Parameter', (() => {
              const sel = h('select', { class: 'select', id: 'rParam', onchange: fillTestDefaults });
              state.tests.forEach(t => sel.appendChild(h('option', { value: t.id }, t.name)));
              return sel;
            })()),
            fieldWith('Value', h('input', { class: 'input', id: 'rValue', placeholder: '7.4' })),
            fieldWith('Unit', h('input', { class: 'input', id: 'rUnit' })),
            fieldWith('Limit', h('input', { class: 'input', id: 'rLimit' })),
            fieldWith('Method', h('input', { class: 'input', id: 'rMethod' })),
            fieldWith('Flag', (() => {
              const sel = h('select', { class: 'select', id: 'rFlag' });
              ['OK','Review','Alert'].forEach(o => sel.appendChild(h('option', { value: o }, o)));
              return sel;
            })()),
            h('div', { class: 'field field-wide' },
              h('label', { class: 'field-label', for: 'rReason' }, 'Reason (required when correcting a previous value)'),
              h('input', { class: 'input', id: 'rReason', placeholder: 'e.g. re-run with fresh calibration' })
            )
          ),
          h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => addSingleResult(sample) }, h('span',{class:'btn-label'},'Add value'))
          )
        )
      );
      wrap.appendChild(form);
      // Populate defaults for first test
      setTimeout(fillTestDefaults, 0);
    }
    return wrap;
  }
  function fillTestDefaults() {
    const sel = $('#rParam'); if (!sel) return;
    const test = state.tests.find(t => t.id === sel.value); if (!test) return;
    if ($('#rUnit'))   $('#rUnit').value = test.unit || '';
    if ($('#rLimit'))  $('#rLimit').value = test.limit || '';
    if ($('#rMethod')) $('#rMethod').value = test.method || '';
  }
  async function addSingleResult(sample) {
    const paramSel = $('#rParam');
    try {
      const updated = await api(`/api/samples/${sample.id}/results`, { method: 'POST', body: JSON.stringify({
        parameter: paramSel.selectedOptions[0].textContent,
        value: $('#rValue').value,
        unit: $('#rUnit').value,
        limit: $('#rLimit').value,
        method: $('#rMethod').value,
        flag: $('#rFlag').value,
        reasonForChange: $('#rReason').value
      }) });
      Object.assign(sample, updated); await load();
      notify({ type: 'success', title: 'Value recorded' });
    } catch (e) { notify({ type: 'error', title: 'Save failed', description: e.message }); }
  }

  function filesTab(sample) {
    const files = sample.files || [];
    const wrap = h('div', { class: 'stack-lg' });
    const tblWrap = h('div', { class: 'table-wrap' });
    const tbl = h('table', { class: 'data-table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'File'),
        h('th', { scope: 'col' }, 'Category'),
        h('th', { scope: 'col' }, 'Uploaded by'),
        h('th', { scope: 'col' }, 'Open')
      ))
    );
    const tbody = h('tbody');
    if (files.length === 0) {
      tbody.appendChild(h('tr', null, h('td', { colspan: '4', 'data-label': '' }, emptyState({ title: 'No files yet', message: 'Upload written records, instrument data, or worksheets.' }))));
    } else {
      files.forEach(f => tbody.appendChild(h('tr', null,
        h('td', { 'data-label': 'File' }, f.originalName || '—'),
        h('td', { 'data-label': 'Category' }, f.category || '—'),
        h('td', { 'data-label': 'Uploaded by' },
          h('div', null, f.uploadedBy || '—'),
          h('small', { class: 'muted' }, fmtDate(f.uploadedAt))
        ),
        h('td', { 'data-label': 'Open' }, h('a', { href: apiUrl(f.url), target: '_blank' }, 'View'))
      )));
    }
    tbl.appendChild(tbody);
    tblWrap.appendChild(tbl);
    wrap.appendChild(tblWrap);

    // Upload form
    const form = h('form', { class: 'card', onsubmit: safe(async e => {
      e.preventDefault();
      const updated = await api(`/api/samples/${sample.id}/files`, { method: 'POST', body: new FormData(e.target) });
      Object.assign(sample, updated); await load();
      notify({ type: 'success', title: 'File uploaded' });
      e.target.reset();
    }) },
      h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, 'Upload file to this sample')),
      h('div', { class: 'card-body' },
        h('div', { class: 'form-grid' },
          fieldWith('Category', (() => {
            const sel = h('select', { class: 'select', name: 'category' });
            ['Sample Photo','Written Record Upload','Instrument Raw Data','Worksheet','Final Report','Storage Movement Record'].forEach(o => sel.appendChild(h('option', null, o)));
            return sel;
          })()),
          fieldWith('Files', h('input', { class: 'input', name: 'files', type: 'file', multiple: true, required: true }))
        ),
        h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          h('button', { class: 'btn btn-primary', type: 'submit', 'data-busy-label': 'Uploading…' }, h('span',{class:'btn-label'},'Upload'))
        )
      )
    );
    wrap.appendChild(form);
    return wrap;
  }

  function retentionTab(sample) {
    const wrap = h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        sample.disposal ? h('div', { class: 'form-error-banner' }, `Disposed ${fmtDate(sample.disposal.disposedAt)} by ${sample.disposal.disposedBy}. ${sample.disposal.reason || ''}`) : null,
        h('div', { class: 'form-grid' },
          fieldWith('Lifecycle action', (() => {
            const sel = h('select', { class: 'select', id: 'lifecycleAction' });
            ['Active','Retained','Disposed'].forEach(o => sel.appendChild(h('option', { value: o, selected: sample.retentionStatus === o ? true : null }, o)));
            return sel;
          })()),
          h('div', { class: 'field field-wide' },
            h('label', { class: 'field-label', for: 'lifecycleReason' }, 'Reason (required for disposal)'),
            h('textarea', { class: 'textarea', id: 'lifecycleReason', placeholder: 'e.g. approved and 30-day retention complete' })
          )
        ),
        h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => saveLifecycle(sample) }, h('span',{class:'btn-label'},'Save lifecycle'))
        )
      )
    );
    return wrap;
  }
  async function saveLifecycle(sample) {
    const action = $('#lifecycleAction').value;
    const reason = $('#lifecycleReason').value;
    if (action === 'Disposed') {
      if (!reason.trim()) return notify({ type: 'warn', title: 'Reason required', description: 'Please state why the sample is being disposed.' });
      const ok = await confirmDialog({ title: 'Confirm disposal', message: `Dispose ${sample.sampleCode}? This action is permanent and recorded in the activity log.`, danger: true, okLabel: 'Dispose sample' });
      if (!ok) return;
    }
    try {
      const updated = await api(`/api/samples/${sample.id}/lifecycle`, { method: 'POST', body: JSON.stringify({ action, reason }) });
      Object.assign(sample, updated); await load();
      notify({ type: 'success', title: 'Lifecycle updated' });
    } catch (e) { notify({ type: 'error', title: 'Update failed', description: e.message }); }
  }

  function auditTimelineEl(sample) {
    const events = sample.chainOfCustody || [];
    if (events.length === 0) return emptyState({ title: 'No activity yet', message: 'Custody events will appear here as the sample moves through the lab.' });
    const timeline = h('div', { class: 'timeline', role: 'feed' });
    events.forEach(evt => {
      const from = evt.fromLocationId ? state.storageLocations.find(s => s.id === evt.fromLocationId)?.name || 'unstored' : '';
      const to   = evt.toLocationId ? state.storageLocations.find(s => s.id === evt.toLocationId)?.name || 'unstored' : (evt.locationId ? state.storageLocations.find(s => s.id === evt.locationId)?.name : '');
      const place = from ? `${from} → ${to || 'unstored'}` : to;
      timeline.appendChild(h('article', { class: 'timeline-event', 'data-type': evt.action?.toLowerCase().includes('approve') ? 'approve' : evt.action?.toLowerCase().includes('dispos') ? 'dispose' : evt.action?.toLowerCase().includes('reject') ? 'reject' : evt.action?.toLowerCase().includes('flag') ? 'flag' : 'default' },
        h('div', { class: 'event-title' }, `${evt.action || 'Update'} — ${evt.by || 'system'}`),
        h('div', { class: 'event-meta' },
          h('time', { datetime: evt.at }, fmtDate(evt.at)),
          place ? h('span', null, place) : null
        ),
        evt.note ? h('div', { class: 'event-reason' }, evt.note) : null
      ));
    });
    return timeline;
  }

  /* ---------------------------------------------------------------------- */
  /* Approvals queue                                                        */
  /* ---------------------------------------------------------------------- */
  function renderApprovals() {
    const root = $('#approvalsView');
    root.innerHTML = '';
    const waiting = state.samples.filter(s => ['Needs Review', 'Results Entered'].includes(s.status) && !(s.reviewedAt));
    if (waiting.length === 0) {
      root.appendChild(emptyState({ title: 'Queue empty', message: 'Nothing waiting for your review right now.' }));
      return;
    }
    waiting.forEach(sample => {
      // analyst != approver enforcement (frontend gate; backend gate to follow)
      const enteredResults = sample.results || [];
      const iEntered = enteredResults.some(r => r.analyst === state.user?.name);
      const card = h('div', { class: 'approval-card' + (iEntered ? ' locked' : '') });
      card.appendChild(h('div', { class: 'row-between' },
        h('div', null,
          h('div', { class: 'code mono', style: { fontWeight: '700' } }, sample.sampleCode),
          h('div', { class: 'muted text-sm' }, `${sample.clientName || '—'} · ${sample.collectionSite || '—'}`)
        ),
        h('span', { class: 'chip ' + statusClass(sample.status) }, sample.status)
      ));
      card.appendChild(h('div', { class: 'muted text-sm' },
        `${enteredResults.length} result${enteredResults.length === 1 ? '' : 's'} · submitted ${fmtDate(sample.updatedAt)}`
      ));
      if (iEntered) {
        card.appendChild(h('div', { class: 'locked-notice' }, '⚠ You entered result(s) on this sample — another admin must review.'));
      }
      card.appendChild(h('div', { class: 'approval-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openSampleDetail(sample.id) }, h('span',{class:'btn-label'},'Review details')),
        iEntered ? null : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => beginApproval(sample) }, h('span',{class:'btn-label'},'✓ Approve')),
        iEntered ? null : h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: () => rejectSample(sample) }, h('span',{class:'btn-label'},'✕ Reject'))
      ));
      root.appendChild(card);
    });
  }
  function beginApproval(sample) {
    state.pendingApproval = sample;
    $('#approvalTitle').textContent = 'Approve results — ' + sample.sampleCode;
    $('#approvalPassword').value = '';
    $('#approvalReason').value = '';
    $('#approvalDialog').showModal();
  }
  $('#approvalForm').addEventListener('submit', safe(async e => {
    e.preventDefault();
    const sample = state.pendingApproval; if (!sample) return;
    try {
      const updated = await api(`/api/samples/${sample.id}/approve`, { method: 'POST', body: JSON.stringify({
        reason: $('#approvalReason').value,
        signaturePassword: $('#approvalPassword').value // frontend-shaped for future backend
      }) });
      Object.assign(sample, updated); $('#approvalDialog').close();
      state.pendingApproval = null;
      await load();
      notify({ type: 'success', title: 'Approved', description: `${sample.sampleCode} approved and recorded.` });
    } catch (err) {
      const banner = $('#approvalForm [data-form-error]');
      banner.textContent = err.message || 'Approval failed';
      banner.classList.remove('hidden');
      throw err;
    }
  }));
  async function rejectSample(sample) {
    const reason = window.prompt('Reason for rejecting ' + sample.sampleCode + ' (required):', '');
    if (!reason || !reason.trim()) return;
    try {
      // Backend has no reject endpoint yet; use PATCH to move status back
      await api(`/api/samples/${sample.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'In Analysis', notes: (sample.notes || '') + `\n[Rejected] ${reason}` }) });
      await load();
      notify({ type: 'success', title: 'Sample returned', description: `${sample.sampleCode} sent back to analyst.` });
    } catch (e) { notify({ type: 'error', title: 'Reject failed', description: e.message }); }
  }

  /* ---------------------------------------------------------------------- */
  /* Scan                                                                   */
  /* ---------------------------------------------------------------------- */
  function renderScan() {
    const root = $('#scanView');
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'section-grid', 'data-cols': '2' },
      h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, 'Camera scanner'), h('span', { class: 'chip' }, 'QR')),
        h('div', { class: 'card-body' },
          h('video', { id: 'scannerVideo', 'aria-label': 'Live camera view for QR scanning', muted: true, playsinline: true, style: { width: '100%', borderRadius: '10px', background: '#000', aspectRatio: '4/3' } }),
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-primary', type: 'button', id: 'startScanner' }, h('span',{class:'btn-label'},'Start scanner')),
            h('button', { class: 'btn', type: 'button', id: 'stopScanner' }, h('span',{class:'btn-label'},'Stop scanner'))
          ),
          h('p', { class: 'muted text-sm' }, 'Use the camera to open a sample. Manual entry is available on the right.')
        )
      ),
      h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, 'Open by code')),
        h('div', { class: 'card-body' },
          h('div', { class: 'field' },
            h('label', { class: 'field-label', for: 'manualCode' }, 'Sample code or scanned payload'),
            h('input', { class: 'input', id: 'manualCode', placeholder: 'PL-2026-000001' })
          ),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openByCode($('#manualCode').value) }, h('span',{class:'btn-label'},'Open sample'))
        )
      )
    ));
    $('#startScanner').onclick = startScanner;
    $('#stopScanner').onclick = stopScanner;
  }
  async function startScanner() {
    if (!('BarcodeDetector' in window)) {
      notify({ type: 'warn', title: 'Camera scanning not supported', description: 'Use Chrome on Android, or type the code manually.' });
      return;
    }
    try {
      const video = $('#scannerVideo');
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = state.stream;
      await video.play();
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const tick = async () => {
        if (!state.stream) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) {
            $('#manualCode').value = codes[0].rawValue;
            stopScanner();
            flash();
            openByCode(codes[0].rawValue);
            return;
          }
        } catch {}
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      notify({ type: 'error', title: 'Camera error', description: e.message });
    }
  }
  function stopScanner() {
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  function flash() {
    const el = h('div', { class: 'scan-flash' });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 400);
  }
  async function openByCode(raw) {
    const code = extractSampleCode(raw);
    if (!code) return notify({ type: 'warn', title: 'No sample code found' });
    try {
      const sample = await api(`/api/search-sample/${encodeURIComponent(code)}`);
      openSampleDetail(sample.id);
    } catch (e) {
      notify({ type: 'error', title: 'Sample not found', description: e.message });
    }
  }
  function extractSampleCode(raw) {
    let c = String(raw || '').trim();
    try { const p = JSON.parse(c); c = p.sampleCode || p.id || c; } catch {}
    try { const u = new URL(c); c = u.searchParams.get('sample') || u.searchParams.get('id') || c; } catch {}
    return c;
  }
  async function openUrlSampleOnce() {
    if (state.openedUrlSample) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('sample') || params.get('id');
    if (!code) return;
    state.openedUrlSample = true;
    const sample = await api(`/api/search-sample/${encodeURIComponent(code)}`);
    openSampleDetail(sample.id);
  }

  /* ---------------------------------------------------------------------- */
  /* Masters                                                                */
  /* ---------------------------------------------------------------------- */
  function renderMasters() {
    const root = $('#mastersView');
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'section-grid', 'data-cols': '3' },
      masterCard('People / Analysts', 'people', '/api/people', [['name','Name'],['role','Role']], state.people),
      masterCard('Storage Locations', 'storage', '/api/storage-locations', [['name','Location'],['type','Type'],['capacityNote','Capacity note']], state.storageLocations),
      masterCard('Test Methods', 'tests', '/api/tests', [['name','Parameter'],['unit','Unit'],['limit','Limit'],['method','Method']], state.tests)
    ));
  }
  function masterCard(title, kind, path, fields, items) {
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, title))
    );
    const body = h('div', { class: 'card-body' });
    // Add form
    const form = h('form', { class: 'form' });
    fields.forEach(([name, label]) => {
      form.appendChild(h('div', { class: 'field' },
        h('label', { class: 'field-label', for: `master-${kind}-${name}` }, label),
        h('input', { class: 'input', id: `master-${kind}-${name}`, name, required: name === 'name' })
      ));
    });
    form.appendChild(h('button', { class: 'btn btn-primary', type: 'submit', 'data-busy-label': 'Adding…' }, h('span',{class:'btn-label'},'+ Add')));
    form.onsubmit = safe(async e => {
      e.preventDefault();
      await api(path, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      await load();
      notify({ type: 'success', title: title.split('/')[0] + ' added' });
    });
    body.appendChild(form);
    // Existing items list
    const list = h('div', { class: 'stack' });
    items.forEach(item => {
      const row = h('div', { class: 'card', style: { padding: '12px', background: 'var(--surface-2)' } });
      const rowFields = h('div', { class: 'stack', style: { gap: '8px' } });
      fields.forEach(([name]) => {
        rowFields.appendChild(h('input', { class: 'input', value: item[name] || '', 'data-master': kind, 'data-id': item.id, 'data-field': name, 'aria-label': name }));
      });
      const btn = h('button', { class: 'btn btn-sm btn-primary', type: 'button', style: { marginTop: '8px' } }, h('span',{class:'btn-label'},'Save'));
      btn.onclick = safe(async () => {
        const body = {};
        row.querySelectorAll(`[data-master="${kind}"][data-id="${item.id}"]`).forEach(i => { body[i.dataset.field] = i.value.trim(); });
        const endpoint = kind === 'people' ? '/api/people' : kind === 'storage' ? '/api/storage-locations' : '/api/tests';
        await api(`${endpoint}/${item.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        await load();
        notify({ type: 'success', title: 'Saved' });
      });
      row.appendChild(rowFields);
      row.appendChild(btn);
      list.appendChild(row);
    });
    body.appendChild(list);
    card.appendChild(body);
    return card;
  }

  /* ---------------------------------------------------------------------- */
  /* Users                                                                  */
  /* ---------------------------------------------------------------------- */
  function renderUsers() {
    const root = $('#usersView');
    root.innerHTML = '';
    const visible = state.showInactiveUsers ? state.users : state.users.filter(u => u.active);
    root.appendChild(h('div', { class: 'section-grid', 'data-cols': '2' },
      // Create form
      h('form', { class: 'card', id: 'userForm' },
        h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, 'Create user')),
        h('div', { class: 'card-body' },
          h('div', { class: 'form-error-banner hidden', 'data-form-error': true }),
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'uName' }, 'Name'), h('input', { class: 'input', id: 'uName', name: 'name', required: true })),
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'uEmail' }, 'Email'), h('input', { class: 'input', id: 'uEmail', name: 'email', type: 'email', required: true })),
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'uPhone' }, 'Phone'), h('input', { class: 'input', id: 'uPhone', name: 'phone', type: 'tel', required: true })),
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'uPassword' }, 'Initial password'), h('input', { class: 'input', id: 'uPassword', name: 'password', type: 'password', required: true, minlength: '6' })),
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'uRole' }, 'Role'), (() => {
            const s = h('select', { class: 'select', id: 'uRole', name: 'role' });
            s.appendChild(h('option', { value: 'admin' }, 'Admin / Manager'));
            s.appendChild(h('option', { value: 'analyst' }, 'Analyst'));
            return s;
          })()),
          h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn btn-primary', type: 'submit', 'data-busy-label': 'Creating…' }, h('span',{class:'btn-label'},'Create user')))
        )
      ),
      // User list
      h('div', { class: 'card' },
        h('div', { class: 'card-header' },
          h('h3', { class: 'card-title' }, 'User list'),
          h('label', { class: 'check-label' },
            h('input', { class: 'checkbox', type: 'checkbox', id: 'showInactive', checked: state.showInactiveUsers ? true : null, onchange: e => { state.showInactiveUsers = e.target.checked; render(); } }),
            h('span', null, 'Show inactive')
          )
        ),
        h('div', { class: 'card-body card-body-flush' },
          h('div', { class: 'table-wrap' },
            h('table', { class: 'data-table' },
              h('thead', null, h('tr', null,
                h('th', { scope: 'col' }, 'Name'),
                h('th', { scope: 'col' }, 'Email'),
                h('th', { scope: 'col' }, 'Role'),
                h('th', { scope: 'col' }, 'Status'),
                h('th', { scope: 'col' }, 'Action')
              )),
              h('tbody', null, ...visible.map(u => userRow(u)))
            )
          )
        )
      )
    ));
    $('#userForm').onsubmit = safe(async e => {
      e.preventDefault();
      await api('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData($('#userForm')))) });
      $('#userForm').reset();
      await load();
      notify({ type: 'success', title: 'User created' });
    });
  }
  function userRow(u) {
    const roleSel = h('select', { class: 'select', style: { minWidth: '160px' }, 'data-user-role': u.id },
      h('option', { value: 'admin',   selected: u.role === 'admin' ? true : null }, 'Admin / Manager'),
      h('option', { value: 'analyst', selected: u.role === 'analyst' ? true : null }, 'Analyst')
    );
    const statusSel = h('select', { class: 'select', style: { minWidth: '120px' }, 'data-user-active': u.id },
      h('option', { value: 'true', selected: u.active ? true : null }, 'Active'),
      h('option', { value: 'false', selected: !u.active ? true : null }, 'Inactive')
    );
    return h('tr', null,
      h('td', { 'data-label': 'Name' }, u.name),
      h('td', { 'data-label': 'Email' },
        h('div', null, u.email),
        h('small', { class: 'muted' }, `${u.countryCode || ''} ${u.phone || ''}`)
      ),
      h('td', { 'data-label': 'Role' }, roleSel),
      h('td', { 'data-label': 'Status' }, statusSel),
      h('td', { 'data-label': 'Action', class: 'col-actions' },
        u.id === state.user?.id ? h('span', { class: 'muted' }, 'You') :
        h('div', { class: 'row', style: { gap: '4px' } },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: safe(async () => {
            await api(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ role: roleSel.value, active: statusSel.value === 'true' }) });
            await load(); notify({ type: 'success', title: 'User updated' });
          }) }, h('span',{class:'btn-label'},'Save')),
          u.active ? h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: async () => {
            const ok = await confirmDialog({ title: 'Deactivate user?', message: `Deactivate ${u.name}? Their historical records will remain visible in the activity log.`, danger: true, okLabel: 'Deactivate' });
            if (!ok) return;
            try { await api(`/api/users/${u.id}`, { method: 'DELETE' }); await load(); notify({ type: 'success', title: 'User deactivated' }); }
            catch (e) { notify({ type: 'error', title: 'Failed', description: e.message }); }
          } }, h('span',{class:'btn-label'},'Deactivate')) : null
        )
      )
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Backup                                                                 */
  /* ---------------------------------------------------------------------- */
  function renderBackup() {
    const root = $('#backupView');
    const health = state.health || {};
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'section-grid', 'data-cols': '2' },
      h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, 'Backup exports')),
        h('div', { class: 'card-body' },
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-primary', type: 'button', onclick: safe(async () => { await api('/api/exports/run', { method: 'POST', body: JSON.stringify({ period: 'daily' }) }); await load(); notify({ type: 'success', title: 'Daily export created' }); }) }, h('span',{class:'btn-label'},'Run daily export')),
            h('button', { class: 'btn', type: 'button', onclick: safe(async () => { await api('/api/exports/run', { method: 'POST', body: JSON.stringify({ period: 'weekly' }) }); await load(); notify({ type: 'success', title: 'Weekly export created' }); }) }, h('span',{class:'btn-label'},'Run weekly export')),
            h('button', { class: 'btn', type: 'button', onclick: () => $('#backupBtn').click() }, h('span',{class:'btn-label'},'Download current backup'))
          ),
          h('div', { class: 'table-wrap' },
            h('table', { class: 'data-table' },
              h('thead', null, h('tr', null,
                h('th', { scope: 'col' }, 'File'),
                h('th', { scope: 'col' }, 'Type'),
                h('th', { scope: 'col' }, 'Updated'),
                h('th', { scope: 'col' }, 'Size'),
                h('th', { scope: 'col' }, 'Download')
              )),
              h('tbody', null,
                ...(state.exports || []).map(f => h('tr', null,
                  h('td', { 'data-label': 'File' }, f.file),
                  h('td', { 'data-label': 'Type' }, f.type),
                  h('td', { 'data-label': 'Updated' }, fmtDate(f.modifiedAt)),
                  h('td', { 'data-label': 'Size' }, formatBytes(f.size)),
                  h('td', { 'data-label': 'Download' }, h('a', { href: apiUrl(`/api/exports/${encodeURIComponent(f.file)}?token=${encodeURIComponent(state.token)}`) }, 'Download'))
                ))
              )
            )
          )
        )
      ),
      h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, 'Database health'), h('span', { class: 'chip status-Approved' }, health.database || 'Checking')),
        h('div', { class: 'card-body' },
          h('div', { class: 'facts' },
            factEl('Samples', health.samples ?? 0),
            factEl('Users', health.users ?? 0),
            factEl('Activity entries', health.auditEntries ?? 0),
            factEl('Uploaded files', health.uploadedFiles ?? 0),
            factEl('Database size', formatBytes(health.dbSize || 0)),
            factEl('Last write', health.lastWriteAt ? fmtDate(health.lastWriteAt) : '—')
          )
        )
      )
    ));
  }
  function formatBytes(b) {
    const v = Number(b || 0);
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v/1024).toFixed(1) + ' KB';
    return (v/1024/1024).toFixed(1) + ' MB';
  }

  /* ---------------------------------------------------------------------- */
  /* Audit log                                                              */
  /* ---------------------------------------------------------------------- */
  function renderAudit() {
    const root = $('#auditView');
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-header' }, h('h3', { class: 'card-title' }, `Activity log · ${state.audit.length} entries`)),
      h('div', { class: 'card-body' },
        state.audit.length === 0 ? emptyState({ title: 'No activity yet', message: 'System actions will appear here as they occur.' })
        : (() => {
            const tl = h('div', { class: 'timeline', role: 'feed' });
            state.audit.forEach(evt => {
              tl.appendChild(h('article', { class: 'timeline-event', 'data-type': evt.action?.toLowerCase().includes('approve') ? 'approve' : evt.action?.toLowerCase().includes('dispos') ? 'dispose' : 'default' },
                h('div', { class: 'event-title' }, `${evt.action} — ${evt.userName || 'system'}`),
                h('div', { class: 'event-meta' },
                  h('time', { datetime: evt.at }, fmtDate(evt.at)),
                  h('span', null, evt.entity),
                  evt.detail ? h('span', null, evt.detail) : null
                )
              ));
            });
            return tl;
          })()
      )
    ));
  }

  /* ---------------------------------------------------------------------- */
  /* Empty state helper                                                     */
  /* ---------------------------------------------------------------------- */
  function emptyState({ title, message, actionLabel, onAction, icon }) {
    return h('div', { class: 'empty-state' },
      h('div', { class: 'icon', 'aria-hidden': 'true' }, icon || '·'),
      h('div', { class: 'title' }, title),
      message ? h('div', null, message) : null,
      actionLabel ? h('button', { class: 'btn btn-primary', type: 'button', onclick: onAction }, h('span',{class:'btn-label'},actionLabel)) : null
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Sample creation dialog                                                 */
  /* ---------------------------------------------------------------------- */
  function renderSampleDialogOptions() {
    const storage = $('#fStorage'); const analyst = $('#fAnalyst'); const bulkStorage = $('#bulkStorage');
    if (storage) {
      storage.innerHTML = '<option value="">Not stored yet</option>' + state.storageLocations.map(loc => `<option value="${loc.id}"${loc.isFull ? ' disabled' : ''}>${esc(loc.name)}${loc.isFull ? ' — FULL' : ''}</option>`).join('');
    }
    if (analyst) {
      analyst.innerHTML = '<option value="">Unassigned</option>' + state.people.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
    }
    if (bulkStorage) {
      bulkStorage.innerHTML = '<option value="">Not stored yet</option>' + state.storageLocations.map(loc => `<option value="${loc.id}">${esc(loc.name)}</option>`).join('');
    }
    renderTestPicker();
  }
  function renderTestPicker() {
    const picker = $('#fTestPicker'); const chips = $('#fSelectedTests');
    if (!picker || !chips) return;
    const available = state.tests.map(t => t.name).filter(n => !state.selectedRequestedTests.includes(n));
    picker.innerHTML = '<option value="">Select and add test</option>' + available.map(n => `<option>${esc(n)}</option>`).join('');
    chips.innerHTML = state.selectedRequestedTests.map(n => `<button type="button" class="chip chip-role" data-remove-test="${esc(n)}">${esc(n)} ✕</button>`).join('') || '<span class="muted text-sm">No tests selected</span>';
    picker.onchange = () => {
      if (!picker.value || state.selectedRequestedTests.includes(picker.value)) return;
      state.selectedRequestedTests.push(picker.value);
      renderTestPicker();
    };
    chips.querySelectorAll('[data-remove-test]').forEach(btn => btn.onclick = () => {
      state.selectedRequestedTests = state.selectedRequestedTests.filter(n => n !== btn.dataset.removeTest);
      renderTestPicker();
    });
  }
  function openSampleDialog() {
    state.selectedRequestedTests = [];
    renderSampleDialogOptions();
    $('#sampleDialog').showModal();
    // First focus on client name
    setTimeout(() => $('#fClient')?.focus(), 100);
  }
  $('#newSampleBtn').onclick = openSampleDialog;
  $('#bulkSampleBtn').onclick = () => {
    renderSampleDialogOptions();
    $('#bulkResult').innerHTML = '';
    $('#bulkSampleDialog').showModal();
  };
  $('#sampleForm').onsubmit = safe(async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const photo = fd.get('samplePhoto');
    fd.delete('samplePhoto');
    const data = Object.fromEntries(fd);
    data.requestedTests = state.selectedRequestedTests;
    if (!data.requestedTests.length) throw new Error('Choose at least one requested test');
    const sample = await api('/api/samples', { method: 'POST', body: JSON.stringify(data) });
    if (photo && photo.size > 0) {
      const upload = new FormData();
      upload.append('category', 'Sample Photo');
      upload.append('files', photo);
      await api(`/api/samples/${sample.id}/files`, { method: 'POST', body: upload });
    }
    $('#sampleDialog').close();
    e.target.reset();
    state.selectedRequestedTests = [];
    openSampleDetail(sample.id);
    await load();
    notify({ type: 'success', title: 'Sample registered', description: `${sample.sampleCode} — QR label ready to print.` });
  });

  // Bulk create
  $('#createBulkSamples').onclick = safe(async () => {
    const rows = parseBulkRows($('#bulkRows').value);
    const result = await api('/api/samples/bulk', { method: 'POST', body: JSON.stringify({ rows }) });
    await load();
    renderBulkResult(result.created, result.errors);
    notify({ type: 'success', title: `${result.created.length} sample${result.created.length === 1 ? '' : 's'} created` });
  });
  $('#importBulkExcel').onclick = safe(async () => {
    const file = $('#bulkExcel').files[0];
    if (!file) throw new Error('Choose an Excel file');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('storageLocationId', $('#bulkStorage').value);
    const result = await api('/api/samples/bulk/excel', { method: 'POST', body: fd });
    await load();
    renderBulkResult(result.created, result.errors);
    notify({ type: 'success', title: `${result.created.length} sample${result.created.length === 1 ? '' : 's'} imported` });
  });
  function parseBulkRows(text) {
    return String(text || '').split(/\r?\n/).map(r => r.trim()).filter(Boolean)
      .filter((r,i) => i > 0 || !r.toLowerCase().startsWith('project,') && !r.toLowerCase().startsWith('client,'))
      .map(r => r.split(/,|\t/).map(c => c.trim()))
      .map(cells => {
        const storage = state.storageLocations.find(l => l.id === cells[4] || l.name.toLowerCase() === String(cells[4] || '').toLowerCase());
        return {
          clientName: cells[0] || '',
          sourceType: cells[1] || 'Drinking Water',
          collectionSite: cells[2] || '',
          collector: cells[3] || '',
          storageLocationId: storage?.id || $('#bulkStorage')?.value || '',
          assignedTo: cells[5] || '',
          requestedTests: String(cells[6] || '').split(/[,;]/).map(x => x.trim()).filter(Boolean),
          dueAt: cells[7] ? new Date(cells[7]).toISOString() : '',
          notes: cells[8] || ''
        };
      });
  }
  function renderBulkResult(created = [], errors = []) {
    const out = $('#bulkResult');
    out.innerHTML = '';
    out.appendChild(h('div', { class: 'row-between' },
      h('strong', null, `${created.length} samples created`),
      created.length ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
        const ids = created.map(s => s.id).join(',');
        window.open(apiUrl(`/api/samples/bulk-tube-qr-labels?ids=${encodeURIComponent(ids)}&token=${encodeURIComponent(state.token)}`), '_blank');
      } }, h('span',{class:'btn-label'},'Print QR labels')) : null
    ));
    if (errors.length) {
      out.appendChild(h('div', { class: 'form-error-banner' }, `${errors.length} row${errors.length === 1 ? '' : 's'} need correction: ` + errors.map(x => `Row ${x.row}: ${x.error}`).join('; ')));
    }
    if (created.length) out.appendChild(h('div', { class: 'card-grid' }, ...created.map(sampleCard)));
  }

  /* ---------------------------------------------------------------------- */
  /* Dialog close bindings                                                  */
  /* ---------------------------------------------------------------------- */
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-close-dialog]'); if (!b) return;
    const dlg = document.getElementById(b.dataset.closeDialog);
    if (dlg) dlg.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Auth handlers                                                          */
  /* ---------------------------------------------------------------------- */
  $('#loginForm').onsubmit = safe(async e => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(new FormData(f));
    const remember = Boolean(body.rememberMe);
    body.rememberMe = remember;
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify(body) });
    state.token = data.token;
    if (remember) {
      localStorage.setItem('plasma-lab-token', state.token);
      localStorage.setItem('plasma-lab-remember-email', f.elements.email.value.trim());
    } else {
      sessionStorage.setItem('plasma-lab-token', state.token);
      localStorage.removeItem('plasma-lab-token');
    }
    showApp();
    await load();
    notify({ type: 'success', title: 'Signed in' });
  });

  $('#sendEmailOtp').onclick = safe(async () => {
    const f = $('#signupForm');
    const checks = await validateSignupFields();
    if (checks.email && (!checks.email.valid || !checks.email.available)) throw new Error(checks.email.message || 'Enter a valid email');
    const data = await api('/api/signup/email/start', { method: 'POST', body: JSON.stringify({
      name: f.elements.name.value.trim(), email: f.elements.email.value.trim()
    }) });
    state.pendingSignupId = data.pendingId;
    $('#emailOtpBox').classList.remove('hidden');
    setTimeout(() => $('#emailOtpInput')?.focus(), 100);
    notify({ type: 'success', title: 'Email OTP sent', description: 'Check the inbox for the 6-digit code.' });
  });
  $('#verifyEmailOtp').onclick = safe(async () => {
    await api('/api/signup/email/verify', { method: 'POST', body: JSON.stringify({
      pendingId: state.pendingSignupId, emailOtp: $('#emailOtpInput').value
    }) });
    setSignupStep('phone');
    setTimeout(() => $('#signupPhone')?.focus(), 100);
    notify({ type: 'success', title: 'Email verified' });
  });
  $('#resendEmailOtp').onclick = safe(async () => {
    if (!state.pendingSignupId) throw new Error('Enter email and click Send OTP first');
    await api('/api/signup/resend', { method: 'POST', body: JSON.stringify({ pendingId: state.pendingSignupId, channel: 'email' }) });
    notify({ type: 'success', title: 'OTP resent' });
  });
  $('#savePhone').onclick = safe(async () => {
    const f = $('#signupForm');
    const checks = await validateSignupFields();
    if (checks.phone && (!checks.phone.valid || !checks.phone.available)) throw new Error(checks.phone.message || 'Enter a valid phone number');
    await api('/api/signup/phone/save', { method: 'POST', body: JSON.stringify({
      pendingId: state.pendingSignupId,
      countryCode: f.elements.countryCode.value,
      phone: f.elements.phone.value.trim()
    }) });
    setSignupStep('password');
    setTimeout(() => $('#signupPassword')?.focus(), 100);
    notify({ type: 'success', title: 'Phone saved' });
  });
  $('#signupForm').onsubmit = safe(async e => {
    e.preventDefault();
    if (!validatePasswordFields()) throw new Error('Check the password fields');
    const f = e.target;
    const body = {
      pendingId: state.pendingSignupId,
      password: f.elements.password.value,
      confirmPassword: f.elements.confirmPassword.value
    };
    const data = await api('/api/signup/complete', { method: 'POST', body: JSON.stringify(body) });
    f.reset();
    state.pendingSignupId = '';
    showSlide('login');
    $('#loginEmail').value = data.user.email;
    notify({ type: 'success', title: 'Account created', description: 'You can sign in now.' });
  });
  $('#resetStartForm').onsubmit = safe(async e => {
    e.preventDefault();
    const data = await api('/api/password-reset/start', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    state.resetId = data.resetId;
    showSlide('resetConfirm');
    setTimeout(() => $('#resetOtpInput')?.focus(), 100);
    notify({ type: 'success', title: 'Reset OTP sent' });
  });
  $('#resetConfirmForm').onsubmit = safe(async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.resetId = state.resetId;
    await api('/api/password-reset/confirm', { method: 'POST', body: JSON.stringify(body) });
    e.target.reset();
    showSlide('login');
    notify({ type: 'success', title: 'Password updated', description: 'Sign in with your new password.' });
  });

  // Live signup validation
  ['email','phone','countryCode'].forEach(name => {
    const el = $('#signupForm')?.elements[name];
    el?.addEventListener('input', scheduleSignupValidation);
    el?.addEventListener('change', scheduleSignupValidation);
  });
  ['password','confirmPassword'].forEach(name => {
    const el = $('#signupForm')?.elements[name];
    el?.addEventListener('input', validatePasswordFields);
  });

  // Auth navigation links
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-auth]'); if (!a) return;
    e.preventDefault();
    showSlide(a.dataset.auth);
  });

  // Password toggles
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-toggle-password]'); if (!b) return;
    const input = b.closest('.password-field')?.querySelector('input'); if (!input) return;
    const hide = input.type === 'text';
    input.type = hide ? 'password' : 'text';
    b.setAttribute('aria-label', hide ? 'Show password' : 'Hide password');
  });

  // Header buttons
  $('#logoutBtn').onclick = () => { stopScanner(); clearSession(); showAuth(); notify({ type: 'info', title: 'Signed out' }); };
  $('#syncBtn').onclick = safe(async () => { await load(); notify({ type: 'success', title: 'Synced' }); });
  $('#backupBtn').onclick = safe(async () => {
    const res = await fetch(apiUrl('/api/backup'), { headers: { Authorization: 'Bearer ' + state.token } });
    if (!res.ok) throw new Error('Backup failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `plasma-lab-backup-${new Date().toISOString().slice(0,10)}.html`; a.click();
    URL.revokeObjectURL(url);
    notify({ type: 'success', title: 'Backup downloaded' });
  });

  // Remember me — repopulate
  const rememberedEmail = localStorage.getItem('plasma-lab-remember-email');
  if (rememberedEmail) {
    $('#loginEmail').value = rememberedEmail;
    $('#loginForm').elements.rememberMe.checked = true;
  }

  // Boot
  if (state.token) {
    showApp();
    load().catch(() => { clearSession(); showAuth(); });
  } else {
    showAuth();
  }

  window.addEventListener('unhandledrejection', evt => {
    notify({ type: 'error', title: 'Unexpected error', description: evt.reason?.message || 'Something went wrong' });
  });

  // Expose minimal for debugging
  window.__lims = { state, api, load, notify };

})();
