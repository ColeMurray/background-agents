-- Drop repo_images: the repo scope now lives in image_builds (0039).
--
-- Rows are NOT migrated. They are cache entries, and the unified table keys
-- selection on repositories_fingerprint — which is a SHA-256 over the ordered
-- (owner, name, base_branch) set, not computable in SQL. The rebuild cron
-- sees no ready image for each enabled repo and rebuilds it within about one
-- tick; repo sessions boot from the base image until then (slower boots, no
-- failures).
--
-- repo_metadata.image_build_enabled stays where it is: enablement is entity
-- metadata, read by the scope resolver (image-builds/scope.ts).

DROP TABLE repo_images;
