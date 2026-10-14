// Permission checks that run inside route handlers. These never read from
// D1 — they take the already-fetched user and sample rows.

import { httpError } from "./http.js";

export function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw httpError("Not allowed", 403);
}

export function canReadSample(user, sample) {
  if (user.role === "admin") return true;
  if (user.role === "analyst") return sample.active !== false && !sample.archived_at;
  return false;
}

// assignedTo may hold two analyst names, comma-separated
// ("Amrutha Shanbhag, Anshika M"). An analyst can work on the sample if
// their name appears in the list — this is the lab's two-person replicate
// flow: 2 replicates by one analyst, 1 by another.
export function assignedNames(sample) {
  return String(sample?.assigned_to || sample?.assignedTo || "")
    .split(",").map(s => s.trim()).filter(Boolean);
}

export function canWorkOnSample(user, sample) {
  if (user.role === "admin") return true;
  if (user.role === "analyst") return assignedNames(sample).includes(user.name);
  return false;
}

// Validate incoming assignedTo string: trim, dedupe, cap at 2 analysts.
export function normalizeAssignedTo(v) {
  const names = String(v || "").split(",").map(x => x.trim()).filter(Boolean);
  const unique = [...new Set(names)];
  if (unique.length > 2) {
    throw httpError("At most 2 analysts can be assigned to a sample", 400);
  }
  return unique.join(", ");
}
