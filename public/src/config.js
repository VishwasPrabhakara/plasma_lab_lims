// Runtime config. The one value that changes between environments
// (API_BASE) comes in through window.PLASMA_LIMS_CONFIG, set by
// public/config.js on each deploy. Everything else is a true constant.

const RUNTIME = window.PLASMA_LIMS_CONFIG || {};

export const API_BASE = String(RUNTIME.API_BASE || "").replace(/\/$/, "");

// Lifecycle: the UI shows a strip of 7 "normal path" statuses; the DB may
// also hold off-strip states (Flagged, Disposed, Results Entered) that render
// outside the strip.
export const STATUS_OPTIONS = [
  "Bottle Ready", "Sample Collected", "Stored", "Assigned", "In Analysis",
  "Results Entered", "Needs Review", "Approved", "Flagged", "Disposed"
];

export const LIFECYCLE_STRIP = [
  "Bottle Ready", "Sample Collected", "Stored", "Assigned", "In Analysis",
  "Needs Review", "Approved"
];

export const STORAGE_KEYS = Object.freeze({
  token: "plasma-lab-token",
  rememberEmail: "plasma-lab-remember-email",
  customPanels: "plasma-lims-custom-panels"
});
