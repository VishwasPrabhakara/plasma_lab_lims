-- Bootstrap flag — replaces the COUNT(users)=0 race for first-admin creation.
--
-- Before 0004, /signup/complete decided the first-user admin path by
-- SELECT COUNT(*) FROM users. Two concurrent requests could both see 0 and
-- both auto-approve as admin. Routes/auth.js now reads a `meta` flag
-- instead and writes it after the first user is created.
--
-- The `meta` table already exists (migration 0001). This migration only
-- seeds the flag so an existing deployment with users is already in the
-- "bootstrap complete" state after the migration runs.

INSERT OR IGNORE INTO meta (key, value, updated_at)
  SELECT 'bootstrap_completed', '1', '1970-01-01T00:00:00Z'
  WHERE EXISTS (SELECT 1 FROM users LIMIT 1);
