INSERT INTO session_skill_manifests (
  session_id,
  selection_mode,
  profile_id,
  profile_name,
  resolver_version,
  manifest_sha256,
  resolved_at
)
SELECT
  id,
  'all',
  NULL,
  NULL,
  1,
  -- Canonical V1 digest for selection "all" with no resolved skills.
  'e7d61c2e053a6b51e57f80668d4965ffeb7b98004504cb544f4fb6900b998dfe',
  created_at
FROM sessions
WHERE NOT EXISTS (
  SELECT 1
  FROM session_skill_manifests
  WHERE session_skill_manifests.session_id = sessions.id
);
