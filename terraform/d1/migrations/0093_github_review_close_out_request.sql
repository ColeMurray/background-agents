-- A review's close-out request: set when its turn has ended (its completion callback, a failed
-- prompt delivery, or a sweep that replaced its head), as JSON {owner, repo, description|null}.
-- Once set, the review's agent can no longer take the submission lease, and the row is kept —
-- and re-driven by the reaper — until a close-out has left a terminal commit status.
ALTER TABLE github_review_sessions ADD COLUMN close_out_request TEXT;
