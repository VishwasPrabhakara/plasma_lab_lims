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
    auditFilters: { q:'', user:'', action:'', from:'', to:'' },
    pendingSignupId: '', resetId: '',
    showInactiveUsers: false,
    selectedRequestedTests: [],
    selectedSamples: new Set(),
    pendingConfirm: null,
    pendingApproval: null,
    fullScannerOpen: false,
    scannerStream: null,
    meSheetOpen: false
  };

  const CONFIG = window.PLASMA_LIMS_CONFIG || {};
  const API_BASE = String(CONFIG.API_BASE || '').replace(/\/$/, '');
  const STATUS_OPTIONS = ['Bottle Ready','Sample Collected','Stored','Assigned','In Analysis','Results Entered','Needs Review','Approved','Flagged','Disposed'];
  const LIFECYCLE_STRIP = ['Bottle Ready','Sample Collected','Stored','Assigned','In Analysis','Needs Review','Approved'];

  /* ---------------------------------------------------------------------- */
  /* Project parameter panels — mirrors the lab's Excel workbook            */
  /* Each parameter row: [name, unit, standard, defaultReplicates]          */
  /* Standards left blank must be set per project per sample.               */
  /* ---------------------------------------------------------------------- */
  const PARAM = (name, unit = '', std = '', reps = 3) => ({ name, unit, std, reps });
  const PROJECT_PANELS = {
    'Devanahalli': [
      PARAM('pH','', '', 2), PARAM('BOD','mg/L','30',1), PARAM('COD','mg/L','250',3), PARAM('TSS','mg/L','100',3),
      PARAM('TN','mg/L','10',3), PARAM('NH4-N','mg/L','5',3), PARAM('PO4-P','mg/L','1',3),
      PARAM('Faecal Coliform','MPN/100mL','230',1), PARAM('Turbidity','NTU','5',2), PARAM('Fluoride','mg/L','1.5',2)
    ],
    'V Valley': [
      PARAM('pH','','',2), PARAM('BOD','mg/L','30',1), PARAM('COD','mg/L','250',3), PARAM('TSS','mg/L','100',3),
      PARAM('TN','mg/L','10',3), PARAM('NH4-N','mg/L','5',3), PARAM('PO4-P','mg/L','1',3),
      PARAM('Faecal Coliform','MPN/100mL','230',1), PARAM('Hardness','mg/L','600',3), PARAM('Fluoride','mg/L','1.5',2)
    ],
    'HN Valley': [
      PARAM('pH','','',2), PARAM('BOD','mg/L','30',1), PARAM('COD','mg/L','250',3), PARAM('TSS','mg/L','100',3),
      PARAM('TN','mg/L','10',3), PARAM('NH4-N','mg/L','5',3), PARAM('PO4-P','mg/L','1',3),
      PARAM('Faecal Coliform','MPN/100mL','230',1)
    ],
    'KC Valley Water': [
      PARAM('pH','','',2), PARAM('BOD','mg/L','30',1), PARAM('COD','mg/L','250',3), PARAM('TSS','mg/L','100',3),
      PARAM('TN','mg/L','10',3), PARAM('NH4-N','mg/L','5',3), PARAM('PO4-P','mg/L','1',3),
      PARAM('Faecal Coliform','MPN/100mL','230',1)
    ],
    'KC Valley Soil': [
      PARAM('pH','','',2), PARAM('EC','microS/cm','',3), PARAM('Sand','%','',3), PARAM('Clay','%','',3),
      PARAM('Silt','%','',3), PARAM('Salinity','ppt','',3), PARAM('Organic Matter','%','',3),
      PARAM('Nitrate','mg/kg','',3), PARAM('Avail Phosphorus','mg/kg','',3)
    ],
    'Karwar Water': [
      PARAM('pH','','',2), PARAM('Temp','°C','',1), PARAM('Turbidity','NTU','5',2),
      PARAM('EC','microS/cm','',3), PARAM('TSS','mg/L','100',3), PARAM('Salinity','ppt','',3),
      PARAM('DO','mg/L','4',1), PARAM('BOD','mg/L','30',1), PARAM('COD','mg/L','250',3),
      PARAM('NO2-N','mg/L','',3), PARAM('NO3-N','mg/L','10',3), PARAM('Phosphate','mg/L','',3),
      PARAM('Oil and Grease','mg/L','10',3)
    ],
    'Karwar Soil': [
      PARAM('pH','','',2), PARAM('Sand','%','',3), PARAM('Silt','%','',3), PARAM('Clay','%','',3),
      PARAM('Organic Matter','%','',3), PARAM('Porosity','%','',3), PARAM('NO3-N','mg/kg','',3),
      PARAM('PO4-P','mg/kg','',3), PARAM('K','mg/kg','',3), PARAM('Salinity','ppt','',3)
    ],
    'L&T': [
      PARAM('COD','mg/L','250',3), PARAM('BOD','mg/L','30',1), PARAM('TKN','mg/L','',3),
      PARAM('PO4-P','mg/L','1',3), PARAM('NH3-N','mg/L','5',3), PARAM('TN','mg/L','10',3),
      PARAM('NO3-N','mg/L','10',3), PARAM('NO2-N','mg/L','',3)
    ],
    'KAPL': [
      PARAM('pH','','',2), PARAM('BOD','mg/L','30',1), PARAM('COD','mg/L','250',3), PARAM('TSS','mg/L','100',3),
      PARAM('TN','mg/L','10',3), PARAM('NH4-N','mg/L','5',3), PARAM('PO4-P','mg/L','1',3),
      PARAM('Faecal Coliform','MPN/100mL','230',1)
    ]
  };
  // Given clientName / collectionSite, try to match a panel name (case-insensitive contains).
  function guessPanelName(sample) {
    const hay = ((sample?.clientName || '') + ' ' + (sample?.collectionSite || '')).toLowerCase();
    // Longest key first so "KC Valley Soil" beats "KC Valley Water".
    const keys = Object.keys(PROJECT_PANELS).sort((a,b) => b.length - a.length);
    return keys.find(k => hay.includes(k.toLowerCase())) || '';
  }
  // Live-compute avg / stddev / msg for a single parameter row.
  function computeRepStats(vals, std) {
    const nums = vals.map(v => v === '' || v == null ? null : Number(v)).filter(v => v !== null && !Number.isNaN(v));
    if (nums.length === 0) return { avg: '', stddev: '', msg: '' };
    const avg = nums.reduce((a,b) => a+b, 0) / nums.length;
    let stddev = '';
    if (nums.length > 1) {
      const m = avg;
      const variance = nums.reduce((a,b) => a + (b-m)*(b-m), 0) / (nums.length - 1);
      stddev = Math.sqrt(variance);
    }
    const stdNum = std === '' || std == null ? null : Number(std);
    let msg = '';
    if (stdNum != null && !Number.isNaN(stdNum)) msg = avg < stdNum ? 'OK' : 'ALERT';
    return {
      avg: Number.isFinite(avg) ? Number(avg.toFixed(3)) : '',
      stddev: stddev === '' ? '' : Number(stddev.toFixed(3)),
      msg
    };
  }

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
    if (btn.dataset.view === 'scan') openFullScreenScanner();
    else if (btn.dataset.view === 'me') openMeSheet();
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

  function sampleCard(sample, opts = {}) {
    const storage = state.storageLocations.find(x => x.id === sample.storageLocationId)?.name || 'No storage';
    const selected = state.selectedSamples.has(sample.id);
    const showSelect = opts.allowSelect !== false && can('admin');
    return h('button', {
      class: 'sample-card' + (selected ? ' is-selected' : ''), type: 'button',
      'data-sample': sample.id,
      'aria-current': sample.id === state.selectedId ? 'true' : 'false',
      onclick: e => {
        // Long-press or Shift+click enters bulk mode
        if (e.shiftKey || state.selectedSamples.size > 0) {
          e.preventDefault();
          toggleSampleSelect(sample.id);
        } else {
          openSampleDetail(sample.id);
        }
      }
    },
      showSelect ? h('span', {
        class: 'select-box',
        role: 'checkbox',
        'aria-checked': selected,
        'aria-label': 'Select ' + sample.sampleCode,
        onclick: e => { e.stopPropagation(); toggleSampleSelect(sample.id); }
      }) : null,
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

  function toggleSampleSelect(id) {
    if (state.selectedSamples.has(id)) state.selectedSamples.delete(id);
    else state.selectedSamples.add(id);
    render();
  }
  function clearSampleSelection() {
    state.selectedSamples.clear();
    render();
  }
  function renderBulkActionBar() {
    if (state.selectedSamples.size === 0) return null;
    const count = state.selectedSamples.size;
    return h('div', { class: 'bulk-action-bar', role: 'toolbar', 'aria-label': 'Bulk actions' },
      h('span', { class: 'bulk-count' }, `${count} selected`),
      h('div', { class: 'bulk-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => bulkAssign() }, h('span',{class:'btn-label'},'Assign…')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => bulkMarkStatus('Stored') }, h('span',{class:'btn-label'},'Mark Stored')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => bulkPrintQr() }, h('span',{class:'btn-label'},'Print QR')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => bulkExportCsv() }, h('span',{class:'btn-label'},'Export CSV')),
        h('button', { class: 'btn btn-sm btn-clear', type: 'button', onclick: clearSampleSelection }, h('span',{class:'btn-label'},'Clear'))
      )
    );
  }
  async function bulkAssign() {
    const names = state.people.map(p => p.name);
    if (names.length === 0) return notify({ type: 'warn', title: 'No analysts', description: 'Add people in Masters first.' });
    const analyst = window.prompt('Assign selected samples to (analyst name):\n\n' + names.join(', '));
    if (!analyst) return;
    const ids = [...state.selectedSamples];
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await api(`/api/samples/${id}`, { method: 'PATCH', body: JSON.stringify({ assignedTo: analyst.trim() }) }); ok++; }
      catch { fail++; }
    }
    clearSampleSelection();
    await load();
    notify({ type: fail ? 'warn' : 'success', title: `${ok} assigned`, description: fail ? `${fail} failed` : `All to ${analyst}` });
  }
  async function bulkMarkStatus(status) {
    const confirmed = await confirmDialog({ title: 'Bulk update', message: `Mark ${state.selectedSamples.size} samples as "${status}"?`, okLabel: 'Update' });
    if (!confirmed) return;
    const ids = [...state.selectedSamples];
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await api(`/api/samples/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); ok++; }
      catch { fail++; }
    }
    clearSampleSelection();
    await load();
    notify({ type: fail ? 'warn' : 'success', title: `${ok} updated`, description: fail ? `${fail} failed` : null });
  }
  function bulkPrintQr() {
    const ids = [...state.selectedSamples].join(',');
    if (!ids) return;
    window.open(apiUrl(`/api/samples/bulk-tube-qr-labels?ids=${encodeURIComponent(ids)}&token=${encodeURIComponent(state.token)}`), '_blank');
  }
  function bulkExportCsv() {
    const ids = [...state.selectedSamples];
    const rows = state.samples.filter(s => ids.includes(s.id));
    const csv = ['Sample Code,Status,Client,Site,Source,Storage,Analyst,Created,Due'].concat(rows.map(s => [
      s.sampleCode, s.status, s.clientName, s.collectionSite, s.sourceType,
      state.storageLocations.find(l => l.id === s.storageLocationId)?.name || '',
      s.assignedTo || '',
      fmtDate(s.createdAt),
      s.dueAt ? fmtDate(s.dueAt) : ''
    ].map(v => `"${String(v).replaceAll('"','""')}"`).join(','))).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `samples-${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
    notify({ type: 'success', title: `${rows.length} samples exported` });
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
      const grid = h('div', { class: 'card-grid' + (state.selectedSamples.size > 0 ? ' bulk-mode' : '') }, ...rows.map(s => sampleCard(s)));
      root.appendChild(grid);
    }
    const bar = renderBulkActionBar();
    if (bar) root.appendChild(bar);
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
      can('admin') && { id: 'retention', label: 'Retention' },
      { id: 'history', label: 'History' }
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
    if (state.tab === 'history')    tabBody.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-body' }, auditTimelineEl(sample))));
    mainCol.appendChild(tabBody);

    // QR + facts card — side-by-side on desktop, stacked on mobile
    const details = h('div', { class: 'card', style: { marginBottom: '16px' } });
    details.appendChild(h('div', { class: 'card-body' },
      h('div', { class: 'detail-body' },
        qrBlockEl(sample),
        h('div', { class: 'stack' },
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
      photo ? h('img', { class: 'sample-photo', src: apiUrl(photo.url), alt: 'Sample photo' }) : h('div', { class: 'empty-state', style: { padding: '16px', minHeight: '110px', fontSize: '12px' } }, 'No sample photo'),
      h('img', { class: 'qr-image', src: apiUrl(`/api/samples/${sample.id}/qr.svg?token=${encodeURIComponent(state.token)}`), alt: 'QR code' }),
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

    // Panel picker — mirrors the Excel workbook's project → parameter mapping.
    const guessed = guessPanelName(sample);
    const panelNames = Object.keys(PROJECT_PANELS);
    const analystOptions = state.people.map(p => p.name);

    // Header controls: panel + sampling date + analysis date + log book page
    const headerControls = h('div', { class: 'sheet-header-controls' },
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'sheetPanel' }, 'Parameter panel'),
        (() => {
          const sel = h('select', { class: 'select', id: 'sheetPanel' });
          sel.appendChild(h('option', { value: '' }, '— Custom / manual —'));
          panelNames.forEach(n => sel.appendChild(h('option', { value: n, selected: n === guessed ? true : null }, n)));
          sel.onchange = () => reloadPanel(sel.value);
          return sel;
        })()
      ),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'sheetSampDate' }, 'Sampling date'),
        h('input', { class: 'input', id: 'sheetSampDate', type: 'date', value: (sample.collectionDate || '').slice(0,10) })
      ),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'sheetAnaDate' }, 'Analysis date'),
        h('input', { class: 'input', id: 'sheetAnaDate', type: 'date', value: new Date().toISOString().slice(0,10) })
      ),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'sheetLogPage' }, 'Log book page'),
        h('input', { class: 'input', id: 'sheetLogPage', placeholder: 'e.g. 142' })
      )
    );
    body.appendChild(headerControls);

    // Legend explaining the replicate layout
    body.appendChild(h('div', { class: 'sheet-legend' },
      h('span', null, 'Enter 1–3 replicate readings per parameter. '),
      h('strong', null, 'Avg, StdDev, and OK/ALERT'),
      h('span', null, ' compute automatically. Assign a different analyst per replicate when applicable — this mirrors the lab\'s Excel workbook.')
    ));

    const gridWrap = h('div', { class: 'result-grid replicate-grid' });
    const table = h('table', { role: 'grid', 'aria-label': 'Analysis results for ' + sample.sampleCode });
    table.appendChild(h('thead', null,
      h('tr', null,
        h('th', { scope: 'col', rowspan: 2 }, '#'),
        h('th', { scope: 'col', rowspan: 2 }, 'Parameter'),
        h('th', { scope: 'col', rowspan: 2 }, 'Unit'),
        h('th', { scope: 'col', rowspan: 2 }, 'Std.'),
        h('th', { scope: 'col', colspan: 2, class: 'rep-group' }, 'R1'),
        h('th', { scope: 'col', colspan: 2, class: 'rep-group' }, 'R2'),
        h('th', { scope: 'col', colspan: 2, class: 'rep-group' }, 'R3'),
        h('th', { scope: 'col', rowspan: 2, class: 'derived' }, 'Avg'),
        h('th', { scope: 'col', rowspan: 2, class: 'derived' }, 'StdDev'),
        h('th', { scope: 'col', rowspan: 2, class: 'derived' }, 'Msg'),
        h('th', { scope: 'col', rowspan: 2, 'aria-label': 'Row actions' }, '')
      ),
      h('tr', null,
        h('th', { scope: 'col' }, 'Value'), h('th', { scope: 'col' }, 'By'),
        h('th', { scope: 'col' }, 'Value'), h('th', { scope: 'col' }, 'By'),
        h('th', { scope: 'col' }, 'Value'), h('th', { scope: 'col' }, 'By')
      )
    ));
    const tbody = h('tbody');
    table.appendChild(tbody);
    gridWrap.appendChild(table);

    function renumber() {
      [...tbody.children].forEach((tr, i) => { const n = tr.querySelector('th[scope="row"]'); if (n) n.textContent = String(i + 1); });
    }
    function recomputeRow(tr) {
      const vals = ['r1','r2','r3'].map(k => tr.querySelector(`[data-field="${k}"]`).value.trim());
      const std = tr.querySelector('[data-field="std"]').value.trim();
      const { avg, stddev, msg } = computeRepStats(vals, std);
      tr.querySelector('[data-derived="avg"]').textContent = avg === '' ? '—' : avg;
      tr.querySelector('[data-derived="stddev"]').textContent = stddev === '' ? '—' : stddev;
      const msgEl = tr.querySelector('[data-derived="msg"]');
      msgEl.textContent = msg || '—';
      msgEl.className = 'derived msg-cell ' + (msg === 'ALERT' ? 'msg-alert' : msg === 'OK' ? 'msg-ok' : 'msg-none');
    }
    function addRow(row = {}, num) {
      const analystSel = (val) => {
        const sel = h('select', { class: 'input', 'data-field': `${val.field}`, 'aria-label': val.field + ' analyst' });
        sel.appendChild(h('option', { value: '' }, '—'));
        analystOptions.forEach(a => sel.appendChild(h('option', { value: a, selected: val.value === a ? true : null }, a)));
        return sel;
      };
      const numInp = (field, placeholder = '') => h('input', {
        class: 'input mono', type: 'text', inputmode: 'decimal',
        'data-field': field, 'aria-label': field, placeholder,
        value: row[field] || ''
      });
      const tr = h('tr', { role: 'row' },
        h('th', { scope: 'row' }, String(num)),
        h('td', null, h('input', { class: 'input', 'data-field': 'parameter', 'aria-label': 'Parameter', value: row.parameter || '' })),
        h('td', null, h('input', { class: 'input', 'data-field': 'unit', 'aria-label': 'Unit', value: row.unit || '' })),
        h('td', null, h('input', { class: 'input mono', 'data-field': 'std', 'aria-label': 'Standard', value: row.std || '', placeholder: 'e.g. 30' })),
        h('td', null, numInp('r1', '7.4')),
        h('td', null, analystSel({ field: 'r1By', value: row.r1By || (state.user?.name || '') })),
        h('td', null, numInp('r2')),
        h('td', null, analystSel({ field: 'r2By', value: row.r2By || '' })),
        h('td', null, numInp('r3')),
        h('td', null, analystSel({ field: 'r3By', value: row.r3By || '' })),
        h('td', { class: 'derived mono', 'data-derived': 'avg' }, '—'),
        h('td', { class: 'derived mono', 'data-derived': 'stddev' }, '—'),
        h('td', { class: 'derived msg-cell msg-none', 'data-derived': 'msg' }, '—'),
        h('td', { class: 'row-actions' },
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Remove row', title: 'Remove row', onclick: () => { tr.remove(); renumber(); } }, '✕')
        )
      );
      // Recompute on any input change
      tr.querySelectorAll('[data-field="r1"], [data-field="r2"], [data-field="r3"], [data-field="std"]')
        .forEach(inp => inp.addEventListener('input', () => recomputeRow(tr)));
      tbody.appendChild(tr);
      recomputeRow(tr);
      return tr;
    }
    function reloadPanel(panelName) {
      tbody.innerHTML = '';
      if (panelName && PROJECT_PANELS[panelName]) {
        PROJECT_PANELS[panelName].forEach((p, i) => addRow({ parameter: p.name, unit: p.unit, std: p.std }, i + 1));
      } else {
        // Fallback: use sample.requestedTests
        const tests = sample.requestedTests?.length ? sample.requestedTests : state.tests.slice(0, 5).map(t => t.name);
        tests.forEach((name, i) => {
          const t = state.tests.find(x => x.name === name) || {};
          addRow({ parameter: name, unit: t.unit || '', std: t.limit || '' }, i + 1);
        });
      }
    }
    // Initial population from guessed panel
    reloadPanel(guessed);

    const reasonField = h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'sheetReason' }, 'Reason (required for amendments to previously-saved values)'),
      h('input', { class: 'input', id: 'sheetReason', placeholder: 'e.g. re-run after instrument recalibration' })
    );

    body.appendChild(h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' } },
      h('div', { class: 'muted text-sm' }, 'Live avg / stddev / OK-vs-standard follow the workbook formulas.'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => addRow({}, tbody.children.length + 1) }, h('span',{class:'btn-label'},'+ Add parameter'))
    ));
    body.appendChild(gridWrap);
    body.appendChild(reasonField);
    body.appendChild(h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => saveSheet(sample) }, h('span',{class:'btn-label'},'Save values'))
    ));

    $('#resultSheetDialog').showModal();

    // Arrow-key nav between cells: Up/Down/Left/Right + Enter
    const gridEl = gridWrap.querySelector('table');
    gridEl.addEventListener('keydown', e => {
      const cell = e.target.closest('input, select'); if (!cell) return;
      const row = cell.closest('tr'); if (!row) return;
      const cellsInRow = [...row.querySelectorAll('input, select')];
      const colIdx = cellsInRow.indexOf(cell);
      const allRows = [...gridEl.querySelectorAll('tbody tr')];
      const rowIdx = allRows.indexOf(row);
      let target = null;
      if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.shiftKey && colIdx < cellsInRow.length - 1)) {
        target = cellsInRow[colIdx + 1];
      } else if (e.key === 'ArrowLeft') {
        target = cellsInRow[colIdx - 1];
      } else if (e.key === 'ArrowDown' || (e.key === 'Enter' && colIdx === cellsInRow.length - 1)) {
        const nextRow = allRows[rowIdx + 1];
        if (nextRow) target = nextRow.querySelectorAll('input, select')[Math.min(colIdx, nextRow.querySelectorAll('input, select').length - 1)];
      } else if (e.key === 'ArrowUp') {
        const prevRow = allRows[rowIdx - 1];
        if (prevRow) target = prevRow.querySelectorAll('input, select')[Math.min(colIdx, prevRow.querySelectorAll('input, select').length - 1)];
      }
      if (target) { e.preventDefault(); target.focus(); if (target.select) target.select(); }
    });

    // Focus first replicate cell
    setTimeout(() => body.querySelector('[data-field="r1"]')?.focus(), 150);
  }
  async function saveSheet(sample) {
    const trs = $$('#sheetBody tbody tr');
    const rows = trs.map(tr => {
      const r = {};
      tr.querySelectorAll('[data-field]').forEach(inp => { r[inp.dataset.field] = inp.value.trim(); });
      const { avg, stddev, msg } = computeRepStats([r.r1, r.r2, r.r3], r.std);
      // Backward-compatible primary fields the existing backend understands.
      // avg → value ; msg → flag ('OK' | 'Alert') ; std → limit.
      // New replicate detail fields are additional; the server may store or ignore them.
      const analystInitials = [
        r.r1 && r.r1By ? `R1-${initials(r.r1By)}` : null,
        r.r2 && r.r2By ? `R2-${initials(r.r2By)}` : null,
        r.r3 && r.r3By ? `R3-${initials(r.r3By)}` : null,
      ].filter(Boolean).join(', ');
      return {
        parameter: r.parameter,
        value: avg === '' ? '' : String(avg),
        unit: r.unit,
        limit: r.std,
        method: analystInitials ? `Replicates: ${analystInitials}` : '',
        flag: msg === 'ALERT' ? 'Alert' : msg === 'OK' ? 'OK' : 'Review',
        replicates: [
          { value: r.r1, analyst: r.r1By },
          { value: r.r2, analyst: r.r2By },
          { value: r.r3, analyst: r.r3By }
        ].filter(x => x.value !== ''),
        avg: avg === '' ? null : Number(avg),
        stddev: stddev === '' ? null : Number(stddev),
        msg
      };
    }).filter(r => r.parameter && r.value !== '');
    if (rows.length === 0) return notify({ type: 'warn', title: 'Nothing to save', description: 'Enter at least one replicate value on any parameter.' });
    const reason = $('#sheetReason')?.value || '';
    const meta = {
      panel: $('#sheetPanel')?.value || '',
      samplingDate: $('#sheetSampDate')?.value || '',
      analysisDate: $('#sheetAnaDate')?.value || '',
      logBookPage: $('#sheetLogPage')?.value || ''
    };
    try {
      const updated = await api(`/api/samples/${sample.id}/results/sheet`, {
        method: 'POST',
        body: JSON.stringify({ rows, reasonForChange: reason, meta })
      });
      Object.assign(sample, updated); state.tab = 'results';
      $('#resultSheetDialog').close();
      await load();
      const alerts = rows.filter(r => r.flag === 'Alert').length;
      notify({
        type: alerts ? 'warn' : 'success',
        title: alerts ? `${rows.length} saved · ${alerts} ALERT` : 'Values saved',
        description: `${rows.length} parameter${rows.length===1?'':'s'} recorded on ${sample.sampleCode}${alerts ? ` — ${alerts} exceeded standard(s).` : '.'}`
      });
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
  function flash(cls) {
    const el = h('div', { class: cls || 'scan-flash' });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 400);
  }
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.08);
      setTimeout(() => ctx.close(), 200);
    } catch {}
    try { if (navigator.vibrate) navigator.vibrate(50); } catch {}
  }

  /* Full-screen scanner overlay ---------------------------------------- */
  async function openFullScreenScanner() {
    if (state.fullScannerOpen) return;
    state.fullScannerOpen = true;

    const overlay = h('div', { class: 'scanner-full', role: 'dialog', 'aria-label': 'Scan QR code' });
    const closeBtn = h('button', {
      class: 'btn-icon', type: 'button', 'aria-label': 'Close scanner',
      html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'
    });
    const torchBtn = h('button', {
      class: 'btn-icon', type: 'button', 'aria-label': 'Toggle torch', 'data-torch-off': true,
      html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6l-1 4h-4L9 2z"/><path d="M8 6h8v14a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V6z"/></svg>'
    });
    const header = h('div', { class: 'scanner-header' },
      closeBtn,
      h('div', { class: 'title' }, 'Scan a sample'),
      torchBtn
    );
    const video = h('video', { muted: true, playsinline: true, autoplay: true });
    const viewport = h('div', { class: 'viewport-wrap' },
      video,
      h('div', { class: 'reticle-frame' }, h('i'), h('i'), h('div', { class: 'scan-line' }))
    );
    const hint = h('div', { class: 'hint' }, 'Point the camera at the QR label on the bottle');
    const manualInput = h('input', { class: 'input', placeholder: 'Or type PL-2026-000001', 'aria-label': 'Sample code' });
    const manualBtn = h('button', { class: 'btn btn-primary', type: 'button' }, h('span',{class:'btn-label'},'Open'));
    const footer = h('div', { class: 'footer' },
      hint,
      h('div', { class: 'manual-row' }, manualInput, manualBtn)
    );
    overlay.appendChild(header);
    overlay.appendChild(viewport);
    overlay.appendChild(footer);
    document.body.appendChild(overlay);

    function close() {
      if (state.scannerStream) state.scannerStream.getTracks().forEach(t => t.stop());
      state.scannerStream = null;
      state.fullScannerOpen = false;
      overlay.remove();
    }
    closeBtn.onclick = close;
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' && state.fullScannerOpen) { close(); document.removeEventListener('keydown', esc); }
    });
    manualBtn.onclick = async () => {
      const c = manualInput.value.trim();
      if (!c) return;
      close();
      await openByCode(c);
    };
    manualInput.addEventListener('keydown', e => { if (e.key === 'Enter') manualBtn.click(); });

    try {
      state.scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = state.scannerStream;
      await video.play();
      // torch support
      const track = state.scannerStream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() || {};
      if (caps.torch) {
        torchBtn.style.display = 'grid';
        torchBtn.onclick = async () => {
          const on = torchBtn.dataset.torchOff === 'true';
          try { await track.applyConstraints({ advanced: [{ torch: on }] }); torchBtn.dataset.torchOff = String(!on); }
          catch {}
        };
      } else {
        torchBtn.style.display = 'none';
      }
      if ('BarcodeDetector' in window) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const tick = async () => {
          if (!state.fullScannerOpen) return;
          try {
            const codes = await detector.detect(video);
            if (codes.length) {
              beep();
              flash('scan-success-flash');
              const code = codes[0].rawValue;
              close();
              await openByCode(code);
              return;
            }
          } catch {}
          requestAnimationFrame(tick);
        };
        tick();
      } else {
        hint.textContent = 'Your browser cannot auto-scan. Type the code below.';
      }
    } catch (e) {
      hint.textContent = 'Camera unavailable — type the code below.';
      notify({ type: 'warn', title: 'Camera blocked', description: e.message || 'Grant camera permission and reopen.' });
    }
  }

  /* Me sheet (bottom sheet) ------------------------------------------- */
  function openMeSheet() {
    if (state.meSheetOpen) return;
    state.meSheetOpen = true;
    const backdrop = h('div', { class: 'sheet-backdrop', onclick: closeMeSheet });
    const sheet = h('div', { class: 'me-sheet', role: 'dialog', 'aria-label': 'Account menu' });
    const iconTheme = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
    const iconSync = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    const iconOut = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
    const iconBackup = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    const iconUsers = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
    const iconAudit = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

    const themeLabel = document.documentElement.getAttribute('data-theme');
    const currentThemeText = themeLabel === 'dark' ? 'Theme: Dark' : themeLabel === 'light' ? 'Theme: Light' : 'Theme: System';

    const user = state.user;
    sheet.appendChild(h('div', { class: 'me-user' },
      h('div', { class: 'avatar' }, initials(user?.name)),
      h('div', { class: 'grow' },
        h('div', { class: 'username' }, user?.name || '—'),
        h('div', { class: 'userrole' }, roleLabel(user?.role) + ' · ' + (user?.email || ''))
      )
    ));

    const actions = h('div', { class: 'me-actions' });

    // Theme toggle
    actions.appendChild(h('button', { type: 'button', html: iconTheme + '<span>' + currentThemeText + '</span>', onclick: () => { cycleTheme(); closeMeSheet(); } }));

    // Sync
    actions.appendChild(h('button', { type: 'button', html: iconSync + '<span>Sync now</span>', onclick: async () => { closeMeSheet(); await safeSync(); } }));

    if (can('admin')) {
      actions.appendChild(h('div', { class: 'divider' }));
      actions.appendChild(h('button', { type: 'button', html: iconUsers + '<span>Manage users</span>', onclick: () => { closeMeSheet(); switchView('users'); } }));
      actions.appendChild(h('button', { type: 'button', html: iconAudit + '<span>Activity log</span>', onclick: () => { closeMeSheet(); switchView('audit'); } }));
      actions.appendChild(h('button', { type: 'button', html: iconBackup + '<span>Data backup</span>', onclick: () => { closeMeSheet(); switchView('backup'); } }));
    }

    actions.appendChild(h('div', { class: 'divider' }));
    actions.appendChild(h('button', { type: 'button', class: 'danger', html: iconOut + '<span>Sign out</span>', onclick: () => { closeMeSheet(); $('#logoutBtn').click(); } }));

    sheet.appendChild(actions);
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' && state.meSheetOpen) { closeMeSheet(); document.removeEventListener('keydown', esc); }
    });
  }
  function closeMeSheet() {
    document.querySelectorAll('.me-sheet, .sheet-backdrop').forEach(el => el.remove());
    state.meSheetOpen = false;
  }
  function cycleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : (current === 'dark' ? null : 'light');
    if (next) { root.setAttribute('data-theme', next); localStorage.setItem('plasma-lab-theme', next); }
    else { root.removeAttribute('data-theme'); localStorage.removeItem('plasma-lab-theme'); }
  }
  const safeSync = safe(async () => { await load(); notify({ type: 'success', title: 'Synced' }); });
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
    const f = state.auditFilters;
    const users = uniqueValues(state.audit.map(e => e.userName));
    const actions = uniqueValues(state.audit.map(e => e.action));

    // Filter bar
    const filterBar = h('div', { class: 'audit-filter-bar' },
      h('input', { class: 'input', placeholder: 'Search entries…', value: f.q, oninput: e => { f.q = e.target.value; render(); }, 'aria-label': 'Search activity' }),
      (() => {
        const s = h('select', { class: 'select', 'aria-label': 'Filter by user', onchange: e => { f.user = e.target.value; render(); } });
        s.appendChild(h('option', { value: '' }, 'All users'));
        users.forEach(u => s.appendChild(h('option', { value: u, selected: u === f.user ? true : null }, u)));
        return s;
      })(),
      (() => {
        const s = h('select', { class: 'select', 'aria-label': 'Filter by action', onchange: e => { f.action = e.target.value; render(); } });
        s.appendChild(h('option', { value: '' }, 'All actions'));
        actions.forEach(a => s.appendChild(h('option', { value: a, selected: a === f.action ? true : null }, a)));
        return s;
      })(),
      h('input', { class: 'input', type: 'date', value: f.from, 'aria-label': 'From date', onchange: e => { f.from = e.target.value; render(); } })
    );

    // Apply filters
    const q = (f.q || '').toLowerCase();
    const from = f.from ? new Date(f.from + 'T00:00:00').getTime() : 0;
    const filtered = state.audit.filter(evt => {
      const text = [evt.action, evt.userName, evt.entity, evt.detail].join(' ').toLowerCase();
      const at = new Date(evt.at || 0).getTime();
      return (!q || text.includes(q))
        && (!f.user || evt.userName === f.user)
        && (!f.action || evt.action === f.action)
        && at >= from;
    });

    // Card + timeline
    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-header' },
        h('h3', { class: 'card-title' }, `Activity log · ${filtered.length} of ${state.audit.length}`),
        (f.q || f.user || f.action || f.from) ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { state.auditFilters = { q:'', user:'', action:'', from:'', to:'' }; render(); } }, h('span',{class:'btn-label'},'Reset filters')) : null
      ),
      h('div', { class: 'card-body' },
        filterBar,
        filtered.length === 0
          ? emptyState({ title: state.audit.length === 0 ? 'No activity yet' : 'No matches', message: state.audit.length === 0 ? 'System actions will appear here as they occur.' : 'Try clearing filters.' })
          : (() => {
              const tl = h('div', { class: 'timeline', role: 'feed' });
              filtered.forEach(evt => {
                tl.appendChild(h('article', { class: 'timeline-event', 'data-type': evt.action?.toLowerCase().includes('approve') ? 'approve' : evt.action?.toLowerCase().includes('dispos') ? 'dispose' : evt.action?.toLowerCase().includes('reject') ? 'reject' : evt.action?.toLowerCase().includes('flag') ? 'flag' : 'default' },
                  h('div', { class: 'event-title' }, `${evt.action} — ${evt.userName || 'system'}`),
                  h('div', { class: 'event-meta' },
                    h('time', { datetime: evt.at }, fmtDate(evt.at)),
                    evt.entity ? h('span', null, evt.entity) : null,
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
