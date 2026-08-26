-- Converge sign-in identities created after provider_issuer was introduced.
UPDATE user_identities
SET provider_issuer = IIF(
  provider = 'github',
  'https://github.com',
  'https://accounts.google.com'
)
WHERE provider_issuer IS NULL
  AND provider IN ('github', 'google');
