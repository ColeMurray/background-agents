-- Prefix bare Anthropic model IDs with "anthropic/"
UPDATE sessions
SET model = 'anthropic/' || model
WHERE model LIKE 'claude-%';
