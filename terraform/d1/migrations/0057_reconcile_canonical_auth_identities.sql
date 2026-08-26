-- Consolidate the Better Auth registry (auth_users/auth_accounts) into the
-- canonical identity registry (users/user_identities) — issue #1290, hard
-- cutover. After this migration Better Auth persists directly into the
-- canonical tables through the custom adapter; the parallel registry (and the
-- entire class of cross-registry drift it created) ceases to exist.
--
-- Identity data is never deleted by the fold: auth rows either merge into
-- their same-id canonical row, become new canonical users, or are skipped by
-- a guard and superseded (see step 5's comment). The only dropped state is
-- ephemeral (sessions of unfoldable strands, in-flight OAuth handshakes) and
-- the emptied auth tables themselves.
--
-- OPERATOR PREFLIGHT (before the deploy that applies this migration): capture
-- a D1 Time Travel bookmark (`wrangler d1 time-travel info <db>`) — it is the
-- rollback for the entire cutover — and record these counts:
--   -- auth rows that will merge into an existing canonical row:
--   SELECT COUNT(*) FROM auth_users a WHERE EXISTS
--     (SELECT 1 FROM users u WHERE u.id = a.id);
--   -- auth rows that will become new canonical users:
--   SELECT COUNT(*) FROM auth_users a
--   WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.id)
--     AND NOT EXISTS (SELECT 1 FROM users u
--       WHERE lower(trim(u.email)) = lower(trim(a.email)));
--   -- unfoldable strands (email owned by a different canonical user; their
--   -- next sign-in re-links onto that owner via implicit linking):
--   SELECT COUNT(*) FROM auth_users a
--   WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.id)
--     AND EXISTS (SELECT 1 FROM users u
--       WHERE lower(trim(u.email)) = lower(trim(a.email)));
--   -- canonical users receiving the one-time backlog verify:
--   SELECT COUNT(*) FROM users
--   WHERE email IS NOT NULL AND length(trim(email)) > 0;

-- (1) The canonical user table becomes Better Auth's user model: add the
-- verification column. Write discipline from here on: 1 is written by
-- completed OAuth proof at sign-in, by ingress from email-attesting
-- providers (Slack/Linear — platform-verified mailboxes fetched server-side
-- by first-party bots; EMAIL_ATTESTING_PROVIDERS in db/user-store.ts), and
-- by this migration's one-time reviewed backlog verify (step 6). All other
-- attribution writes 0. This column is the implicit-linking gate
-- (requireLocalEmailVerified).
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0
  CHECK (email_verified IN (0, 1));

-- (2) The identity table becomes Better Auth's account model: add the OAuth
-- credential columns (ciphertext — Better Auth encrypts above the adapter
-- with its own secret) and updatedAt. All nullable: bot-created identities
-- carry no credentials.
ALTER TABLE user_identities ADD COLUMN access_token TEXT;
ALTER TABLE user_identities ADD COLUMN refresh_token TEXT;
ALTER TABLE user_identities ADD COLUMN id_token TEXT;
ALTER TABLE user_identities ADD COLUMN access_token_expires_at INTEGER;
ALTER TABLE user_identities ADD COLUMN refresh_token_expires_at INTEGER;
ALTER TABLE user_identities ADD COLUMN scope TEXT;
ALTER TABLE user_identities ADD COLUMN password TEXT;
ALTER TABLE user_identities ADD COLUMN updated_at INTEGER;

-- (3) Normalize legacy canonical emails so Better Auth's exact-match email
-- lookups (always lowercased) can find them. OR IGNORE: two whitespace
-- variants normalizing to one value collide under idx_users_email — the
-- loser keeps its legacy form and is findable by identity subject.
UPDATE OR IGNORE users
SET email = lower(trim(email))
WHERE email IS NOT NULL AND email <> lower(trim(email));

-- (4) Same-id merge, auth row → canonical row.
-- (4a) A NULL-email canonical row acquires its auth row's verified email,
-- guarded against any other normalized owner (OR IGNORE nets the
-- intra-statement whitespace-variant case so no drift state can abort the
-- Terraform deploy).
UPDATE OR IGNORE users
SET email = (
    SELECT lower(trim(auth_users.email)) FROM auth_users WHERE auth_users.id = users.id
  )
WHERE users.email IS NULL
  AND EXISTS (SELECT 1 FROM auth_users WHERE auth_users.id = users.id)
  AND NOT EXISTS (
    SELECT 1
    FROM users AS other
    WHERE other.id <> users.id
      AND lower(trim(other.email)) = (
        SELECT lower(trim(auth_users.email)) FROM auth_users WHERE auth_users.id = users.id
      )
  );

-- (4b) Profile backfill where the canonical row is missing it.
UPDATE users
SET
  display_name = coalesce(
    display_name,
    (SELECT nullif(trim(auth_users.name), '') FROM auth_users WHERE auth_users.id = users.id)
  ),
  avatar_url = coalesce(
    avatar_url,
    (SELECT auth_users.image FROM auth_users WHERE auth_users.id = users.id)
  )
WHERE EXISTS (SELECT 1 FROM auth_users WHERE auth_users.id = users.id);

-- (5) Auth rows with no same-id canonical row become canonical users — they
-- are real (web-first) registrations. The email-owner guard skips the strand
-- class: a partial graph from a failed registration whose email belongs to a
-- different canonical user. Skipped strands are SUPERSEDED, not migrated —
-- and not deleted by any runtime job: after the cutover the affected
-- person's sign-in misses on subject (their account row below is FK-skipped
-- the same way), falls back to their verified email, and implicit linking
-- lands them on the canonical owner — the row that owns their history. The
-- preflight count above sizes this class before the deploy.
INSERT INTO users (
  id,
  display_name,
  email,
  avatar_url,
  created_at,
  updated_at,
  email_verified
)
SELECT
  auth_users.id,
  nullif(trim(auth_users.name), ''),
  lower(trim(auth_users.email)),
  auth_users.image,
  coalesce(
    CAST(strftime('%s', auth_users.createdAt) AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  coalesce(
    CAST(strftime('%s', auth_users.updatedAt) AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  auth_users.emailVerified
FROM auth_users
WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = auth_users.id)
  AND NOT EXISTS (
    SELECT 1 FROM users WHERE lower(trim(users.email)) = lower(trim(auth_users.email))
  )
-- Deploy-abort safety net for intra-statement collisions.
ON CONFLICT DO NOTHING;

-- (6) One-time backlog verify (reviewed via the preflight count): every
-- emailed canonical user existing at cutover is treated as verified — they
-- are legacy verified sign-ins or the enumerated bot-attributed backlog.
-- This is what unlocks the #1290 lockouts: without it, the implicit-linking
-- gate would refuse every pre-cutover user's first web sign-in. Post-cutover
-- verification comes only from OAuth proof at sign-in and attesting ingress
-- (step 1's write discipline).
UPDATE users
SET email_verified = 1
WHERE email_verified = 0
  AND email IS NOT NULL
  AND length(trim(email)) > 0;

-- (7) Fold auth_accounts into user_identities.
-- (7a) Same-owner subjects that already have an identity row: graft the OAuth
-- credentials onto it (losing them would silently disconnect the live GitHub
-- credential path). Cross-owner subjects — the same provider subject owned by
-- different users in each registry — are deliberately not grafted:
-- credentials never move between users.
UPDATE user_identities
SET
  access_token = (
    SELECT auth_accounts.accessToken FROM auth_accounts
    WHERE auth_accounts.providerId = user_identities.provider
      AND auth_accounts.accountId = user_identities.provider_user_id
  ),
  refresh_token = (
    SELECT auth_accounts.refreshToken FROM auth_accounts
    WHERE auth_accounts.providerId = user_identities.provider
      AND auth_accounts.accountId = user_identities.provider_user_id
  ),
  id_token = (
    SELECT auth_accounts.idToken FROM auth_accounts
    WHERE auth_accounts.providerId = user_identities.provider
      AND auth_accounts.accountId = user_identities.provider_user_id
  ),
  access_token_expires_at = (
    SELECT CAST(strftime('%s', auth_accounts.accessTokenExpiresAt) AS INTEGER) * 1000
    FROM auth_accounts
    WHERE auth_accounts.providerId = user_identities.provider
      AND auth_accounts.accountId = user_identities.provider_user_id
  ),
  refresh_token_expires_at = (
    SELECT CAST(strftime('%s', auth_accounts.refreshTokenExpiresAt) AS INTEGER) * 1000
    FROM auth_accounts
    WHERE auth_accounts.providerId = user_identities.provider
      AND auth_accounts.accountId = user_identities.provider_user_id
  ),
  scope = (
    SELECT auth_accounts.scope FROM auth_accounts
    WHERE auth_accounts.providerId = user_identities.provider
      AND auth_accounts.accountId = user_identities.provider_user_id
  ),
  updated_at = (
    SELECT coalesce(
      CAST(strftime('%s', auth_accounts.updatedAt) AS INTEGER) * 1000,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000
    )
    FROM auth_accounts
    WHERE auth_accounts.providerId = user_identities.provider
      AND auth_accounts.accountId = user_identities.provider_user_id
  )
WHERE access_token IS NULL
  AND EXISTS (
    SELECT 1
    FROM auth_accounts
    WHERE auth_accounts.providerId = user_identities.provider
      AND auth_accounts.accountId = user_identities.provider_user_id
      AND auth_accounts.userId = user_identities.user_id
  );

-- (7b) Accounts with no identity row become identity rows (credentials
-- carried). The users join is FK safety: accounts of step-5-skipped strands
-- are superseded with their auth row.
INSERT INTO user_identities (
  id,
  user_id,
  provider,
  provider_user_id,
  provider_login,
  provider_email,
  provider_issuer,
  created_at,
  access_token,
  refresh_token,
  id_token,
  access_token_expires_at,
  refresh_token_expires_at,
  scope,
  password,
  updated_at
)
SELECT
  auth_accounts.id,
  auth_accounts.userId,
  auth_accounts.providerId,
  auth_accounts.accountId,
  NULL,
  NULL,
  IIF(
    auth_accounts.providerId = 'github',
    'https://github.com',
    IIF(auth_accounts.providerId = 'google', 'https://accounts.google.com', NULL)
  ),
  coalesce(
    CAST(strftime('%s', auth_accounts.createdAt) AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  auth_accounts.accessToken,
  auth_accounts.refreshToken,
  auth_accounts.idToken,
  CAST(strftime('%s', auth_accounts.accessTokenExpiresAt) AS INTEGER) * 1000,
  CAST(strftime('%s', auth_accounts.refreshTokenExpiresAt) AS INTEGER) * 1000,
  auth_accounts.scope,
  auth_accounts.password,
  coalesce(
    CAST(strftime('%s', auth_accounts.updatedAt) AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  )
FROM auth_accounts
JOIN users ON users.id = auth_accounts.userId
WHERE NOT EXISTS (
    SELECT 1
    FROM user_identities
    WHERE user_identities.provider = auth_accounts.providerId
      AND user_identities.provider_user_id = auth_accounts.accountId
  )
ON CONFLICT DO NOTHING;

-- (8) Sessions stay Better Auth-owned but re-key onto canonical users
-- (SQLite requires a table recreate to change the FK) and move to epoch-ms
-- INTEGER timestamps like every other adapter-served table. Sessions whose
-- auth user was superseded in step 5 are dropped with it — one sign-out for
-- exactly the users whose graphs were superseded.
CREATE TABLE auth_sessions_next (
  id          TEXT NOT NULL PRIMARY KEY,
  expiresAt   INTEGER NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL,
  ipAddress   TEXT,
  userAgent   TEXT,
  userId      TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO auth_sessions_next (
  id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId
)
SELECT
  auth_sessions.id,
  CAST(strftime('%s', auth_sessions.expiresAt) AS INTEGER) * 1000,
  auth_sessions.token,
  coalesce(
    CAST(strftime('%s', auth_sessions.createdAt) AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  coalesce(
    CAST(strftime('%s', auth_sessions.updatedAt) AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  auth_sessions.ipAddress,
  auth_sessions.userAgent,
  auth_sessions.userId
FROM auth_sessions
JOIN users ON users.id = auth_sessions.userId
WHERE auth_sessions.expiresAt IS NOT NULL
  AND CAST(strftime('%s', auth_sessions.expiresAt) AS INTEGER) * 1000 IS NOT NULL;

DROP TABLE auth_sessions;

ALTER TABLE auth_sessions_next RENAME TO auth_sessions;

CREATE INDEX auth_sessions_userId_idx ON auth_sessions(userId);

-- (9) OAuth-state verifications are ephemeral (10-minute handshake state):
-- recreate empty on epoch-ms INTEGER columns. An OAuth flow in flight across
-- the deploy fails once and is retried by the user.
DROP TABLE auth_verifications;

CREATE TABLE auth_verifications (
  id          TEXT NOT NULL PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  expiresAt   INTEGER NOT NULL,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL
);

CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);

-- (10) The parallel registry is gone. Rollback for the cutover window is the
-- preflight Time Travel bookmark. Drop order respects the accounts→users FK.
DROP TABLE auth_accounts;

DROP TABLE auth_users;
