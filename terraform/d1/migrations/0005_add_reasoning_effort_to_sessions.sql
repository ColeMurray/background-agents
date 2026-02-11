-- Add reasoning_effort to session index for consistency with model field.
-- Both are session-level defaults that can be overridden per-message.
ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;
