-- Everything this service is allowed to know.
--
-- Note what is absent: no workspace names, no table names, no cells. The
-- account layer knows who is signed in, which plan they hold and how many MCP
-- calls they made. If a change here needs a column for anything from somebody's
-- tables, the change is wrong.

-- No customer id column. Polar keys customers by `externalCustomerId`, and we
-- give it this table's `id`, so the mapping is the account id itself — nothing
-- to store, and nothing that can drift out of sync with Polar.
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  account_id      TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  polar_id        TEXT NOT NULL UNIQUE,
  -- Polar's own vocabulary, stored verbatim rather than mapped on the way in:
  -- mapping early loses the distinction between "past_due" and "canceled",
  -- which is the difference between chasing a card and letting someone go.
  status          TEXT NOT NULL,
  seats           INTEGER NOT NULL DEFAULT 1,
  current_period_end TIMESTAMPTZ,
  -- When this row was last confirmed against Polar. Reconcile-on-read uses
  -- it to decide whether to re-read before signing a claim.
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sign-in codes, alive for ten minutes. Expiry is enforced by every read
-- filtering on `expires_at > now()`, so a row that outlives its window is
-- already useless; deleting it is housekeeping. The code is hashed for the same
-- reason refresh tokens are.
CREATE TABLE IF NOT EXISTS sign_in_codes (
  code_sha256     TEXT PRIMARY KEY,
  challenge       TEXT NOT NULL,
  email           TEXT,
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sign_in_codes_expiry ON sign_in_codes(expires_at);

-- Long-lived, per machine. Hashed: a leaked database should not hand anybody a
-- working token, and the raw value is never needed again after it is issued.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_sha256    TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS refresh_tokens_account ON refresh_tokens(account_id);

-- One row per account per ISO week. The app sends a running total and the
-- larger value wins, so a lost request costs nothing and a replayed one is
-- harmless.
CREATE TABLE IF NOT EXISTS usage (
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  week            TEXT NOT NULL,
  mcp_calls       BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, week)
);

-- Polar retries, so the same event arrives more than once. Keyed by the
-- delivery id from the `webhook-id` header so handling is idempotent: a
-- duplicate must not upgrade twice.
CREATE TABLE IF NOT EXISTS handled_events (
  event_id        TEXT PRIMARY KEY,
  handled_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
