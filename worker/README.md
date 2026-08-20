# Cloudflare Worker Backend

This folder is the Cloudflare Worker backend target for Plasma Lab LIMS.

Current status:

- Worker backend is deployed and connected to Neon PostgreSQL.
- Core LIMS endpoints are implemented for online use.
- Small uploads are stored in Neon for the demo; move production files to R2.

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
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SMTP_FROM
```

Optional Gmail bridge:

```bash
npx wrangler secret put GMAIL_APPS_SCRIPT_URL
```

Gmail SMTP app passwords cannot be used directly by a Cloudflare Worker. Use an HTTP email provider such as Resend, or a Gmail Apps Script web app that accepts `to`, `otp`, and `subject`.

Update `wrangler.jsonc`:

```jsonc
"FRONTEND_PUBLIC_URL": "https://vishwasprabhakara.github.io/plasma_lab_lims/",
"ALLOWED_ORIGINS": "https://vishwasprabhakara.github.io"
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
  API_BASE: "https://plasma-lab-lims-api.vishwas-borewellworkersdev.workers.dev"
};
```
