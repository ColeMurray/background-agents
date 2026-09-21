-- image_builds: which sandbox runtime variant an image was prepared for.
--
-- A Docker-enabled Modal session boots a Docker-capable VM image, and a
-- prepared image baked on the default gVisor image cannot serve it (nor the
-- reverse). The variant is recorded when a build is registered, from the
-- scope's frozen sandbox settings, and spawn-time selection filters on it so
-- the two kinds of artifact never cross over. Every row written before this
-- migration was built for the default runtime.
ALTER TABLE image_builds ADD COLUMN artifact_variant TEXT NOT NULL DEFAULT 'default';
