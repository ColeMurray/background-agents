-- Reconcile the canonical identity registry (users/user_identities) with the
-- Better Auth registry (auth_users/auth_accounts) after the cutover left them
-- disjoint (issue #1290). Not a re-run of 0049: every statement here guards on
-- the unique key it can actually collide with, so the migration completes
-- against post-cutover drift instead of aborting the deploy.
--
-- OPERATOR PREFLIGHT (before the deploy that applies this migration): step
-- (1) below cascade-deletes stranded zero-account auth graphs. Capture a D1
-- Time Travel bookmark (`wrangler d1 time-travel info <db>`) and record
-- preflight counts for review:
--   SELECT COUNT(*) FROM auth_users a WHERE NOT EXISTS (SELECT 1 FROM
--     auth_accounts x WHERE x.userId = a.id) AND EXISTS (SELECT 1 FROM users u
--     WHERE u.id <> a.id AND lower(trim(u.email)) = lower(trim(a.email)));
--   SELECT COUNT(*) FROM users u WHERE u.email IS NOT NULL AND NOT EXISTS
--     (SELECT 1 FROM auth_users a WHERE a.id = u.id);
--   SELECT COUNT(*) FROM auth_users WHERE emailVerified = 0;
-- Post-deploy, run the identity consistency report (it doubles as this
-- migration's postcondition suite); treat the first R4 result set as the
-- backlog merge work list.
--
-- Ordering is load-bearing: the sweep (1) clears the UNIQUE-collision space
-- for the drift repair (2), and (2) runs before account seeding (5) so
-- repaired reservations are classified while still zero-account.

-- (1) Sweep stranded partial auth graphs. Better Auth's D1 fallback is
-- non-atomic, so a failed sign-in strands an auth user whose normalized email
-- is owned by a different canonical user. Only ZERO-ACCOUNT rows are swept:
-- once a row bears OAuth accounts it is a live sign-in target — Better Auth
-- is authoritative for it regardless of email disagreement (the same rule as
-- step (2)), and deleting it would cascade away real accounts and sessions.
-- Account-bearing collisions are preserved and surface in the consistency
-- report (R2 drift when a same-id canonical row exists, R3 account-bearing
-- strand otherwise, R5 for the canonical user whose email they reserve) as
-- operator merge work. Foreign keys cascade the swept rows' sessions; the
-- affected user recovers through implicit linking on their next sign-in.
-- The same-id guard protects whitespace-variant email pairs (idx_users_email
-- is COLLATE NOCASE but not whitespace-normalizing, so two canonical users
-- can normalize to one email): an auth row whose OWN canonical user matches
-- its normalized email is healthy, not stranded, and must survive.
DELETE FROM auth_users
WHERE NOT EXISTS (
    SELECT 1
    FROM auth_accounts
    WHERE auth_accounts.userId = auth_users.id
  )
  AND EXISTS (
    SELECT 1
    FROM users
    WHERE users.id <> auth_users.id
      AND lower(trim(users.email)) = lower(trim(auth_users.email))
  )
  AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE users.id = auth_users.id
      AND lower(trim(users.email)) = lower(trim(auth_users.email))
  );

-- (2) Repair same-id email drift on zero-account rows: the canonical email
-- wins while the reservation has never been linked. Account-bearing drift is
-- deliberately left alone — Better Auth is authoritative once accounts exist,
-- and the R2 consistency report flags those pairs for operator review. The
-- sweep above removed zero-account strands holding the canonical email; an
-- account-bearing row may still hold it, which the other-owner guard below
-- skips (into R2) instead of colliding on auth_users.email's UNIQUE.
-- OR IGNORE: the other-owner guard sees only pre-statement state, so two
-- whitespace-variant canonical emails normalizing to one value could still
-- collide intra-statement; the skipped row surfaces in R2 instead of
-- aborting the deploy.
UPDATE OR IGNORE auth_users
SET
  email = (
    SELECT lower(trim(users.email))
    FROM users
    WHERE users.id = auth_users.id
  ),
  emailVerified = 1,
  updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
    SELECT 1
    FROM users
    WHERE users.id = auth_users.id
      AND users.email IS NOT NULL
      AND length(trim(users.email)) > 0
      AND lower(trim(users.email)) <> auth_users.email
  )
  AND NOT EXISTS (
    SELECT 1
    FROM auth_accounts
    WHERE auth_accounts.userId = auth_users.id
  )
  -- Belt-and-braces for whitespace-variant canonical emails the sweep now
  -- preserves: never move onto an email another auth row still holds — a
  -- failing statement here would abort the deploy.
  AND NOT EXISTS (
    SELECT 1
    FROM auth_users AS other
    WHERE other.id <> auth_users.id
      AND other.email = (
        SELECT lower(trim(users.email)) FROM users WHERE users.id = auth_users.id
      )
  );

-- (3) Seed missing auth_users rows for emailed canonical users, guarded on
-- both unique keys (id, and normalized email — idx_users_email is COLLATE
-- NOCASE but not whitespace-normalizing, so trim-collisions are possible).
-- emailVerified = 1 is the one-time backlog exception to proof-only
-- verification: these emails are legacy verified sign-ins or the enumerated
-- post-cutover bot-attributed backlog, reviewed via preflight counts.
INSERT INTO auth_users (
  id,
  name,
  email,
  emailVerified,
  image,
  createdAt,
  updatedAt
)
SELECT
  users.id,
  coalesce(nullif(trim(users.display_name), ''), lower(trim(users.email))),
  lower(trim(users.email)),
  1,
  users.avatar_url,
  strftime('%Y-%m-%dT%H:%M:%fZ', users.created_at / 1000.0, 'unixepoch'),
  strftime('%Y-%m-%dT%H:%M:%fZ', users.updated_at / 1000.0, 'unixepoch')
FROM users
WHERE users.email IS NOT NULL
  AND length(trim(users.email)) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM auth_users
    WHERE auth_users.id = users.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM auth_users
    WHERE auth_users.email = lower(trim(users.email))
  )
-- The guards see only pre-statement state; two whitespace-variant canonical
-- users normalizing to one email would collide intra-statement without this.
-- A skipped canonical user has no auth row, so R2's same-id join cannot see
-- it — the R5 email-reservation report enumerates exactly this state (their
-- normalized email held by a different auth user) instead of aborting the
-- deploy.
ON CONFLICT DO NOTHING;

-- (4) Verify the backlog: unverified reservations whose email matches their
-- canonical user were seeded by 0049 (or reserved before this design) and are
-- exactly the rows implicit linking needs to accept.
UPDATE auth_users
SET emailVerified = 1
WHERE emailVerified = 0
  AND EXISTS (
    SELECT 1
    FROM users
    WHERE users.id = auth_users.id
      AND lower(trim(users.email)) = auth_users.email
  );

-- (5) Seed accounts from sign-in identities, guarded on the enforced unique
-- key (providerId, accountId) alone — 0049 guarded on (providerId, accountId,
-- userId), which lets a pre-existing split pass the guard and abort on
-- idx_auth_accounts_provider_identity. A subject already owned by a different
-- auth user is deliberately skipped; the R4 report enumerates it as merge
-- work. The auth_users join keeps the account FK-safe.
INSERT INTO auth_accounts (
  id,
  accountId,
  providerId,
  userId,
  accessToken,
  refreshToken,
  idToken,
  accessTokenExpiresAt,
  refreshTokenExpiresAt,
  scope,
  password,
  createdAt,
  updatedAt
)
SELECT
  user_identities.id,
  user_identities.provider_user_id,
  user_identities.provider,
  user_identities.user_id,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    user_identities.created_at / 1000.0,
    'unixepoch'
  ),
  strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    user_identities.created_at / 1000.0,
    'unixepoch'
  )
FROM user_identities
JOIN auth_users
  ON auth_users.id = user_identities.user_id
WHERE (
    (
      user_identities.provider = 'github'
      AND user_identities.provider_issuer = 'https://github.com'
    )
    OR (
      user_identities.provider = 'google'
      AND user_identities.provider_issuer = 'https://accounts.google.com'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM auth_accounts
    WHERE auth_accounts.providerId = user_identities.provider
      AND auth_accounts.accountId = user_identities.provider_user_id
  )
-- Deploy-abort safety net: any unforeseen collision skips instead of failing
-- the Terraform apply; skipped rows surface in the consistency report.
ON CONFLICT DO NOTHING;

-- (6) Backfill user_identities from auth_accounts (the one-time half of the
-- forward bridge), guarded on the enforced (provider, provider_user_id)
-- unique key and joined to users — a canonical-less auth strand would
-- otherwise violate user_identities.user_id's foreign key and abort the
-- deploy. Skipped strands land in the R3 report.
INSERT INTO user_identities (
  id,
  user_id,
  provider,
  provider_user_id,
  provider_login,
  provider_email,
  provider_issuer,
  created_at
)
SELECT
  lower(hex(randomblob(16))),
  auth_accounts.userId,
  auth_accounts.providerId,
  auth_accounts.accountId,
  NULL,
  NULL,
  IIF(
    auth_accounts.providerId = 'github',
    'https://github.com',
    'https://accounts.google.com'
  ),
  -- strftime returns NULL for an unparseable createdAt, which would violate
  -- user_identities.created_at NOT NULL and abort the deploy (a NOT NULL
  -- failure is outside the ON CONFLICT net). Fall back to now.
  coalesce(
    CAST(strftime('%s', auth_accounts.createdAt) AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  )
FROM auth_accounts
JOIN users
  ON users.id = auth_accounts.userId
WHERE auth_accounts.providerId IN ('github', 'google')
  AND NOT EXISTS (
    SELECT 1
    FROM user_identities
    WHERE user_identities.provider = auth_accounts.providerId
      AND user_identities.provider_user_id = auth_accounts.accountId
  )
-- Deploy-abort safety net, as above.
ON CONFLICT DO NOTHING;
