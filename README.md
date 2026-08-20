# Plasma Lab LIMS

A working local LIMS-style website for bottle preparation, QR labels, sample storage movement, analyst assignment, written-result uploads, Excel-style result entry, final reports, retention/disposal, and role-based access.

## Run

1. Open a terminal in this folder.
2. Run `npm start`.
3. Open `http://localhost:4317`.

For online hosting with GitHub Pages frontend, AWS backend, and AWS RDS PostgreSQL, see `DEPLOYMENT.md`.

Default admin login:

- Email: `admin@lab.local`
- Password: `admin123`

## Main Workflow

1. Login as admin.
2. Add people, storage locations, and test methods from **People & Storage**.
3. Prepare bottle labels from **New Sample**, or many bottle/sample labels from **Bulk Samples**.
4. Print QR labels. The default print label is the compact tube-size QR label.
5. When samples return, open the sample and update freezer/shelf/rack storage from **Workflow**. Each movement is recorded from old storage to new storage.
6. Admin/manager assigns samples to analysts from **Workflow**.
7. Analysts use **Written Record Upload** to attach written result photos, scans, or PDFs.
8. Analysts use **Result Sheet** to enter values in an Excel-like grid, or import an existing Excel result sheet.
9. Use **Saved Results** to review values.
10. Admin/manager approves final results and downloads the PDF report.
11. Admin/manager uses **Retention / Disposal** to mark samples active, retained, or disposed.
12. Use **Data Backup** to download daily/weekly readable exports.
13. Every important change remains in **Activity Log**.

## Roles

- **Admin / Manager**: creates samples, bulk labels, users, storage locations, test methods, assignments, approvals, backups, and disposal.
- **Analyst**: updates assigned samples, changes storage when samples move, uploads written records/files, and enters or imports results. Analysts cannot delete users or records.

## Storage Occupancy

Storage locations can be marked **Available** or **Full / no occupancy** from **People & Storage**. Full freezers remain visible but are disabled in sample creation and movement lists, so staff cannot accidentally move a sample into a freezer with no space.

## Bulk Sample Creation

Use **Bulk Samples** when many bottles or tubes arrive together.

Paste rows with this order:

`Project, Source Type, Site, Brought By, Storage, Analyst, Tests, Target Completion, Notes`

Example:

`Project A, Drinking Water, Borewell 1, Ramesh, Fridge 1 / Shelf A / Rack 01, Priya Nair, pH; TDS; Turbidity, 2026-08-20 17:00, Morning batch`

After creation, use **Print QR Labels** to print the compact tube-size labels for the whole batch.

## QR Scanning

The website camera scanner reads QR labels in supported browsers. This keeps the workflow low-cost because the lab can use printed QR labels and an existing phone/laptop camera. Manual sample-code entry is still available as backup.

A normal phone QR scanner is also enough. Set `FRONTEND_PUBLIC_URL` before starting the backend, for example `https://yourname.github.io/plasma-lab-lims`, and newly printed QR labels will open `?sample=PL-...` links directly instead of showing JSON.

## Remember Me

The login page has **Remember me on this device**. When selected, the browser remembers the email and keeps the secure login session longer. The app does not save the raw password; use the browser's built-in password manager if staff want password autofill.

## Email OTP Setup

Email OTP uses Gmail SMTP when `SMTP_USER` and `SMTP_PASS` are set.

Optional settings:

- `SMTP_HOST`, default `smtp.gmail.com`
- `SMTP_PORT`, default `465`
- `SMTP_SECURE`, default `true`
- `SMTP_USER`, your Gmail address
- `SMTP_PASS`, your Gmail app password
- `SMTP_FROM`
- `SMTP_FROM_NAME`

If Gmail SMTP is not set, email OTP runs in local mode and prints the OTP in the server terminal only.

## Stored Data

- Main local database: `data/db.json`
- Online database: PostgreSQL when `DATABASE_URL` is set
- Automatic local database backups: `data/backups/`
- Daily and weekly readable exports: `data/exports/`
- Uploaded files: `uploads/`
- Browser mirror cache: local browser storage

The local database uses atomic writes, rotating raw backups, and daily/weekly readable exports. For online hosting, set `DATABASE_URL` to use PostgreSQL. For very large long-term data, the next upgrade is a fully normalized PostgreSQL schema with managed backups.
