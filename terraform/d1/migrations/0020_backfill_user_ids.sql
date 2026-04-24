-- Phase 6 backfill: Populate user_id on existing sessions using scm_login.
-- Depends on 0019_create_users.sql (users, user_identities tables).
-- Idempotent: all INSERTs use ON CONFLICT DO NOTHING, all UPDATEs use WHERE user_id IS NULL.

-- Step 1: Create users rows from distinct scm_login values.
INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  scm_login,
  NULL,
  'https://github.com/' || scm_login || '.png',
  MIN(created_at),
  MAX(updated_at)
FROM sessions
WHERE scm_login IS NOT NULL AND scm_login != ''
GROUP BY scm_login
ON CONFLICT DO NOTHING;

-- Step 2: Create user_identities rows linking scm_login to the user created above.
-- Only links when the display_name→user mapping is unambiguous (exactly one match).
INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_login, created_at)
SELECT
  lower(hex(randomblob(16))),
  u.id,
  'github',
  s.scm_login,
  s.scm_login,
  u.created_at
FROM (SELECT DISTINCT scm_login FROM sessions
      WHERE scm_login IS NOT NULL AND scm_login != '') s
JOIN users u ON u.display_name = s.scm_login
WHERE (SELECT COUNT(*) FROM users u2 WHERE u2.display_name = s.scm_login) = 1
ON CONFLICT(provider, provider_user_id) DO NOTHING;

-- Step 3: Backfill sessions.user_id from the identity rows.
-- Only touches rows that have a matching identity (EXISTS guard avoids no-op NULL writes).
UPDATE sessions
SET user_id = (
  SELECT ui.user_id
  FROM user_identities ui
  WHERE ui.provider = 'github' AND ui.provider_user_id = sessions.scm_login
)
WHERE scm_login IS NOT NULL AND scm_login != '' AND user_id IS NULL
  AND EXISTS (
    SELECT 1 FROM user_identities ui
    WHERE ui.provider = 'github' AND ui.provider_user_id = sessions.scm_login
  );

-- Step 4: Best-effort backfill of user_scm_tokens.user_id.
UPDATE user_scm_tokens
SET user_id = (
  SELECT ui.user_id
  FROM user_identities ui
  WHERE ui.provider = 'github' AND ui.provider_user_id = user_scm_tokens.provider_user_id
)
WHERE user_id IS NULL
  AND EXISTS (
    SELECT 1 FROM user_identities ui
    WHERE ui.provider = 'github' AND ui.provider_user_id = user_scm_tokens.provider_user_id
  );
