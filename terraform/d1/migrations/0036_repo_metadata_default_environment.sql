-- Default environment for GitHub-bot sessions triggered from a repository
-- (design §13.2): when set, a PR review or @mention on this repo opens the
-- referenced environment's full workspace instead of a single-repo session.
-- Nullable opt-in; the bot falls back to the repo-bound session when the
-- environment no longer exists or no longer contains this repository.

ALTER TABLE repo_metadata ADD COLUMN default_environment_id TEXT;
