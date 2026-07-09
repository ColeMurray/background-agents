-- Rename environment_images provenance columns to repository nomenclature.
--
-- 0033 shipped these as members_fingerprint/member_shas, but "members" does
-- not say what it represents; the system's term for an environment's repo set
-- is "repositories" (environment_repositories, the environments API field).
-- Safe as a plain rename: nothing writes to environment_images until the
-- environment-image build system lands, so the table is empty everywhere.

ALTER TABLE environment_images RENAME COLUMN members_fingerprint TO repositories_fingerprint;
ALTER TABLE environment_images RENAME COLUMN member_shas TO repository_shas;
