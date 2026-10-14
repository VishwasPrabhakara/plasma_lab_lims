// Single mutable state singleton. Every module that reads or writes state
// imports this one object. Views render from it; mutations call render()
// (the central redraw function kept in app.js).
//
// For a demo-sized app this beats a reactive store — it's one object with
// predictable shape, no diffing cost, and every pending field is explicit.

import { STORAGE_KEYS } from "./config.js";

export const state = {
  // Token lives in sessionStorage only — closing the browser signs out.
  // Legacy localStorage tokens from older builds are ignored and cleared.
  token: sessionStorage.getItem(STORAGE_KEYS.token) || "",
  user: null,

  // Server data
  users: [],
  people: [],
  storageLocations: [],
  tests: [],
  samples: [],
  audit: [],
  alerts: null,
  exports: [],
  health: null,

  // UI
  selectedId: "",
  view: "dashboard",
  tab: "overview",
  stream: null,
  sampleDetailOpen: false,
  openedUrlSample: false,
  sampleFilters: {
    q: "", status: "", from: "", to: "",
    project: "", collector: "", analyst: "", storage: "",
    showArchived: false
  },
  auditFilters: { q: "", user: "", action: "", from: "", to: "" },
  showInactiveUsers: false,

  // Form state
  pendingSignupId: "",
  resetId: "",
  selectedRequestedTests: [],
  bulkRowwise: [],
  selectedSamples: new Set(),

  // Dialog callbacks (promise resolvers)
  pendingConfirm: null,
  pendingApproval: null,
  pendingReject: null,

  // Scanner
  fullScannerOpen: false,
  scannerStream: null,

  // Me sheet
  meSheetOpen: false
};

// Reset every mutable slice (used on sign-out). Keeps the shape.
export function clearSessionState() {
  try { localStorage.removeItem(STORAGE_KEYS.token); } catch {}
  try { sessionStorage.removeItem(STORAGE_KEYS.token); } catch {}
  state.token = "";
  state.user = null;
  state.users = [];
  state.people = [];
  state.storageLocations = [];
  state.tests = [];
  state.samples = [];
  state.audit = [];
  state.alerts = null;
  state.exports = [];
  state.health = null;
  state.selectedId = "";
  state.sampleDetailOpen = false;
  state.selectedSamples = new Set();
  state.selectedRequestedTests = [];
  state.bulkRowwise = [];
  state.pendingConfirm = null;
  state.pendingApproval = null;
  state.pendingReject = null;
}
