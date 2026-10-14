// Role-adaptive navigation definitions and section titles.
// Separate from the renderer so the two can evolve independently (new nav
// items are a one-line edit here).

export const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard",         roles: ["admin", "analyst"], icon: "grid",  section: "Work" },
  { id: "samples",   label: "Samples",           roles: ["admin", "analyst"], icon: "file",  section: "Work" },
  { id: "scan",      label: "Scan QR",           roles: ["admin", "analyst"], icon: "scan",  section: "Work" },
  { id: "approvals", label: "Approvals",         roles: ["admin"],            icon: "check", section: "Work", badgeKey: "waitingApproval" },
  { id: "masters",   label: "People & Storage",  roles: ["admin"],            icon: "users", section: "Admin" },
  { id: "users",     label: "Users",             roles: ["admin"],            icon: "user",  section: "Admin" },
  { id: "backup",    label: "Data Backup",       roles: ["admin"],            icon: "db",    section: "Admin" },
  { id: "audit",     label: "Activity Log",      roles: ["admin"],            icon: "log",   section: "Admin" }
];

export const ICONS = {
  grid:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  file:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v4l4 4v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V11l4-4z"/></svg>',
  scan:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="7" width="4" height="4"/><rect x="7" y="13" width="4" height="4"/><path d="M13 13h4v4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  user:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  db:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
  log:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>'
};

export const TITLES = {
  dashboard: ["Dashboard", "Live records held by the backend and mirrored in this browser."],
  samples:   ["Samples", "Prepare bottle labels, update storage, assign, enter results and close samples."],
  approvals: ["Approval queue", "Samples waiting for review."],
  scan:      ["Scan QR", "Use the camera to open a sample, or type the code manually."],
  masters:   ["People & Storage", "Analysts, freezer/rack locations, and test methods."],
  users:     ["Users", "Create admin and analyst logins."],
  backup:    ["Data Backup", "Daily and weekly readable exports and database health."],
  audit:     ["Activity Log", "Every important action is retained — never modified or deleted."]
};
