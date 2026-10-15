# Product Truth — Plasma Lab LIMS

**Mission.** Plasma Lab at the Centre for Sustainable Technologies (CST), IISc Bengaluru, works on cold plasma applications for energy, wastewater, and medicine. This LIMS (Laboratory Information Management System) is the digital backbone for their wastewater treatment, quality analysis, and recycling operations.

**Purpose.** Replace manual Excel workbooks and fragmented communication with an end-to-end, trustworthy sample lifecycle tracker.

**Core Invariants.**
- **Immutable Audit Trail:** Every write (login, result entry, approval) must be recorded in the `audit_log`.
- **Chain of Custody:** Every movement or status change must land in `chain_of_custody` via a D1 batch.
- **No Hard Deletes:** Sample data is never deleted; it is archived or marked as "Disposed".
- **Approval Ceremony:** Final approval requires a re-authentication signature from an admin.

**Users.**
- **Admins:** Manage lab metadata, approve signups, and perform final sample approval.
- **Analysts:** Perform testing and enter replicate data. Two analysts are often assigned to one sample for replicate validation.
- **Collectors:** Field staff who register samples and capture GPS/timestamps on-site.

**Design Mode.** Operate. The UI must feel like a monitoring station—clean, precise, and authoritative.
