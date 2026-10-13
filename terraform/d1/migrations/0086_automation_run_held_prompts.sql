-- Session continuity (Slack thread replies, webhook sessionKey deliveries) can
-- target a run that is still launching: its session may not exist yet, or may
-- exist without the run's own first prompt. Such follow-ups are held here and
-- released, in order, once that first prompt is on the session's queue.

-- Set with the session claim and cleared once the run's first prompt is queued.
-- Rows written by a Worker that predates this column keep the default and read
-- as ready, which is how that Worker treats them.
ALTER TABLE automation_runs ADD COLUMN first_prompt_pending INTEGER NOT NULL DEFAULT 0;

CREATE TABLE automation_run_held_prompts (
  id              TEXT    PRIMARY KEY,
  run_id          TEXT    NOT NULL,
  -- The steering actor, re-admitted against the session at release time: the
  -- session does not exist yet when the prompt is held.
  actor_user_id   TEXT    NOT NULL,
  actor_author_id TEXT    NOT NULL,
  -- JSON enqueue-prompt request body, forwarded as-is on release.
  prompt          TEXT    NOT NULL,
  request_id      TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES automation_runs(id)
);

CREATE INDEX idx_run_held_prompts_run ON automation_run_held_prompts (run_id, created_at);
CREATE INDEX idx_run_held_prompts_created ON automation_run_held_prompts (created_at);
