# Deployment: GitHub Pages + Cloudflare Worker + Neon

Use this setup:

- **Frontend**: GitHub Pages, serving the `public/` folder.
- **Backend**: Cloudflare Worker.
- **Database**: Neon PostgreSQL.
- **File storage**: Cloudflare R2 is recommended for uploaded photos, PDFs, and records.

GitHub Pages cannot run backend code. Cloudflare Worker will provide the `/api/...` backend.

## Current Live URLs

- Frontend: `https://vishwasprabhakara.github.io/plasma_lab_lims/`
- Backend API: `https://plasma-lab-lims-api.vishwas-borewellworkersdev.workers.dev`

The frontend is wired through `public/config.js`.

## 1. Create Neon PostgreSQL

1. Go to Neon.
2. Create a new project.
3. Copy the pooled PostgreSQL connection string.

It will look like:

```bash
postgresql://USER:PASSWORD@HOST.neon.tech/DATABASE?sslmode=require
```

This will be the Worker secret:

```text
DATABASE_URL
```

## 2. Create Cloudflare Worker Backend

Install Wrangler in the Worker project:

```bash
npm install -D wrangler
```

Login:

```bash
npx wrangler login
```

Set Worker secrets:

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put JWT_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SMTP_FROM
```

Use these Worker environment variables:

```text
FRONTEND_PUBLIC_URL=https://vishwasprabhakara.github.io/plasma_lab_lims/
ALLOWED_ORIGINS=https://vishwasprabhakara.github.io
SMTP_FROM_NAME=Plasma Lab LIMS
```

Cloudflare Workers cannot use Gmail SMTP directly because Workers do not provide raw SMTP/TCP sockets for Nodemailer. For online OTP email, use `RESEND_API_KEY` plus `SMTP_FROM`, or add a Gmail Apps Script bridge URL as `GMAIL_APPS_SCRIPT_URL`.

Deploy:

```bash
npx wrangler deploy
```

The Worker backend URL will look like:

```text
https://plasma-lab-lims-api.YOUR_SUBDOMAIN.workers.dev
```

## 3. Configure GitHub Pages Frontend

Edit:

```text
public/config.js
```

Set the Cloudflare Worker API URL:

```js
window.PLASMA_LIMS_CONFIG = {
  API_BASE: "https://plasma-lab-lims-api.vishwas-borewellworkersdev.workers.dev"
};
```

Then publish the `public/` folder with GitHub Pages.

## 4. QR Code Behavior

After the Worker backend is deployed with `FRONTEND_PUBLIC_URL`, newly printed QR labels should contain:

```text
https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME/?sample=PL-2026-000043
```

So a normal phone camera opens the sample page directly.

Old QR labels printed before this change may still show JSON. Reprint those QR labels after deployment.

## 5. File Uploads

Small uploaded photos/scans are accepted by the Worker and stored in Neon as data URLs for the current demo. For heavier real lab use, uploaded sample photos, written records, PDFs, and raw data should move to:

```text
Cloudflare R2
```

## 6. Current Migration Coverage

Implemented online:

1. Login, admin-created users, role checks, remember-me token expiry.
2. Signup and password-reset API routes, with HTTP email-provider support.
3. Users, people, storage, tests, samples, bulk sample creation, storage movement, lifecycle, approvals.
4. Result entry, pasted bulk result entry, Excel-like sheet result entry.
5. QR SVG, tube-size QR label printing, and bulk tube QR label printing.
6. Search-by-sample QR flow: phone camera opens the GitHub Pages sample URL.
7. Readable backup export and database health view.

Still recommended next:

1. Move uploaded files from Neon data URLs to Cloudflare R2.
2. Add a true PDF generation service if final signed PDF files are required.
3. Add Hyperdrive in front of Neon for production-scale PostgreSQL pooling.
