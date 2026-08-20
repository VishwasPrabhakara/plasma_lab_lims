let state = {
  token: localStorage.getItem("plasma-lab-token") || sessionStorage.getItem("plasma-lab-token") || localStorage.getItem("aquatrace-token") || "",
  user: null,
  users: [],
  people: [],
  storageLocations: [],
  tests: [],
  samples: [],
  audit: [],
  alerts: null,
  exports: [],
  health: null,
  selectedId: "",
  view: "dashboard",
  tab: "overview",
  stream: null,
  openedUrlSample: false,
  sampleDetailOpen: false,
  sampleFilters: {
    q: "",
    status: "",
    from: "",
    to: "",
    project: "",
    collector: "",
    analyst: "",
    storage: ""
  },
  pendingSignupId: "",
  resetId: "",
  showInactiveUsers: false,
  selectedRequestedTests: []
};

const $ = selector => document.querySelector(selector);
const STATUS_OPTIONS = ["Bottle Ready", "Sample Collected", "Stored", "Assigned", "In Analysis", "Results Entered", "Needs Review", "Approved", "Flagged", "Disposed"];
const WORK_ROLES = ["admin", "analyst"];
const CONFIG = window.PLASMA_LIMS_CONFIG || {};
const API_BASE = String(CONFIG.API_BASE || "").replace(/\/$/, "");

function roleLabel(role) {
  return role === "admin" ? "admin/manager" : "analyst";
}

function apiUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/api") || path.startsWith("/uploads")) return `${API_BASE}${path}`;
  return path;
}

function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return fetch(apiUrl(path), { ...options, headers: { ...headers, ...(options.headers || {}) } }).then(async response => {
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let data = null;
    if (contentType.includes("application/json")) {
      data = text ? JSON.parse(text) : null;
    } else if (!response.ok) {
      throw new Error(`Server returned ${response.status}. Check that the LIMS server is running correctly.`);
    } else {
      return text;
    }
    if (response.status === 401 && path !== "/api/login") {
      clearSession();
      showAuth();
      throw new Error("Your login session expired. Please login again.");
    }
    if (!response.ok) throw new Error(data?.error || "Request failed");
    return data;
  }).catch(error => {
    if (String(error.message || "").includes("Unexpected token")) {
      throw new Error("The server returned a page instead of data. Refresh and login again, then retry.");
    }
    throw error;
  });
}

function clearSession() {
  localStorage.removeItem("plasma-lab-token");
  localStorage.removeItem("aquatrace-token");
  sessionStorage.removeItem("plasma-lab-token");
  state.token = "";
  state.user = null;
}

function safe(handler) {
  return async event => {
    const control = event?.submitter || event?.currentTarget;
    const canLock = control && "disabled" in control;
    if (canLock && control.disabled) return;
    if (canLock) {
      control.dataset.readyLabel = control.textContent;
      if (control.dataset.busyLabel) control.textContent = control.dataset.busyLabel;
      control.disabled = true;
      control.setAttribute("aria-busy", "true");
      control.dataset.busy = "true";
    }
    try {
      await handler(event);
    } catch (error) {
      toast(error.message || "Action failed");
    } finally {
      if (canLock) {
        control.disabled = false;
        if (control.dataset.readyLabel) control.textContent = control.dataset.readyLabel;
        control.removeAttribute("aria-busy");
        delete control.dataset.readyLabel;
        delete control.dataset.busy;
      }
    }
  };
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function statusClass(status) {
  return String(status || "").replaceAll(" ", "-");
}

function can(...roles) {
  return state.user && roles.includes(state.user.role);
}

function canModifySamples() {
  return can("admin", "analyst");
}

function canEnterResults() {
  return can("admin", "analyst");
}

function canUploadFiles() {
  return can("admin", "analyst");
}

function renderRoleNav() {
  const navItems = [
    ["dashboard", "Dashboard", ["admin", "analyst"]],
    ["samples", "Samples", ["admin", "analyst"]],
    ["scan", "Scan QR", ["admin", "analyst"]],
    ["masters", "People & Storage", ["admin"]],
    ["users", "Users", ["admin"]],
    ["backup", "Data Backup", ["admin"]],
    ["audit", "Activity Log", ["admin"]]
  ];
  const visible = navItems.filter(([, , roles]) => roles.includes(state.user?.role));
  if (!visible.some(([view]) => view === state.view)) state.view = "dashboard";
  $("#nav").innerHTML = visible.map(([view, label]) => `<button data-view="${view}" class="${state.view === view ? "active" : ""}">${label}</button>`).join("");
  $("#newSampleBtn").classList.toggle("hidden", !can("admin"));
  $("#bulkSampleBtn").classList.toggle("hidden", !can("admin"));
  $("#backupBtn").classList.toggle("hidden", !can("admin"));
}

async function load() {
  const data = await api("/api/bootstrap");
  Object.assign(state, data);
  state.alerts = data.alerts || null;
  if (can("admin")) {
    state.exports = data.files || [];
    state.health = data.health || null;
  } else {
    state.exports = [];
    state.health = null;
  }
  localStorage.setItem("plasma-lab-cache", JSON.stringify(data));
  if (!state.selectedId && state.samples[0]) state.selectedId = state.samples[0].id;
  $("#userLabel").textContent = `${state.user.name} - ${roleLabel(state.user.role)}`;
  render();
  await openUrlSampleOnce().catch(error => toast(error.message || "QR link could not be opened"));
}

function showApp() {
  $("#authView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
}

function showAuth() {
  $("#authView").classList.remove("hidden");
  $("#appView").classList.add("hidden");
  showAuthSlide("login");
}

function showAuthSlide(name) {
  document.querySelectorAll(".auth-slide").forEach(slide => slide.classList.remove("active"));
  const map = {
    login: "#loginForm",
    signup: "#signupForm",
    reset: "#resetStartForm",
    resetConfirm: "#resetConfirmForm"
  };
  document.querySelector(map[name] || "#loginForm").classList.add("active");
  if (name === "signup" && !state.pendingSignupId) setSignupStep("email");
}

function renderOtpDemo(target, data) {
  $(target).innerHTML = `
    <strong>Email OTP sent</strong>
    <small>Check the registered email inbox. In local mode, the OTP is printed in the server terminal.</small>
  `;
}

function setSignupStep(step) {
  const order = ["email", "phone", "password"];
  document.querySelectorAll("#signupForm .auth-step").forEach(item => {
    const index = order.indexOf(item.dataset.step);
    const current = order.indexOf(step);
    item.classList.toggle("active", item.dataset.step === step);
    item.classList.toggle("complete", index >= 0 && index < current);
    item.classList.toggle("locked", index > current);
  });
  document.querySelectorAll("[data-progress]").forEach(item => {
    const index = order.indexOf(item.dataset.progress);
    const current = order.indexOf(step);
    item.classList.toggle("current", index === current);
    item.classList.toggle("done", index < current);
  });
}

function setCheck(target, result) {
  const el = $(target);
  if (!el) return;
  if (!result?.message) {
    el.textContent = "";
  } else {
    el.textContent = result.valid && result.available ? "✓" : "!";
  }
  el.className = `live-check ${result?.valid && result?.available ? "ok" : result?.message ? "bad" : ""}`;
  el.title = result?.message || "";
}

let validateTimer = null;
function scheduleSignupValidation() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateSignupFields, 250);
}

async function validateSignupFields() {
  const form = $("#signupForm");
  const params = new URLSearchParams({
    email: form.elements.email.value.trim(),
    countryCode: form.elements.countryCode.value,
    phone: form.elements.phone.value.trim()
  });
  const data = await api(`/api/validate/signup?${params.toString()}`);
  setCheck("#emailCheck", data.email);
  setCheck("#phoneCheck", data.phone);
  return data;
}

function validatePasswordFields() {
  const form = $("#signupForm");
  const password = form.elements.password.value;
  const confirm = form.elements.confirmPassword.value;
  let message = "";
  let ok = false;
  if (password.length === 0 && confirm.length === 0) {
    message = "";
  } else if (password.length < 6) {
    message = "Use at least 6 characters";
  } else if (confirm && password !== confirm) {
    message = "Passwords do not match";
  } else if (password.length >= 6 && confirm === password) {
    message = "Password is ready";
    ok = true;
  }
  setCheck("#passwordCheck", { valid: ok, available: ok, message });
  return ok;
}

function render() {
  renderRoleNav();
  document.querySelectorAll("#nav button").forEach(btn => btn.classList.toggle("active", btn.dataset.view === state.view));
  document.querySelectorAll(".view").forEach(view => view.classList.add("hidden"));
  $(`#${state.view}View`).classList.remove("hidden");
  const titles = {
    dashboard: ["Dashboard", "Live working records stored by the backend and mirrored in this browser."],
    samples: ["Samples", "Prepare bottle labels, update storage movement, assign analysis, enter results, and close samples."],
    scan: ["Scan QR", "Use the website scanner or a normal phone QR scanner to open the matching sample record."],
    masters: ["People & Storage", "Add analysts, freezer/rack locations, and water test methods."],
    users: ["Users", "Create admin/manager and analyst logins."],
    backup: ["Data Backup", "Daily and weekly readable exports for lab records and database health."],
    audit: ["Activity Log", "Every important action is retained. Records are modified, not deleted."]
  };
  $("#viewTitle").textContent = titles[state.view][0];
  $("#viewHint").textContent = titles[state.view][1];
  renderSampleDialogOptions();
  renderDashboard();
  renderSamples();
  renderScan();
  renderMasters();
  renderUsers();
  renderBackup();
  renderAudit();
}

function renderDashboard() {
  const waitingBook = state.samples.filter(s => !(s.files || []).some(file => file.category.includes("Book") || file.category.includes("Written Record"))).length;
  const readyForApproval = state.samples.filter(s => ["Results Entered", "Needs Review"].includes(s.status) && (s.results || []).length && (s.files || []).length).length;
  const alerts = state.alerts || {};
  const counts = [
    ["Total", state.samples.length],
    ["Bottle Ready", state.samples.filter(s => s.status === "Bottle Ready").length],
    ["Stored", state.samples.filter(s => s.status === "Stored").length],
    ["In Analysis", state.samples.filter(s => s.status === "In Analysis").length],
    ["Results Entered", state.samples.filter(s => s.status === "Results Entered" || s.status === "Needs Review").length],
    ["Flagged", state.samples.filter(s => s.status === "Flagged").length]
  ];
  $("#dashboardView").innerHTML = `
    <div class="metrics">${counts.map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>
    <section class="alert-grid">
      ${alertCard("Overdue", alerts.overdue?.length || 0, "Past target completion", "bad")}
      ${alertCard("Due Soon", alerts.dueSoon?.length || 0, "Within 24 hours", "warn")}
      ${alertCard("Written Records", alerts.waitingUpload?.length || 0, "Written records pending", "warn")}
      ${alertCard("Approval", alerts.waitingApproval?.length || 0, "Waiting for review", "ok")}
      ${alertCard("Retention", alerts.disposalReady?.length || 0, "Approved samples ready", "ok")}
    </section>
    <section class="workflow">
      <div class="step"><strong>1 Bottle Ready</strong><span>Create QR labels before sampling</span></div>
      <div class="step"><strong>2 Return & Store</strong><span>Update freezer, shelf, rack</span></div>
      <div class="step"><strong>3 Assign Analysis</strong><span>Manager distributes samples</span></div>
      <div class="step"><strong>4 Book To Sheet</strong><span>${waitingBook} written records pending</span></div>
      <div class="step"><strong>5 Close</strong><span>${readyForApproval} ready for approval</span></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3>Recent Samples</h3><button data-jump="samples">Open Samples</button></div>
      <div class="sample-list dashboard-samples">${state.samples.slice(0, 8).map(sampleRow).join("") || empty("No samples yet")}</div>
    </section>
  `;
  document.querySelectorAll("[data-jump]").forEach(btn => btn.onclick = () => switchView(btn.dataset.jump));
  bindSampleRows();
}

function alertCard(label, value, hint, tone) {
  return `<button class="alert-card ${tone}" data-jump="samples"><span>${label}</span><strong>${value}</strong><small>${hint}</small></button>`;
}

function sampleRow(sample) {
  const storage = state.storageLocations.find(item => item.id === sample.storageLocationId)?.name || "No storage";
  return `
    <button class="sample-row ${sample.id === state.selectedId ? "active" : ""}" data-sample="${sample.id}">
      <div class="row-top"><span class="code">${sample.sampleCode}</span><span class="badge ${statusClass(sample.status)}">${sample.status}</span></div>
      <div>${sample.collectionSite || "No site"} - ${sample.clientName || "No client"}</div>
      <div class="meta"><span>${sample.sourceType}</span><span>${storage}</span><span>${sample.assignedTo || "Unassigned"}</span></div>
    </button>
  `;
}

function optionList(values, selected = "") {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
    .map(value => `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${value}</option>`).join("");
}

function storageOption(location, selectedId = "") {
  const full = location.isFull && location.id !== selectedId;
  const label = `${location.name}${location.isFull ? " - FULL" : ""}${location.active === false ? " - INACTIVE" : ""}`;
  return `<option value="${location.id}" ${location.id === selectedId ? "selected" : ""} ${full || location.active === false ? "disabled" : ""}>${label}</option>`;
}

function renderSamples() {
  const sample = selectedSample();
  const rows = filteredSamples();
  if (state.sampleDetailOpen && sample) {
    $("#samplesView").innerHTML = `
      <div class="sample-workspace">
        <section class="panel printable sample-detail-panel">
          ${detailHtml(sample)}
        </section>
      </div>
    `;
    bindDetail();
    return;
  }
  $("#samplesView").innerHTML = `
    <div class="sample-workspace">
      <section class="panel sample-register-panel">
        <div class="sample-register-head">
          <div>
            <span class="eyebrow dark">Sample Register</span>
            <h3>Find and open a sample</h3>
            <p>Filter by date, project, person, analyst, freezer, and lab step.</p>
          </div>
          <div class="register-tools">
            <div class="match-count"><strong id="sampleMatchCount">${rows.length}</strong><span>matching samples</span><small>${state.samples.length} total records</small></div>
            <button type="button" id="resetSampleFilters">Reset Filters</button>
          </div>
        </div>
        ${sampleFiltersHtml()}
        <div class="sample-list register-list" id="sampleList">${rows.map(sampleRow).join("") || empty("No matching samples")}</div>
      </section>
    </div>
  `;
  bindSampleRows();
  const resetSampleFilters = $("#resetSampleFilters");
  if (resetSampleFilters) resetSampleFilters.onclick = () => {
    state.sampleFilters = { q: "", status: "", from: "", to: "", project: "", collector: "", analyst: "", storage: "" };
    renderSamples();
  };
  ["sampleSearch", "sampleStatus", "sampleFrom", "sampleTo", "sampleProject", "sampleCollector", "sampleAnalystFilter", "sampleStorageFilter"].forEach(id => {
    const input = $(`#${id}`);
    if (input) input.oninput = filterSamples;
    if (input) input.onchange = filterSamples;
  });
  bindDetail();
}

function filterSamples() {
  state.sampleFilters = {
    q: $("#sampleSearch").value,
    status: $("#sampleStatus").value,
    from: $("#sampleFrom").value,
    to: $("#sampleTo").value,
    project: $("#sampleProject").value,
    collector: $("#sampleCollector").value,
    analyst: $("#sampleAnalystFilter").value,
    storage: $("#sampleStorageFilter").value
  };
  const rows = filteredSamples();
  $("#sampleMatchCount").textContent = rows.length;
  $("#sampleList").innerHTML = rows.map(sampleRow).join("") || empty("No matching samples");
  bindSampleRows();
}

function sampleFiltersHtml() {
  const f = state.sampleFilters;
  return `
    <div class="filters advanced-filters">
      <input id="sampleSearch" value="${escapeAttr(f.q)}" placeholder="Search code, site, project, brought by">
      <select id="sampleStatus"><option value="">All status</option>${STATUS_OPTIONS.map(s => `<option ${f.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <input id="sampleFrom" type="date" value="${escapeAttr(f.from)}" title="From date">
      <input id="sampleTo" type="date" value="${escapeAttr(f.to)}" title="To date">
      <select id="sampleProject"><option value="">All projects</option>${optionList(state.samples.map(s => s.clientName), f.project)}</select>
      <select id="sampleCollector"><option value="">All brought by</option>${optionList(state.samples.map(s => s.collector), f.collector)}</select>
      <select id="sampleAnalystFilter"><option value="">All analysts</option>${optionList(state.samples.map(s => s.assignedTo), f.analyst)}</select>
      <select id="sampleStorageFilter"><option value="">All storage</option>${state.storageLocations.map(s => `<option value="${s.id}" ${f.storage === s.id ? "selected" : ""}>${s.name}${s.isFull ? " - FULL" : ""}</option>`).join("")}</select>
    </div>
  `;
}

function filteredSamples() {
  const { q, status, project, collector, analyst, storage } = state.sampleFilters;
  const query = String(q || "").toLowerCase();
  const from = state.sampleFilters.from ? new Date(`${state.sampleFilters.from}T00:00:00`).getTime() : 0;
  const to = state.sampleFilters.to ? new Date(`${state.sampleFilters.to}T23:59:59`).getTime() : Infinity;
  const rows = state.samples.filter(sample => {
    const text = [sample.sampleCode, sample.clientName, sample.collectionSite, sample.assignedTo, sample.collector, sample.sourceType].join(" ").toLowerCase();
    const created = new Date(sample.createdAt || sample.receivedAt || 0).getTime();
    return (!query || text.includes(query)) &&
      (!status || sample.status === status) &&
      (!project || sample.clientName === project) &&
      (!collector || sample.collector === collector) &&
      (!analyst || sample.assignedTo === analyst) &&
      (!storage || sample.storageLocationId === storage) &&
      created >= from && created <= to;
  });
  return rows;
}

function selectedSample() {
  return state.samples.find(sample => sample.id === state.selectedId) || state.samples[0];
}

function detailHtml(sample) {
  const storage = state.storageLocations.find(item => item.id === sample.storageLocationId)?.name || "";
  const hasBook = (sample.files || []).some(file => file.category.includes("Book") || file.category.includes("Written Record"));
  const hasResults = (sample.results || []).length > 0;
  const hasStorage = Boolean(sample.storageLocationId);
  const photo = samplePhoto(sample);
  return `
    <div class="panel-head sample-detail-head">
      <button type="button" id="backToSamples" class="ghost-light">Back to register</button>
      <div>
        <h3>${sample.sampleCode}</h3>
        <small>${sample.clientName || "No project"} / ${sample.collectionSite || "No site"}</small>
      </div>
      <span class="badge ${statusClass(sample.status)}">${sample.status}</span>
    </div>
    <div class="panel-body">
      <div class="detail-grid">
        <div class="qr-card">
          ${photo ? `<img class="sample-photo" src="${photo.url}" alt="Sample photo">` : `<div class="photo-placeholder">No sample photo</div>`}
          <img src="${apiUrl(`/api/samples/${sample.id}/qr.svg?token=${encodeURIComponent(state.token)}`)}" alt="QR code">
          <button id="printLabel" class="primary">Print QR Label</button>
          <button id="printReport">Print Report</button>
          <a class="button-link primary-link" href="${apiUrl(`/api/samples/${sample.id}/report.pdf?token=${encodeURIComponent(state.token)}`)}">Download PDF</a>
        </div>
        <div class="facts">
          ${fact("Project / client", sample.clientName)}
          ${fact("Site", sample.collectionSite)}
          ${fact("Source", sample.sourceType)}
          ${fact("Bottle label created", new Date(sample.createdAt || sample.receivedAt).toLocaleString())}
          ${fact("Last updated", new Date(sample.updatedAt || sample.receivedAt).toLocaleString())}
          ${fact("Target completion", sample.dueAt ? new Date(sample.dueAt).toLocaleString() : "-")}
          ${fact("Brought by", sample.collector)}
          ${fact("Analyst", sample.assignedTo || "Unassigned")}
          ${fact("Storage", storage)}
          ${fact("Retention", sample.retentionStatus || "Active")}
          ${fact("Tests", (sample.requestedTests || []).join(", "))}
        </div>
      </div>
      <div class="readiness">
        <span class="${hasStorage ? "done" : "todo"}">Storage ${hasStorage ? "OK" : "Needed"}</span>
        <span class="${hasBook ? "done" : "todo"}">Written record ${hasBook ? "OK" : "Needed"}</span>
        <span class="${hasResults ? "done" : "todo"}">Results ${hasResults ? "OK" : "Needed"}</span>
        <span class="${sample.status === "Approved" ? "done" : "todo"}">Approval ${sample.status === "Approved" ? "Done" : "Pending"}</span>
      </div>
      <div class="tabs">
        ${tabButton("overview", "Workflow")}
        ${canUploadFiles() ? tabButton("book", "Written Record Upload") : ""}
        ${canEnterResults() ? tabButton("sheet", "Result Sheet") : ""}
        ${tabButton("results", "Saved Results")}
        ${canEnterResults() ? tabButton("bulk", "Paste Import") : ""}
        ${canUploadFiles() ? tabButton("uploads", "All Files") : ""}
        ${can("admin") ? tabButton("retention", "Retention / Disposal") : ""}
        ${tabButton("custody", "Storage History")}
      </div>
      ${tabHtml(sample)}
    </div>
  `;
}

function fact(label, value) {
  return `<div class="fact"><span>${label}</span><strong>${value || "-"}</strong></div>`;
}

function samplePhoto(sample) {
  return (sample.files || []).find(file => file.category === "Sample Photo");
}

function tabButton(key, label) {
  return `<button class="${state.tab === key ? "active" : ""}" data-tab="${key}">${label}</button>`;
}

function tabHtml(sample) {
  const allowedTabs = ["overview", "results", "custody"];
  if (canUploadFiles()) allowedTabs.push("book", "uploads");
  if (canEnterResults()) allowedTabs.push("sheet", "bulk");
  if (can("admin")) allowedTabs.push("retention");
  if (!allowedTabs.includes(state.tab)) state.tab = "overview";
  if (state.tab === "book") return bookUploadHtml(sample);
  if (state.tab === "sheet") return sheetHtml(sample);
  if (state.tab === "results") return resultsHtml(sample);
  if (state.tab === "bulk") return bulkHtml(sample);
  if (state.tab === "uploads") return uploadsHtml(sample);
  if (state.tab === "retention") return retentionHtml(sample);
  if (state.tab === "custody") return custodyHtml(sample);
  return overviewHtml(sample);
}

function bookUploadHtml(sample) {
  const bookFiles = (sample.files || []).filter(file => file.category === "Lab Book Photo" || file.category === "Book Scan / Written Record" || file.category === "Written Record Upload");
  return `
    <div class="table">
      <div class="tr th"><div>Written record</div><div>Category</div><div>Uploaded by</div><div>Open</div></div>
      ${bookFiles.map(f => `<div class="tr"><div>${f.originalName}</div><div>${f.category}</div><div>${f.uploadedBy}<br><span class="muted">${new Date(f.uploadedAt).toLocaleString()}</span></div><div><a href="${apiUrl(f.url)}" target="_blank">View</a></div></div>`).join("") || `<div class="panel-body">${empty("No written results uploaded yet")}</div>`}
    </div>
    <form id="bookUploadForm" class="form-grid">
      <input type="hidden" name="category" value="Written Record Upload">
      <label>Upload written results photo / scan / PDF<input name="files" type="file" accept="image/*,.pdf" multiple required></label>
      <button class="primary wide">Upload Written Record</button>
    </form>
  `;
}

function sheetHtml(sample) {
  return `
    <div class="panel-body">
      <div class="data-entry-launch">
        <div>
          <strong>Analysis data entry</strong>
          <span>Open the Excel-style sheet, enter the measured values, then save them to this sample.</span>
        </div>
        <button class="primary" id="openInputData">Input Data</button>
      </div>
      <form id="excelImportForm" class="excel-import panel-line">
        <label>Import existing Excel sheet<input name="file" type="file" accept=".xlsx,.xls" required></label>
        <button class="primary">Import Excel</button>
      </form>
    </div>
  `;
}

function sheetEditorHtml(sample) {
  const requested = sample.requestedTests?.length ? sample.requestedTests : state.tests.slice(0, 5).map(test => test.name);
  return `
    <div class="sheet-actions">
      <button id="addSheetRow">Add Row</button>
    </div>
    <div class="sheet" id="resultSheet">
      <div class="excel-row excel-cols"><div></div><div>A</div><div>B</div><div>C</div><div>D</div><div>E</div><div>F</div></div>
      <div class="excel-row excel-head"><div>1</div><div>Parameter</div><div>Value</div><div>Unit</div><div>Limit</div><div>Method</div><div>Flag</div></div>
      ${requested.map((name, index) => {
        const test = state.tests.find(item => item.name === name) || {};
        return sheetRow({ parameter: name, unit: test.unit || "", limit: test.limit || "", method: test.method || "", flag: "OK" }, index + 2);
      }).join("")}
    </div>
    <div class="sheet-save-row">
      <button class="primary" id="saveSheet">Save Sheet Values</button>
    </div>
  `;
}

function sheetRow(row = {}, rowNumber = "") {
  return `
    <div class="excel-row result-row">
      <div class="row-number">${rowNumber}</div>
      <input data-field="parameter" value="${escapeAttr(row.parameter || "")}" placeholder="pH">
      <input data-field="value" value="${escapeAttr(row.value || "")}" placeholder="7.2">
      <input data-field="unit" value="${escapeAttr(row.unit || "")}" placeholder="mg/L">
      <input data-field="limit" value="${escapeAttr(row.limit || "")}" placeholder="<500">
      <input data-field="method" value="${escapeAttr(row.method || "")}" placeholder="Method">
      <select data-field="flag"><option ${row.flag === "OK" ? "selected" : ""}>OK</option><option ${row.flag === "Review" ? "selected" : ""}>Review</option><option ${row.flag === "Alert" ? "selected" : ""}>Alert</option></select>
    </div>
  `;
}

function bulkHtml(sample) {
  return `
    <div class="form-grid">
      <label class="wide">Copy rows from book, Excel, or instrument text
        <textarea id="bulkRows" placeholder="Parameter, Value, Unit, Limit, Method, Flag&#10;pH, 7.4, pH, 6.5-8.5, Electrometric, OK&#10;TDS, 260, mg/L, &lt;500, Conductivity, OK"></textarea>
      </label>
    </div>
    <button class="primary" id="bulkResult">Import Rows</button>
  `;
}

function overviewHtml(sample) {
  if (!canModifySamples()) {
    return `<div class="panel-body">${empty("This role cannot modify samples.")}</div>`;
  }
  return `
    <div class="workflow-actions">
      <div class="note-card">
        <strong>Current lab step</strong>
        <span>Move the sample through bottle preparation, return/storage, assignment, analysis, result entry, review, and closure. Every update is kept in Storage History and Activity Log.</span>
      </div>
      <div class="quick-actions">
        <button type="button" data-quick-status="Stored">Mark Stored</button>
        <button type="button" data-quick-status="Assigned">Mark Assigned</button>
        <button type="button" data-quick-status="In Analysis">Start Analysis</button>
        <button type="button" data-quick-status="Needs Review">Send For Review</button>
      </div>
    </div>
    <div class="form-grid">
      <label>Lab step<select id="editStatus">${STATUS_OPTIONS.map(s => `<option ${sample.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label>Assigned analyst<select id="editAnalyst"><option value="">Unassigned</option>${state.people.map(p => `<option ${sample.assignedTo === p.name ? "selected" : ""}>${p.name}</option>`).join("")}</select></label>
      <label>Current storage<select id="editStorage"><option value="" ${!sample.storageLocationId ? "selected" : ""}>Not stored yet</option>${state.storageLocations.map(s => storageOption(s, sample.storageLocationId)).join("")}</select></label>
      <label>Target completion<input id="editDueAt" type="datetime-local" value="${dateTimeLocal(sample.dueAt)}"></label>
      <label class="wide">Movement / work note<textarea id="editNotes" placeholder="Example: shifted from Fridge 1 to Fridge 2 after aliquoting">${sample.notes || ""}</textarea></label>
    </div>
    <button class="primary" id="saveSample">Save Workflow Update</button>
    ${can("admin") && sample.status !== "Approved" ? `<button id="approveSample">Approve Results</button>` : ""}
  `;
}

function retentionHtml(sample) {
  const disposal = sample.disposal ? `<div class="note-card"><strong>Disposed</strong><span>${new Date(sample.disposal.disposedAt).toLocaleString()} by ${sample.disposal.disposedBy}. ${sample.disposal.reason || ""}</span></div>` : "";
  return `
    <div class="form-grid">
      <label>Lifecycle action
        <select id="lifecycleAction">
          ${["Active", "Retained", "Disposed"].map(status => `<option ${sample.retentionStatus === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
      </label>
      <label class="wide">Reason / note<textarea id="lifecycleReason" placeholder="Routine retention, final disposal after approval, moved back to active stock"></textarea></label>
    </div>
    ${disposal}
    <button class="primary" id="saveLifecycle">Save Lifecycle</button>
  `;
}

function resultsHtml(sample) {
  const entryForm = canEnterResults() ? `
    <div class="form-grid">
      <label>Parameter<select id="resultParam">${state.tests.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}</select></label>
      <label>Value from analysis<input id="resultValue" placeholder="7.4"></label>
      <label>Unit<input id="resultUnit"></label>
      <label>Limit<input id="resultLimit"></label>
      <label>Method<input id="resultMethod"></label>
      <label>Flag<select id="resultFlag"><option>OK</option><option>Review</option><option>Alert</option></select></label>
    </div>
    <button class="primary" id="addResult">Input Value</button>
  ` : "";
  return `
    <div class="table">
      <div class="tr th"><div>Parameter</div><div>Value</div><div>Limit</div><div>Analyst</div></div>
      ${(sample.results || []).map(r => `<div class="tr"><div>${r.parameter}</div><div>${r.value} ${r.unit}</div><div>${r.limit} <span class="badge ${r.flag === "Alert" ? "Flagged" : r.flag === "Review" ? "Needs-Review" : "Approved"}">${r.flag}</span></div><div>${r.analyst}</div></div>`).join("") || `<div class="panel-body">${empty("No results entered")}</div>`}
    </div>
    ${entryForm}
  `;
}

function uploadsHtml(sample) {
  return `
    <div class="table">
      <div class="tr th"><div>File</div><div>Category</div><div>Uploaded by</div><div>Open</div></div>
      ${(sample.files || []).map(f => `<div class="tr"><div>${f.originalName}</div><div>${f.category}</div><div>${f.uploadedBy}<br><span class="muted">${new Date(f.uploadedAt).toLocaleString()}</span></div><div><a href="${apiUrl(f.url)}" target="_blank">View</a></div></div>`).join("") || `<div class="panel-body">${empty("No files uploaded")}</div>`}
    </div>
    <form id="uploadForm" class="form-grid">
      <label>Upload category<select name="category"><option>Sample Photo</option><option>Written Record Upload</option><option>Instrument Raw Data</option><option>Worksheet</option><option>Final Report</option><option>Storage Movement Record</option></select></label>
      <label>Upload book/data files<input name="files" type="file" multiple required></label>
      <button class="primary wide">Upload To Sample</button>
    </form>
  `;
}

function custodyHtml(sample) {
  return `<div class="timeline">${(sample.chainOfCustody || []).map(item => {
    const from = item.fromLocationId ? state.storageLocations.find(s => s.id === item.fromLocationId)?.name || "Not stored" : "";
    const to = item.toLocationId ? state.storageLocations.find(s => s.id === item.toLocationId)?.name || "Not stored" : state.storageLocations.find(s => s.id === item.locationId)?.name || "";
    const place = from ? `${from} to ${to || "Not stored"}` : to;
    return `<div class="event"><div class="dot"></div><div><strong>${item.action} by ${item.by}</strong><span>${new Date(item.at).toLocaleString()}${place ? " · " + place : ""}${item.note ? " · " + item.note : ""}</span></div></div>`;
  }).join("") || empty("No storage movement recorded yet")}</div>`;
}

function bindSampleRows() {
  document.querySelectorAll("[data-sample]").forEach(btn => btn.onclick = () => {
    state.selectedId = btn.dataset.sample;
    state.view = "samples";
    state.sampleDetailOpen = true;
    render();
  });
}

function bindDetail() {
  const backToSamples = $("#backToSamples");
  if (backToSamples) backToSamples.onclick = () => {
    state.sampleDetailOpen = false;
    render();
  };
  document.querySelectorAll("[data-tab]").forEach(btn => btn.onclick = () => {
    state.tab = btn.dataset.tab;
    render();
  });
  const sample = selectedSample();
  if (!sample) return;
  const printLabel = $("#printLabel");
  if (printLabel) printLabel.onclick = () => window.open(apiUrl(`/api/samples/${sample.id}/tube-label?token=${encodeURIComponent(state.token)}`), "_blank");
  const printReport = $("#printReport");
  if (printReport) printReport.onclick = () => window.open(apiUrl(`/api/samples/${sample.id}/report?token=${encodeURIComponent(state.token)}`), "_blank");
  const saveBtn = $("#saveSample");
  if (saveBtn) saveBtn.onclick = async () => {
    const updated = await api(`/api/samples/${sample.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: $("#editStatus").value,
        assignedTo: $("#editAnalyst").value,
        storageLocationId: $("#editStorage").value,
        dueAt: $("#editDueAt").value ? new Date($("#editDueAt").value).toISOString() : "",
        notes: $("#editNotes").value
      })
    });
    replaceSample(updated);
    await load();
    toast("Sample modified and activity recorded");
  };
  document.querySelectorAll("[data-quick-status]").forEach(button => {
    button.onclick = () => {
      const status = $("#editStatus");
      if (status) status.value = button.dataset.quickStatus;
      if (button.dataset.quickStatus === "Assigned" && $("#editAnalyst")?.value === "") toast("Choose the analyst, then save");
    };
  });
  const approveBtn = $("#approveSample");
  if (approveBtn) approveBtn.onclick = async () => {
    replaceSample(await api(`/api/samples/${sample.id}/approve`, { method: "POST" }));
    await load();
    toast("Sample approved");
  };
  const resultParam = $("#resultParam");
  if (resultParam) {
    resultParam.onchange = fillTestDefaults;
    fillTestDefaults();
  }
  const addResult = $("#addResult");
  if (addResult) addResult.onclick = async () => {
    const updated = await api(`/api/samples/${sample.id}/results`, {
      method: "POST",
      body: JSON.stringify({
        parameter: $("#resultParam").selectedOptions[0].textContent,
        value: $("#resultValue").value,
        unit: $("#resultUnit").value,
        limit: $("#resultLimit").value,
        method: $("#resultMethod").value,
        flag: $("#resultFlag").value
      })
    });
    replaceSample(updated);
    state.tab = "results";
    await load();
    toast("Value entered");
  };
  const bulkResult = $("#bulkResult");
  if (bulkResult) bulkResult.onclick = async () => {
    const updated = await api(`/api/samples/${sample.id}/results/bulk`, {
      method: "POST",
      body: JSON.stringify({ rows: $("#bulkRows").value })
    });
    replaceSample(updated);
    state.tab = "results";
    await load();
    toast("Rows imported");
  };
  const uploadForm = $("#uploadForm");
  if (uploadForm) uploadForm.onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(uploadForm);
    const updated = await api(`/api/samples/${sample.id}/files`, { method: "POST", body: form });
    replaceSample(updated);
    state.tab = "uploads";
    await load();
    toast("File uploaded to sample");
  };
  const bookUploadForm = $("#bookUploadForm");
  if (bookUploadForm) bookUploadForm.onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(bookUploadForm);
    const updated = await api(`/api/samples/${sample.id}/files`, { method: "POST", body: form });
    replaceSample(updated);
    state.tab = "book";
    await load();
    toast("Book record uploaded");
  };
  const openInputData = $("#openInputData");
  if (openInputData) openInputData.onclick = () => openResultSheetDialog(sample);
  const excelImportForm = $("#excelImportForm");
  if (excelImportForm) excelImportForm.onsubmit = safe(async event => {
    event.preventDefault();
    const updated = await api(`/api/samples/${sample.id}/results/excel`, { method: "POST", body: new FormData(excelImportForm) });
    replaceSample(updated);
    state.tab = "results";
    await load();
    toast("Excel sheet imported");
  });
  const saveLifecycle = $("#saveLifecycle");
  if (saveLifecycle) saveLifecycle.onclick = safe(async () => {
    const updated = await api(`/api/samples/${sample.id}/lifecycle`, {
      method: "POST",
      body: JSON.stringify({
        action: $("#lifecycleAction").value,
        reason: $("#lifecycleReason").value
      })
    });
    replaceSample(updated);
    state.tab = "retention";
    await load();
    toast("Lifecycle saved");
  });
}

function openResultSheetDialog(sample) {
  $("#sheetDialogTitle").textContent = `Input Analysis Data - ${sample.sampleCode}`;
  $("#sheetDialogMeta").textContent = `${sample.clientName || "No client"} / ${sample.collectionSite || "No site"}`;
  $("#sheetDialogBody").innerHTML = sheetEditorHtml(sample);
  $("#resultSheetDialog").showModal();
  bindSheetEditor(sample);
}

function bindSheetEditor(sample) {
  const addSheetRow = $("#addSheetRow");
  if (addSheetRow) addSheetRow.onclick = () => {
    const nextRow = document.querySelectorAll(".result-row").length + 2;
    $("#resultSheet").insertAdjacentHTML("beforeend", sheetRow({ flag: "OK" }, nextRow));
  };
  const saveSheet = $("#saveSheet");
  if (saveSheet) saveSheet.onclick = async () => {
    const rows = Array.from(document.querySelectorAll(".result-row")).map(row => {
      const result = {};
      row.querySelectorAll("[data-field]").forEach(input => result[input.dataset.field] = input.value.trim());
      return result;
    }).filter(row => row.parameter && row.value);
    const updated = await api(`/api/samples/${sample.id}/results/sheet`, {
      method: "POST",
      body: JSON.stringify({ rows })
    });
    replaceSample(updated);
    state.tab = "results";
    $("#resultSheetDialog").close();
    await load();
    toast("Sheet values saved");
  };
}

function fillTestDefaults() {
  const test = state.tests.find(t => t.id === $("#resultParam").value);
  if (!test) return;
  $("#resultUnit").value = test.unit || "";
  $("#resultLimit").value = test.limit || "";
  $("#resultMethod").value = test.method || "";
}

function replaceSample(sample) {
  state.samples = state.samples.map(item => item.id === sample.id ? sample : item);
}

function renderScan() {
  $("#scanView").innerHTML = `
    <div class="split">
      <section class="panel">
          <div class="panel-head"><h3>Camera Scanner</h3><span class="badge">QR</span></div>
        <div class="panel-body">
          <video id="scannerVideo" muted playsinline></video>
          <button id="startScanner" class="primary">Start Scanner</button>
          <button id="stopScanner">Stop Scanner</button>
          <small>Use the camera for QR labels. Manual code entry is below as backup.</small>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Open Sample</h3></div>
        <div class="panel-body">
          <label>Sample code or scanned payload<input id="manualCode" placeholder="PL-2026-000001"></label>
          <button id="openCode" class="primary">Open Code</button>
          <div id="scanResult"></div>
          <div class="note-card">
            <strong>Scanner options</strong>
            <span>Use the website camera scanner for bottle QR labels and small tube QR labels. No separate scanner hardware is required; manual code entry remains as backup.</span>
          </div>
        </div>
      </section>
    </div>
  `;
  $("#startScanner").onclick = startScanner;
  $("#stopScanner").onclick = stopScanner;
  $("#openCode").onclick = () => openScanned($("#manualCode").value);
}

async function startScanner() {
  if (!("BarcodeDetector" in window)) {
    toast("This browser needs manual entry or Chrome camera QR support");
    return;
  }
  const video = $("#scannerVideo");
  state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = state.stream;
  await video.play();
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const tick = async () => {
    if (!state.stream) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length) {
        $("#manualCode").value = codes[0].rawValue;
        stopScanner();
        openScanned(codes[0].rawValue);
        return;
      }
    } catch {}
    requestAnimationFrame(tick);
  };
  tick();
}

function stopScanner() {
  if (state.stream) state.stream.getTracks().forEach(track => track.stop());
  state.stream = null;
}

async function openScanned(raw) {
  const code = extractSampleCode(raw);
  if (!code) {
    toast("No sample code found");
    return;
  }
  try {
    const sample = await api(`/api/search-sample/${encodeURIComponent(code)}`);
    state.selectedId = sample.id;
    state.view = "samples";
    state.tab = "overview";
    state.sampleDetailOpen = true;
    render();
    toast("Sample opened from code");
  } catch (error) {
    $("#scanResult").innerHTML = `<div class="panel-body">${error.message}</div>`;
  }
}

function extractSampleCode(raw) {
  let code = String(raw || "").trim();
  try {
    const parsed = JSON.parse(code);
    code = parsed.sampleCode || parsed.id || code;
  } catch {}
  try {
    const url = new URL(code);
    code = url.searchParams.get("sample") || url.searchParams.get("id") || code;
  } catch {}
  return code;
}

async function openUrlSampleOnce() {
  if (state.openedUrlSample) return;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("sample") || params.get("id");
  if (!code) return;
  state.openedUrlSample = true;
  const sample = await api(`/api/search-sample/${encodeURIComponent(code)}`);
  state.selectedId = sample.id;
  state.view = "samples";
  state.tab = "overview";
  state.sampleDetailOpen = true;
  render();
  toast("Sample opened from QR link");
}

function renderMasters() {
  $("#mastersView").innerHTML = `
    <div class="master-grid">
      ${masterCard("People / Analysts", "personForm", [["name","Name"],["role","Role"]], editablePeople(), "Add Person")}
      ${masterCard("Storage Locations", "storageForm", [["name","Location"],["type","Type"],["capacityNote","Capacity note"]], editableStorage(), "Add Storage")}
      ${masterCard("Test Methods", "testForm", [["name","Parameter"],["unit","Unit"],["limit","Limit"],["method","Method"]], editableTests(), "Add Test")}
    </div>
  `;
  bindMaster("personForm", "/api/people");
  bindMaster("storageForm", "/api/storage-locations");
  bindMaster("testForm", "/api/tests");
  bindMasterEdits();
}

function editablePeople() {
  return state.people.map(p => `<div class="mini-row"><input value="${escapeAttr(p.name)}" data-edit="people" data-id="${p.id}" data-field="name"><input value="${escapeAttr(p.role)}" data-edit="people" data-id="${p.id}" data-field="role"><button data-save-master="people" data-id="${p.id}">Save</button></div>`).join("");
}

function editableStorage() {
  return state.storageLocations.map(s => `<div class="mini-row storage-row">
    <input value="${escapeAttr(s.name)}" data-edit="storage-locations" data-id="${s.id}" data-field="name">
    <input value="${escapeAttr(s.type)}" data-edit="storage-locations" data-id="${s.id}" data-field="type">
    <select data-edit="storage-locations" data-id="${s.id}" data-field="isFull"><option value="false" ${!s.isFull ? "selected" : ""}>Available</option><option value="true" ${s.isFull ? "selected" : ""}>Full / no occupancy</option></select>
    <input value="${escapeAttr(s.capacityNote || "")}" data-edit="storage-locations" data-id="${s.id}" data-field="capacityNote" placeholder="Optional note">
    <button data-save-master="storage-locations" data-id="${s.id}">Save</button>
  </div>`).join("");
}

function editableTests() {
  return state.tests.map(t => `<div class="mini-row test"><input value="${escapeAttr(t.name)}" data-edit="tests" data-id="${t.id}" data-field="name"><input value="${escapeAttr(t.unit || "")}" data-edit="tests" data-id="${t.id}" data-field="unit"><input value="${escapeAttr(t.limit || "")}" data-edit="tests" data-id="${t.id}" data-field="limit"><input value="${escapeAttr(t.method || "")}" data-edit="tests" data-id="${t.id}" data-field="method"><button data-save-master="tests" data-id="${t.id}">Save</button></div>`).join("");
}

function bindMasterEdits() {
  document.querySelectorAll("[data-save-master]").forEach(button => {
    button.onclick = safe(async () => {
      const group = button.dataset.saveMaster;
      const id = button.dataset.id;
      const body = {};
      document.querySelectorAll(`[data-edit="${group}"][data-id="${id}"]`).forEach(input => {
        body[input.dataset.field] = input.dataset.field === "isFull" ? input.value === "true" : input.value.trim();
      });
      await api(`/api/${group}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
      toast("Master record modified");
    });
  });
}

function masterCard(title, id, fields, list, button) {
  return `
    <section class="panel">
      <div class="panel-head"><h3>${title}</h3></div>
      <form id="${id}" class="panel-body">
        ${fields.map(([name,label]) => `<label>${label}<input name="${name}" required></label>`).join("")}
        <button class="primary">${button}</button>
        <div class="muted">${list || "No records"}</div>
      </form>
    </section>
  `;
}

function bindMaster(formId, path) {
  const form = $(`#${formId}`);
  if (!form) return;
  form.onsubmit = async event => {
    event.preventDefault();
    await api(path, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    await load();
    toast("Master record added");
  };
}

function renderUsers() {
  const visibleUsers = state.showInactiveUsers ? state.users : state.users.filter(user => user.active);
  $("#usersView").innerHTML = `
    <div class="split">
      <section class="panel">
        <div class="panel-head"><h3>Create User</h3><span class="badge">${roleLabel(state.user?.role)}</span></div>
        <form id="userForm" class="panel-body">
          <label>Name<input name="name" required></label>
          <label>Email<input name="email" type="email" required></label>
          <label>Phone<input name="phone" type="tel" required></label>
          <label>Password<input name="password" type="password" required></label>
          <label>Role<select name="role"><option value="admin">Admin / Manager</option><option value="analyst">Analyst</option></select></label>
          <button class="primary">Create Login</button>
          <small>Only admin can create or modify user access.</small>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>User List</h3><label class="toggle-line"><input id="showInactiveUsers" type="checkbox" ${state.showInactiveUsers ? "checked" : ""}> Show inactive</label></div>
        <div class="table">
          <div class="tr user-tr th"><div>Name</div><div>Email</div><div>Role</div><div>Status</div><div>Action</div></div>
          ${visibleUsers.map(u => `<div class="tr user-tr"><div>${u.name}</div><div>${u.email}<br><span class="muted">${u.countryCode || ""} ${u.phone || ""}</span></div><div><select data-user-role="${u.id}">${WORK_ROLES.map(role => `<option value="${role}" ${u.role === role ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}</select></div><div><select data-user-active="${u.id}"><option value="true" ${u.active ? "selected" : ""}>Active</option><option value="false" ${!u.active ? "selected" : ""}>Inactive</option></select><button data-save-user="${u.id}">Save</button></div><div>${u.id === state.user.id ? `<span class="muted">Current user</span>` : u.active ? `<button class="danger" data-delete-user="${u.id}">Delete</button>` : `<span class="muted">Deleted</span>`}</div></div>`).join("")}
        </div>
      </section>
    </div>
  `;
  const form = $("#userForm");
  $("#showInactiveUsers").onchange = event => {
    state.showInactiveUsers = event.target.checked;
    renderUsers();
  };
  form.onsubmit = safe(async event => {
    event.preventDefault();
    await api("/api/users", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    await load();
    toast("User created");
  });
  document.querySelectorAll("[data-save-user]").forEach(button => {
    button.onclick = safe(async () => {
      const id = button.dataset.saveUser;
      await api(`/api/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: document.querySelector(`[data-user-role="${id}"]`).value,
          active: document.querySelector(`[data-user-active="${id}"]`).value === "true"
        })
      });
      await load();
      toast("User access modified");
    });
  });
  document.querySelectorAll("[data-delete-user]").forEach(button => {
    button.onclick = safe(async () => {
      const user = state.users.find(item => item.id === button.dataset.deleteUser);
      if (!confirm(`Delete login for ${user?.name || "this user"}? Their old records and activity history will remain.`)) return;
      await api(`/api/users/${button.dataset.deleteUser}`, { method: "DELETE" });
      await load();
      toast("User login deleted");
    });
  });
}

function renderBackup() {
  const health = state.health || {};
  $("#backupView").innerHTML = `
    <div class="split">
      <section class="panel">
        <div class="panel-head"><h3>Automatic Exports</h3><span class="badge">Daily / weekly</span></div>
        <div class="panel-body">
          <div class="backup-actions">
            <button class="primary" id="runDailyExport">Create Daily Export Now</button>
            <button id="runWeeklyExport">Create Weekly Export Now</button>
            <button id="downloadReadableNow">Download Current Backup</button>
          </div>
          <div class="table">
            <div class="tr backup-tr th"><div>File</div><div>Type</div><div>Updated</div><div>Size</div><div>Download</div></div>
            ${(state.exports || []).map(file => `
              <div class="tr backup-tr">
                <div>${file.file}</div>
                <div>${file.type}</div>
                <div>${new Date(file.modifiedAt).toLocaleString()}</div>
                <div>${formatBytes(file.size)}</div>
                <div><a href="${apiUrl(`/api/exports/${encodeURIComponent(file.file)}?token=${encodeURIComponent(state.token)}`)}">Download</a></div>
              </div>
            `).join("") || `<div class="panel-body">${empty("No exports yet")}</div>`}
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Database Health</h3><span class="badge Approved">${health.database || "Checking"}</span></div>
        <div class="panel-body">
          <div class="facts">
            ${fact("Samples", health.samples ?? 0)}
            ${fact("Users", health.users ?? 0)}
            ${fact("Activity entries", health.auditEntries ?? 0)}
            ${fact("Uploaded files", health.uploadedFiles ?? 0)}
            ${fact("Database size", formatBytes(health.dbSize || 0))}
            ${fact("Last write", health.lastWriteAt ? new Date(health.lastWriteAt).toLocaleString() : "-")}
          </div>
          <div class="note-card">
            <strong>Current storage mode</strong>
            <span>${health.storage || "Local atomic storage with readable exports."}</span>
          </div>
          <div class="note-card">
            <strong>Scale note</strong>
            <span>This local database is stable for a demo and small lab use with automatic exports. For many users working at the same time or very large historical data, the next production step is PostgreSQL or MySQL on a server with nightly off-machine backups.</span>
          </div>
        </div>
      </section>
    </div>
  `;
  const runDaily = $("#runDailyExport");
  if (runDaily) runDaily.onclick = safe(async () => {
    await api("/api/exports/run", { method: "POST", body: JSON.stringify({ period: "daily" }) });
    await load();
    toast("Daily export created");
  });
  const runWeekly = $("#runWeeklyExport");
  if (runWeekly) runWeekly.onclick = safe(async () => {
    await api("/api/exports/run", { method: "POST", body: JSON.stringify({ period: "weekly" }) });
    await load();
    toast("Weekly export created");
  });
  const downloadNow = $("#downloadReadableNow");
  if (downloadNow) downloadNow.onclick = () => $("#backupBtn").click();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function renderAudit() {
  $("#auditView").innerHTML = `<section class="panel"><div class="panel-head"><h3>Activity Log</h3><span class="badge">${state.audit.length} latest</span></div><div class="panel-body timeline">${state.audit.map(eventRow).join("") || empty("No activity entries")}</div></section>`;
}

function eventRow(item) {
  return `<div class="event"><div class="dot"></div><div><strong>${item.action} · ${item.userName}</strong><span>${new Date(item.at).toLocaleString()} · ${item.entity} ${item.detail ? "· " + item.detail : ""}</span></div></div>`;
}

function empty(text) {
  return `<div class="muted">${text}</div>`;
}

function renderSampleDialogOptions() {
  $("#sampleStorage").innerHTML = `<option value="">Not stored yet</option>${state.storageLocations.map(item => storageOption(item)).join("")}`;
  $("#sampleAnalyst").innerHTML = `<option value="">Unassigned</option>${state.people.map(item => `<option>${item.name}</option>`).join("")}`;
  renderSampleTestPicker();
  const bulkDefaultStorage = $("#bulkDefaultStorage");
  if (bulkDefaultStorage) bulkDefaultStorage.innerHTML = `<option value="">Not stored yet</option>${state.storageLocations.map(item => storageOption(item)).join("")}`;
}

function renderSampleTestPicker() {
  const picker = $("#sampleTestPicker");
  const chips = $("#selectedTests");
  if (!picker || !chips) return;
  const available = state.tests.map(item => item.name).filter(name => !state.selectedRequestedTests.includes(name));
  picker.innerHTML = `<option value="">Select and add test</option>${available.map(name => `<option>${name}</option>`).join("")}`;
  chips.innerHTML = state.selectedRequestedTests.map(name => `
    <button type="button" class="test-chip" data-remove-test="${escapeAttr(name)}">
      <span>${name}</span><strong aria-hidden="true">X</strong>
    </button>
  `).join("") || `<span class="muted">No tests selected</span>`;
  picker.onchange = () => {
    if (!picker.value || state.selectedRequestedTests.includes(picker.value)) return;
    state.selectedRequestedTests.push(picker.value);
    renderSampleTestPicker();
  };
  chips.querySelectorAll("[data-remove-test]").forEach(button => {
    button.onclick = () => {
      state.selectedRequestedTests = state.selectedRequestedTests.filter(name => name !== button.dataset.removeTest);
      renderSampleTestPicker();
    };
  });
}

function switchView(view) {
  state.view = view;
  if (view !== "scan") stopScanner();
  render();
}

function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function dateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function parseDateIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function parseBulkSampleRows(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(row => row.trim())
    .filter(Boolean)
    .filter((row, index) => index > 0 || !row.toLowerCase().startsWith("client,"))
    .map(row => row.split(/,|\t/).map(cell => cell.trim()))
    .map(cells => {
      const storage = state.storageLocations.find(item => item.id === cells[4] || item.name.toLowerCase() === String(cells[4] || "").toLowerCase());
      return {
        clientName: cells[0] || "",
        sourceType: cells[1] || "Drinking Water",
        collectionSite: cells[2] || "",
        collector: cells[3] || "",
        storageLocationId: storage?.id || $("#bulkDefaultStorage")?.value || "",
        assignedTo: cells[5] || "",
        requestedTests: String(cells[6] || "").split(/[,;]/).map(item => item.trim()).filter(Boolean),
        dueAt: parseDateIso(cells[7]),
        notes: cells[8] || ""
      };
    });
}

function renderBulkResult(created = [], errors = []) {
  $("#bulkCreateResult").innerHTML = `
    <div class="bulk-summary">
      <strong>${created.length} samples created</strong>
      ${created.length ? `<button type="button" id="printBulkTubeLabels">Print QR Labels</button>` : ""}
      ${created.length ? `<button type="button" id="downloadBulkList">Download Batch List</button>` : ""}
    </div>
    <div class="sample-list mini">${created.map(sampleRow).join("")}</div>
    ${errors.length ? `<div class="note-card bad"><strong>${errors.length} rows need correction</strong><span>${errors.map(item => `Row ${item.row}: ${item.error}`).join("<br>")}</span></div>` : ""}
  `;
  bindSampleRows();
  const printBulkTubeLabels = $("#printBulkTubeLabels");
  if (printBulkTubeLabels) printBulkTubeLabels.onclick = () => {
    const ids = created.map(sample => sample.id).join(",");
    window.open(apiUrl(`/api/samples/bulk-tube-qr-labels?ids=${encodeURIComponent(ids)}&token=${encodeURIComponent(state.token)}`), "_blank");
  };
  const downloadBulkList = $("#downloadBulkList");
  if (downloadBulkList) downloadBulkList.onclick = () => {
    const csv = ["Sample Code,Client,Site,Storage,Analyst"].concat(created.map(sample => [
      sample.sampleCode,
      sample.clientName,
      sample.collectionSite,
      state.storageLocations.find(item => item.id === sample.storageLocationId)?.name || "",
      sample.assignedTo || ""
    ].map(value => `"${String(value).replaceAll('"', '""')}"`).join(","))).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sample-batch-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
}

$("#loginForm").onsubmit = safe(async event => {
  event.preventDefault();
  const form = event.target;
  const body = Object.fromEntries(new FormData(form));
  const remember = Boolean(body.rememberMe);
  body.rememberMe = remember;
  const data = await api("/api/login", { method: "POST", body: JSON.stringify(body) });
  state.token = data.token;
  if (remember) {
    localStorage.setItem("plasma-lab-token", state.token);
    localStorage.setItem("plasma-lab-remember-email", form.elements.email.value.trim());
  } else {
    sessionStorage.setItem("plasma-lab-token", state.token);
    localStorage.removeItem("plasma-lab-token");
    localStorage.removeItem("plasma-lab-remember-email");
  }
  showApp();
  await load();
});

$("#sendEmailOtp").onclick = safe(async () => {
  const form = $("#signupForm");
  const checks = await validateSignupFields();
  if (!checks.email.valid || !checks.email.available) throw new Error(checks.email.message || "Enter a valid email");
  const data = await api("/api/signup/email/start", {
    method: "POST",
    body: JSON.stringify({
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim()
    })
  });
  state.pendingSignupId = data.pendingId;
  renderOtpDemo("#emailOtpDemo", data);
  $("#emailOtpBox").classList.remove("hidden");
  toast("Email OTP sent");
});

$("#verifyEmailOtp").onclick = safe(async () => {
  await api("/api/signup/email/verify", {
    method: "POST",
    body: JSON.stringify({
      pendingId: state.pendingSignupId,
      emailOtp: $("#signupForm").elements.emailOtp.value
    })
  });
  setSignupStep("phone");
  toast("Email verified");
});

$("#savePhone").onclick = safe(async () => {
  const form = $("#signupForm");
  const checks = await validateSignupFields();
  if (!checks.phone.valid || !checks.phone.available) throw new Error(checks.phone.message || "Enter a valid phone number");
  await api("/api/signup/phone/save", {
    method: "POST",
    body: JSON.stringify({
      pendingId: state.pendingSignupId,
      countryCode: form.elements.countryCode.value,
      phone: form.elements.phone.value.trim()
    })
  });
  setSignupStep("password");
  toast("Phone saved");
});

$("#resendEmailOtp").onclick = safe(async () => {
  if (!state.pendingSignupId) throw new Error("Enter email and click Verify Email first");
  const data = await api("/api/signup/resend", { method: "POST", body: JSON.stringify({ pendingId: state.pendingSignupId, channel: "email" }) });
  renderOtpDemo("#emailOtpDemo", data);
  toast("Email OTP resent");
});

$("#signupForm").onsubmit = safe(async event => {
  event.preventDefault();
  const form = event.target;
  if (!validatePasswordFields()) throw new Error("Check the password fields");
  const body = {
    password: form.elements.password.value,
    confirmPassword: form.elements.confirmPassword.value
  };
  body.pendingId = state.pendingSignupId;
  const data = await api("/api/signup/complete", { method: "POST", body: JSON.stringify(body) });
  event.target.reset();
  state.pendingSignupId = "";
  showAuthSlide("login");
  $("#loginForm").elements.email.value = data.user.email;
  $("#loginForm").elements.password.value = "";
  toast("Registration complete. Please login.");
});

$("#resetStartForm").onsubmit = safe(async event => {
  event.preventDefault();
  const data = await api("/api/password-reset/start", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
  state.resetId = data.resetId;
  renderOtpDemo("#resetOtpDemo", data);
  showAuthSlide("resetConfirm");
  toast("Reset OTP generated");
});

$("#resetConfirmForm").onsubmit = safe(async event => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  body.resetId = state.resetId;
  await api("/api/password-reset/confirm", { method: "POST", body: JSON.stringify(body) });
  event.target.reset();
  showAuthSlide("login");
  toast("Password changed. Login with the new password.");
});

["email", "phone", "countryCode"].forEach(name => {
  const field = $("#signupForm").elements[name];
  field.addEventListener("input", scheduleSignupValidation);
  field.addEventListener("change", scheduleSignupValidation);
});

["password", "confirmPassword"].forEach(name => {
  const field = $("#signupForm").elements[name];
  field.addEventListener("input", validatePasswordFields);
});

$("#logoutBtn").onclick = () => {
  stopScanner();
  clearSession();
  showAuth();
};

$("#syncBtn").onclick = safe(async () => {
  await load();
  toast("Synced from backend");
});

$("#backupBtn").onclick = safe(async () => {
  const response = await fetch(apiUrl("/api/backup"), { headers: { Authorization: `Bearer ${state.token}` } });
  if (!response.ok) throw new Error("Backup could not be downloaded");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `plasma-lab-readable-backup-${new Date().toISOString().slice(0, 10)}.html`;
  link.click();
  URL.revokeObjectURL(url);
  await load();
  toast("Backup downloaded");
});

$("#newSampleBtn").onclick = () => {
  state.selectedRequestedTests = [];
  renderSampleDialogOptions();
  $("#sampleDialog").showModal();
};
$("#bulkSampleBtn").onclick = () => {
  renderSampleDialogOptions();
  $("#bulkCreateResult").innerHTML = "";
  $("#bulkSampleDialog").showModal();
};
document.querySelector("[data-close]").onclick = () => $("#sampleDialog").close();
document.querySelector("[data-close-bulk]").onclick = () => $("#bulkSampleDialog").close();
document.querySelector("[data-close-sheet]").onclick = () => $("#resultSheetDialog").close();
$("#createBulkSamples").onclick = safe(async event => {
  event.preventDefault();
  const rows = parseBulkSampleRows($("#bulkSampleRows").value);
  const result = await api("/api/samples/bulk", { method: "POST", body: JSON.stringify({ rows }) });
  await load();
  renderBulkResult(result.created, result.errors);
  toast(`${result.created.length} samples created`);
});
$("#importBulkExcel").onclick = safe(async () => {
  const file = $("#bulkSampleExcel").files[0];
  if (!file) throw new Error("Choose an Excel file");
  const form = new FormData();
  form.append("file", file);
  form.append("storageLocationId", $("#bulkDefaultStorage").value);
  const result = await api("/api/samples/bulk/excel", { method: "POST", body: form });
  await load();
  renderBulkResult(result.created, result.errors);
  toast(`${result.created.length} samples imported`);
});
$("#sampleForm").onsubmit = safe(async event => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const photoFile = formData.get("samplePhoto");
  formData.delete("samplePhoto");
  const data = Object.fromEntries(formData);
  data.requestedTests = state.selectedRequestedTests;
  if (!data.requestedTests.length) throw new Error("Choose at least one requested test");
  const sample = await api("/api/samples", { method: "POST", body: JSON.stringify(data) });
  if (photoFile && photoFile.size > 0) {
    const upload = new FormData();
    upload.append("category", "Sample Photo");
    upload.append("files", photoFile);
    await api(`/api/samples/${sample.id}/files`, { method: "POST", body: upload });
  }
  state.selectedId = sample.id;
  state.view = "samples";
  state.tab = "overview";
  state.sampleDetailOpen = true;
  $("#sampleDialog").close();
  event.target.reset();
  state.selectedRequestedTests = [];
  await load();
  toast("Sample registered and QR created");
});

window.addEventListener("unhandledrejection", event => {
  toast(event.reason?.message || "Action failed");
});

$("#nav").onclick = event => {
  const button = event.target.closest("button[data-view]");
  if (button) switchView(button.dataset.view);
};

document.querySelectorAll("[data-auth]").forEach(link => {
  link.onclick = event => {
    event.preventDefault();
    showAuthSlide(link.dataset.auth);
  };
});

document.querySelectorAll("[data-toggle-password]").forEach(button => {
  button.onclick = () => {
    const input = button.closest(".password-field")?.querySelector("input");
    if (!input) return;
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    button.classList.toggle("visible", hidden);
    button.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
  };
});

const rememberedEmail = localStorage.getItem("plasma-lab-remember-email");
if (rememberedEmail) {
  $("#loginForm").elements.email.value = rememberedEmail;
  $("#loginForm").elements.rememberMe.checked = true;
}

if (state.token) {
  showApp();
  load().catch(() => {
    clearSession();
    showAuth();
  });
}
