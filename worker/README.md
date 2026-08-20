# Cloudflare Worker Backend

This folder is the Cloudflare Worker backend target for Plasma Lab LIMS.

Current status:

- Worker deployment scaffold is ready.
- `/api/health` is implemented.
- Full LIMS endpoints still need to be migrated from `../server.js`.

## Setup

```bash
cd D:\plasma_lab_lims\worker
npm install
npx wrangler login
```

Set secrets:

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put JWT_SECRET
npx wrangler secret put SMTP_USER
npx wrangler secret put SMTP_PASS
```

Update `wrangler.jsonc`:

```jsonc
"FRONTEND_PUBLIC_URL": "https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME",
"ALLOWED_ORIGINS": "https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME"
```

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

After deployment, update:

```text
D:\plasma_lab_lims\public\config.js
```

Set:

```js
window.PLASMA_LIMS_CONFIG = {
  API_BASE: "https://plasma-lab-lims-api.YOUR_SUBDOMAIN.workers.dev"
};
```
