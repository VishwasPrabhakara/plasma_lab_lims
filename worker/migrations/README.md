# Plasma Lab LIMS — D1 migration

This is **Phase 1** of the Neon → Cloudflare D1 migration. It sets up the
target D1 database with a normalized schema and provides a one-time script
to move your existing data over.

Nothing goes live yet — the Worker still reads/writes Neon. Phase 2 will
flip the Worker's reads and writes to D1 (separate commit).

## What you'll do (about 15 minutes)

### 1. Create the D1 database

```powershell
cd D:\Plasma_lab_lims\worker
npx wrangler d1 create plasma-lab-lims
```

Copy the `database_id` from the output. Open `wrangler.jsonc` and paste it in
place of `REPLACE_WITH_D1_ID_AFTER_wrangler_d1_create`.

### 2. Create the R2 bucket for photos + archives

```powershell
npx wrangler r2 bucket create plasma-lab-lims-media
```

(No copy-paste needed — the binding just uses the name.)

### 3. Apply the schema

```powershell
npx wrangler d1 execute plasma-lab-lims --remote --file=./migrations/0001_initial_schema.sql
```

This creates the tables in your D1 database. It's idempotent — safe to re-run.

### 4. Export your current Neon data → seed.sql

You need your Neon connection string. Get it from Cloudflare dashboard →
Workers & Pages → plasma-lab-lims-api → Settings → Variables → `DATABASE_URL`.

```powershell
$env:DATABASE_URL = "postgres://user:pass@ep-something.neon.tech/dbname?sslmode=require"
cd worker\migrations
node migrate-neon-to-d1.mjs > seed.sql
```

You now have `seed.sql` with every user, sample, result, file, and audit
event as D1 INSERT statements. Open it and skim to confirm the last line
says something like `-- Migration complete. Rows: users=3, samples=6, ...`

### 5. Load the seed into D1

```powershell
npx wrangler d1 execute plasma-lab-lims --remote --file=./migrations/seed.sql
```

D1 has a batch size limit (~1000 statements per file); if the command
complains "too many statements", split the file with `head -n 500` /
`tail -n +501` and run each part.

### 6. Verify the data arrived

```powershell
npx wrangler d1 execute plasma-lab-lims --remote --command="SELECT COUNT(*) FROM samples;"
npx wrangler d1 execute plasma-lab-lims --remote --command="SELECT COUNT(*) FROM users;"
npx wrangler d1 execute plasma-lab-lims --remote --command="SELECT key, value FROM meta;"
```

Numbers should match what your Neon DB has.

### 7. Redeploy the Worker (no code change yet)

```powershell
npx wrangler deploy
```

The Worker now has a `DB` binding pointing at D1 and a `MEDIA` binding
pointing at R2, but it's still reading from Neon. Phase 2 (next commit)
will start using them.

---

## Rolling back

D1 is a separate database — Phase 1 doesn't touch Neon. To roll back:
- Do nothing. Neon is untouched.
- Delete the D1 database: `wrangler d1 delete plasma-lab-lims`
- Remove the `d1_databases`, `r2_buckets`, and `triggers` blocks from
  `wrangler.jsonc` and redeploy.

Nothing breaks in production during Phase 1 — the Worker doesn't yet know
about D1.

---

## Phase 2 preview (next commit)

Every function in `worker/src/index.js` that currently calls `readDb(env)` /
`writeDb(env, db)` will be rewritten to run SQL against `env.DB`. Endpoint
signatures don't change — the frontend keeps working. You'll do one more
`npx wrangler deploy` and the flip is done.

## Phase 3 preview

Sample photos move from base64 in the DB to R2 objects. The Worker will
still return the same URL shape to the frontend, but the bytes come from
R2. Old base64 rows keep working (fallback).

## Phase 4 preview

Admin "Archive samples older than N months" action. Bundles the eligible
samples + their results + custody + audit + photos into a single JSON+ZIP
stored in R2. Admin downloads, then a separate "Purge archived batch"
button deletes the rows from D1 to reclaim space. A monthly cron trigger
emails the admin when a batch is ready to review.
