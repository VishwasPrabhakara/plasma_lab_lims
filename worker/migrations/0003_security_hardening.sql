-- Security hardening (OTP brute-force + rate-limit + bootstrap flag)
--
-- OTP attempts counter + lockout window on both OTP-bearing tables.
-- `last_sent_at` lets us enforce a 60s resend cooldown without touching
-- expires_at (which is already a logical TTL).
--
-- `rate_limits` is a tiny KV table used by auth routes to rate-limit by
-- IP + identifier. Each row = one bucket; a bucket is "window_start +
-- interval_s wide". A bucket is only ever rewritten by the same key, so
-- there is no cleanup critical path — old rows are overwritten in place
-- and the stragglers are harmless.

ALTER TABLE users             ADD COLUMN email_otp_attempts     INTEGER DEFAULT 0;
ALTER TABLE users             ADD COLUMN email_otp_locked_until TEXT;
ALTER TABLE pending_signups   ADD COLUMN email_otp_attempts     INTEGER DEFAULT 0;
ALTER TABLE pending_signups   ADD COLUMN email_otp_locked_until TEXT;
ALTER TABLE pending_signups   ADD COLUMN last_sent_at           TEXT;
ALTER TABLE pending_signups   ADD COLUMN daily_sent_count       INTEGER DEFAULT 0;
ALTER TABLE pending_signups   ADD COLUMN daily_sent_date        TEXT;
ALTER TABLE password_resets   ADD COLUMN email_otp_attempts     INTEGER DEFAULT 0;
ALTER TABLE password_resets   ADD COLUMN email_otp_locked_until TEXT;
ALTER TABLE password_resets   ADD COLUMN last_sent_at           TEXT;

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,     -- e.g. "login:ip:1.2.3.4" or "login:email:alice@x"
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,         -- ISO ts; bucket resets after interval_s
  last_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
