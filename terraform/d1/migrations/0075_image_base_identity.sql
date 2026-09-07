-- Additive provenance. Existing images remain legacy/unknown until rebuilt.
ALTER TABLE image_builds ADD COLUMN base_release_id TEXT;
ALTER TABLE image_builds ADD COLUMN base_recipe_digest TEXT;
ALTER TABLE image_builds ADD COLUMN base_inventory_digest TEXT;
ALTER TABLE image_builds ADD COLUMN image_target TEXT;
