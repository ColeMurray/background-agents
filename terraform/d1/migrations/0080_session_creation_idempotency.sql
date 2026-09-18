CREATE TABLE session_creation_claims (
  user_scope       TEXT    NOT NULL,
  client_request_id TEXT   NOT NULL,
  request_fingerprint TEXT NOT NULL,
  session_id       TEXT    NOT NULL UNIQUE,
  status           TEXT    NOT NULL CHECK (status IN ('claimed', 'created')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (user_scope, client_request_id)
);
