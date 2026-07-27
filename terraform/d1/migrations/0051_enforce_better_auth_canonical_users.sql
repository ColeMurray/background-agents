-- Better Auth's D1 adapter cannot run its multi-statement OAuth user creation
-- in an interactive transaction. Project auth_users into the canonical users
-- table inside SQLite triggers instead: trigger failure aborts the originating
-- auth_users statement, so a duplicate canonical email cannot leave an
-- authenticatable partial identity graph.

-- Preserve non-conflicting identities that a prior post-transaction projection
-- failure may have stranded. Never reparent by email: the same-id relationship
-- is the authentication/authorization invariant.
INSERT INTO users (
  id,
  display_name,
  email,
  avatar_url,
  created_at,
  updated_at
)
SELECT
  auth_users.id,
  nullif(trim(auth_users.name), ''),
  lower(trim(auth_users.email)),
  auth_users.image,
  CAST(unixepoch(auth_users.createdAt, 'subsec') * 1000 AS INTEGER),
  CAST(unixepoch(auth_users.updatedAt, 'subsec') * 1000 AS INTEGER)
FROM auth_users
WHERE length(auth_users.id) = 32
  AND auth_users.id NOT GLOB '*[^0-9a-f]*'
  AND length(trim(auth_users.email)) > 0
  AND unixepoch(auth_users.createdAt, 'subsec') IS NOT NULL
  AND unixepoch(auth_users.updatedAt, 'subsec') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE users.id = auth_users.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE users.id <> auth_users.id
      AND lower(trim(users.email)) = lower(trim(auth_users.email))
  )
ON CONFLICT(id) DO UPDATE SET
  display_name = excluded.display_name,
  email = excluded.email,
  avatar_url = excluded.avatar_url,
  updated_at = excluded.updated_at;

-- Revoke graphs that cannot be projected without violating the canonical
-- identity constraints. Foreign-key cascades remove their accounts/sessions.
DELETE FROM auth_users
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = auth_users.id
);

CREATE TRIGGER IF NOT EXISTS auth_users_project_canonical_after_insert
AFTER INSERT ON auth_users
BEGIN
  SELECT CASE
    WHEN length(NEW.id) <> 32 OR NEW.id GLOB '*[^0-9a-f]*'
    THEN RAISE(ABORT, 'auth_users.id must be canonical')
  END;
  SELECT CASE
    WHEN length(trim(NEW.email)) = 0
    THEN RAISE(ABORT, 'auth_users.email must be non-empty')
  END;

  INSERT INTO users (
    id,
    display_name,
    email,
    avatar_url,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    nullif(trim(NEW.name), ''),
    lower(trim(NEW.email)),
    NEW.image,
    CAST(unixepoch(NEW.createdAt, 'subsec') * 1000 AS INTEGER),
    CAST(unixepoch(NEW.updatedAt, 'subsec') * 1000 AS INTEGER)
  )
  ON CONFLICT(id) DO UPDATE SET
    display_name = excluded.display_name,
    email = excluded.email,
    avatar_url = excluded.avatar_url,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS auth_users_project_canonical_after_update
AFTER UPDATE OF name, email, image, updatedAt ON auth_users
BEGIN
  SELECT CASE
    WHEN length(NEW.id) <> 32 OR NEW.id GLOB '*[^0-9a-f]*'
    THEN RAISE(ABORT, 'auth_users.id must be canonical')
  END;
  SELECT CASE
    WHEN length(trim(NEW.email)) = 0
    THEN RAISE(ABORT, 'auth_users.email must be non-empty')
  END;

  INSERT INTO users (
    id,
    display_name,
    email,
    avatar_url,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    nullif(trim(NEW.name), ''),
    lower(trim(NEW.email)),
    NEW.image,
    CAST(unixepoch(NEW.createdAt, 'subsec') * 1000 AS INTEGER),
    CAST(unixepoch(NEW.updatedAt, 'subsec') * 1000 AS INTEGER)
  )
  ON CONFLICT(id) DO UPDATE SET
    display_name = excluded.display_name,
    email = excluded.email,
    avatar_url = excluded.avatar_url,
    updated_at = excluded.updated_at;
END;
