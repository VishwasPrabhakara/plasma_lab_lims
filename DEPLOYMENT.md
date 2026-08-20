# Deployment: GitHub Pages + Cloudflare Worker + Neon

Use this setup:

- **Frontend**: GitHub Pages, serving the `public/` folder.
- **Backend**: Cloudflare Worker.
- **Database**: Neon PostgreSQL.
- **File storage**: Cloudflare R2 is recommended for uploaded photos, PDFs, and records.

GitHub Pages cannot run backend code. Cloudflare Worker will provide the `/api/...` backend.

## Important Current Status

The current working backend is `server.js`, which is an Express/Node backend.

Cloudflare Workers do **not** run Express servers, local filesystem storage, `multer`, or `pdfkit` in the same way. So the backend must be migrated from `server.js` into a Worker API.

The frontend is already prepared for a separate backend through:

```text
public/config.js
```

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
npx wrangler secret put SMTP_USER
npx wrangler secret put SMTP_PASS
```

Use these Worker environment variables:

```text
FRONTEND_PUBLIC_URL=https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME
ALLOWED_ORIGINS=https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME
SMTP_FROM=your-gmail@gmail.com
SMTP_FROM_NAME=Plasma Lab LIMS
```

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
  API_BASE: "https://plasma-lab-lims-api.YOUR_SUBDOMAIN.workers.dev"
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

The current local backend stores uploaded files in:

```text
uploads/
```

Cloudflare Workers do not have permanent local disk. For online deployment, uploaded sample photos, written records, PDFs, and raw data should move to:

```text
Cloudflare R2
```

## 6. Recommended Migration Order

1. Keep GitHub Pages frontend.
2. Create Worker API.
3. Move auth/login/signup/OTP endpoints first.
4. Move samples, storage, users, and results endpoints.
5. Move QR label generation.
6. Move file uploads to R2.
7. Move reports/PDF generation last, or generate printable HTML reports instead of PDF inside Worker.
