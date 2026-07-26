WITH
  normalized_users AS (
    SELECT
      id,
      lower(trim(email)) AS normalized_email
    FROM users
    WHERE email IS NOT NULL
  ),
  invalid_users AS (
    SELECT id
    FROM normalized_users
    WHERE length(normalized_email) = 0
  ),
  duplicate_emails AS (
    SELECT normalized_email
    FROM normalized_users
    WHERE length(normalized_email) > 0
    GROUP BY normalized_email
    HAVING count(*) > 1
  ),
  duplicate_users AS (
    SELECT users.id
    FROM normalized_users AS users
    INNER JOIN duplicate_emails USING (normalized_email)
  )
SELECT
  CASE
    WHEN
      NOT EXISTS(SELECT 1 FROM invalid_users)
      AND NOT EXISTS(SELECT 1 FROM duplicate_users)
      THEN 'ready'
    ELSE 'blocked'
  END AS status,
  (SELECT count(*) FROM invalid_users) AS invalid_email_count,
  (SELECT count(*) FROM duplicate_users) AS duplicate_email_user_count,
  (
    SELECT group_concat(id, ',')
    FROM (
      SELECT id
      FROM invalid_users
      ORDER BY id
      LIMIT 20
    )
  ) AS invalid_user_ids,
  (
    SELECT group_concat(id, ',')
    FROM (
      SELECT id
      FROM duplicate_users
      ORDER BY id
      LIMIT 20
    )
  ) AS duplicate_user_ids;
