-- Seed Better Auth users from the canonical users that predate its activation,
-- then seed accounts from immutable sign-in identities. Email reserves an
-- existing canonical user against implicit linking, but account ownership
-- comes only from user_identities' exact provider issuer and subject.

-- Better Auth's D1 transaction fallback is non-atomic. A failed first sign-in
-- can therefore leave the new auth user, account, and session behind when the
-- canonical users projection rejects a duplicate email. Remove that entire
-- partial identity graph before inserting the canonical row below. The foreign
-- keys cascade only from a Better Auth user whose normalized email is already
-- owned by a different canonical user; unrelated Better Auth identities are
-- untouched.
DELETE FROM auth_users
WHERE EXISTS (
    SELECT 1
    FROM users
    WHERE users.id <> auth_users.id
      AND lower(trim(users.email)) = lower(trim(auth_users.email))
  );

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
  0,
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
      AND lower(trim(auth_users.email)) = lower(trim(users.email))
  );

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
      AND auth_accounts.userId = user_identities.user_id
  );
