-- pi-feature: slackIngress
CREATE TABLE slack_ingress_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32),
  external_event_id TEXT NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 255),
  payload_json TEXT CHECK (payload_json IS NULL OR length(payload_json) <= 262144),
  payload_ref TEXT CHECK (payload_ref IS NULL OR length(payload_ref) <= 512),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  owner_team_id TEXT REFERENCES teams(id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 255),
  thread_ts TEXT CHECK (thread_ts IS NULL OR length(thread_ts) <= 64),
  state TEXT NOT NULL CHECK (state IN ('admitted','processing','session_created','prompt_queued','completed','failed')),
  stable_session_id TEXT NOT NULL CHECK (length(stable_session_id) BETWEEN 1 AND 128),
  stable_message_id TEXT NOT NULL CHECK (length(stable_message_id) BETWEEN 1 AND 128),
  session_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  deadline_at INTEGER NOT NULL,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 128),
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  CHECK ((payload_json IS NULL) != (payload_ref IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  UNIQUE(source, external_event_id),
  UNIQUE(stable_session_id),
  UNIQUE(stable_message_id)
);
CREATE INDEX idx_slack_ingress_claim ON slack_ingress_receipts(state, lease_expires_at, deadline_at);
CREATE INDEX idx_slack_ingress_terminal ON slack_ingress_receipts(terminal_at) WHERE terminal_at IS NOT NULL;
CREATE INDEX idx_slack_ingress_actor ON slack_ingress_receipts(actor_user_id, received_at);
CREATE INDEX idx_slack_ingress_team ON slack_ingress_receipts(owner_team_id, received_at);
