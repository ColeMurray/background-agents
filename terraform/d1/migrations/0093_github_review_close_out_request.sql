-- A review's close-out request: set when its turn has ended (its completion callback, a failed
-- prompt delivery, or a sweep that replaced its head), as JSON {owner, repo, description|null}.
-- Once set, the review's agent can no longer take the submission lease, and the row is kept —
-- and re-driven by the reaper — until a close-out has left a terminal commit status.
ALTER TABLE github_review_sessions ADD COLUMN close_out_request TEXT;
-- The repository whose commit status the review owns, recorded when the session is created, so
-- the reaper can close out a review whose prompt never arrived (it has no completion callback).
-- Null for rows created by a bot that predates it.
ALTER TABLE github_review_sessions ADD COLUMN repo_owner TEXT;
ALTER TABLE github_review_sessions ADD COLUMN repo_name TEXT;
-- When the reaper last asked the github-bot to run this row's close-out: it drives the least
-- recently attempted first, so failing close-outs cannot starve the rest.
ALTER TABLE github_review_sessions ADD COLUMN close_out_attempted_at INTEGER;
-- When the review's session finished initializing and was confirmed the latest generation. Only
-- an admitted review takes over its head's status from an older review of the same head.
ALTER TABLE github_review_sessions ADD COLUMN admitted_at INTEGER;
-- Rows written before this migration belong to sessions whose init completed: a failed init
-- deleted its row.
UPDATE github_review_sessions SET admitted_at = created_at;
