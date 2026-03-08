-- Add sandbox_provider column to sessions table
ALTER TABLE sessions ADD COLUMN sandbox_provider TEXT;
