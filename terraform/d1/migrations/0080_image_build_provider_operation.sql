-- image_builds: durable identity for an asynchronous provider artifact operation.
--
-- Some providers accept a capture request and produce the artifact later, so
-- acceptance is not an artifact and a retry cannot simply ask again: a second
-- request could leak a second artifact. The finalizer therefore reserves the
-- operation's unique name under the build's lease BEFORE submitting it, and a
-- later delivery reconciles that name instead of capturing again.
--
-- Both columns stay NULL for providers that return a finished artifact from
-- one call, and for every row written before this migration, so their
-- conservative unknown-outcome handling is unchanged.
--
-- provider_operation_ref is also a cleanup handle: while it is set and no
-- provider_image_id has been fenced, the build may still own an artifact that
-- nothing else on the row records, so row deletion is held until it resolves.
--
-- The index work below is not about these columns alone: the shape of the
-- "no outstanding obligation" predicate changes with them, and a partial
-- index only serves a query whose WHERE clause implies its own.

ALTER TABLE image_builds ADD COLUMN provider_operation_ref TEXT;
ALTER TABLE image_builds ADD COLUMN provider_operation_deadline_at INTEGER;

-- The maintenance sweeps' partial indexes follow the predicate they serve.
-- SQLite only uses a partial index whose WHERE clause the query's own WHERE
-- clause implies, term by term, so a predicate that changed shape needs its
-- index rewritten to the same shape or the sweep silently becomes a table
-- scan. `provider_session_cleanup_pending = 1` can now be set before a
-- session id exists, which is why the old `provider_session_id IS NULL`
-- shortcut for "no obligation" is gone from all three.

DROP INDEX idx_image_builds_superseded_cleanup;
CREATE INDEX idx_image_builds_superseded_cleanup
  ON image_builds(created_at, id)
  WHERE status = 'superseded'
    AND (provider_session_cleanup_pending = 0
     OR (provider_session_cleanup_pending IS NULL AND provider_session_id IS NULL));

DROP INDEX idx_image_builds_failed_artifact_cleanup;
CREATE INDEX idx_image_builds_failed_artifact_cleanup
  ON image_builds(created_at, id)
  WHERE status = 'failed'
    AND provider_image_id IS NOT NULL
    AND (provider_session_cleanup_pending = 0
     OR (provider_session_cleanup_pending IS NULL AND provider_session_id IS NULL));

DROP INDEX idx_image_builds_failed_history_cleanup;
CREATE INDEX idx_image_builds_failed_history_cleanup
  ON image_builds(created_at, id)
  WHERE status = 'failed'
    AND provider_image_id IS NULL
    AND (provider_session_cleanup_pending = 0
     OR (provider_session_cleanup_pending IS NULL AND provider_session_id IS NULL))
    AND provider_operation_ref IS NULL;

-- The two new sweeps, each ordered by (created_at, id) like its siblings so
-- the scan is ordered rather than sorted into a temporary b-tree.
CREATE INDEX idx_image_builds_unbound_source_intents
  ON image_builds(created_at, id)
  WHERE status IN ('failed', 'superseded')
    AND provider_session_id IS NULL
    AND provider_session_cleanup_pending = 1;

CREATE INDEX idx_image_builds_unresolved_operations
  ON image_builds(created_at, id)
  WHERE status IN ('failed', 'superseded')
    AND provider_operation_ref IS NOT NULL
    AND provider_image_id IS NULL;
