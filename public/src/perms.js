// Client-side permission checks. These mirror the Worker's checks so the UI
// disables controls the server would refuse — never a substitute for the
// server check, which is authoritative.

import { state } from "./state.js";

export function can(...roles) {
  return !!(state.user && roles.includes(state.user.role));
}

export function canModifySamples() { return can("admin", "analyst"); }
export function canEnterResults()  { return can("admin", "analyst"); }
export function canUploadFiles()   { return can("admin", "analyst"); }
export function canApprove()       { return can("admin"); }

// assignedTo may hold multiple names, comma-separated. An analyst can work
// on the sample if their name appears in that list — the lab's two-person
// replicate workflow (2 reps by analyst A + 1 rep by B).
export function assignedList(sample) {
  return String(sample?.assignedTo || "")
    .split(",").map(s => s.trim()).filter(Boolean);
}

export function canWorkOn(sample) {
  if (!sample) return false;
  if (can("admin")) return true;
  if (can("analyst")) return assignedList(sample).includes(state.user?.name);
  return false;
}

// All assignable analyst names (People roster ∪ active approved admin/analyst users).
export function allAnalystNames() {
  const set = new Set();
  (state.people || []).forEach(p => { if (p.name) set.add(p.name); });
  (state.users || []).forEach(u => {
    if (u.active
      && u.approvalStatus !== "pending"
      && u.approvalStatus !== "rejected"
      && ["admin", "analyst"].includes(u.role)
      && u.name
    ) {
      set.add(u.name);
    }
  });
  return [...set].sort((a, b) => a.localeCompare(b));
}
