ALTER TABLE sessions ADD COLUMN root_session_id TEXT;

-- Resolve every existing lineage without assuming it is a tree. UNION makes
-- reachability finite for corrupt cycles; cycle roots match the prior inbox
-- behavior by choosing the lexicographically smallest member.
WITH RECURSIVE
  ancestors(start_id, id, parent_session_id) AS (
    SELECT id, id, parent_session_id FROM sessions
    UNION
    SELECT ancestors.start_id, parent.id, parent.parent_session_id
    FROM ancestors
    JOIN sessions parent ON parent.id = ancestors.parent_session_id
  ),
  parent_reachability(start_id, id) AS (
    SELECT child.id, parent.id
    FROM sessions child
    JOIN sessions parent ON parent.id = child.parent_session_id
    UNION
    SELECT parent_reachability.start_id, parent.id
    FROM parent_reachability
    JOIN sessions current ON current.id = parent_reachability.id
    JOIN sessions parent ON parent.id = current.parent_session_id
  ),
  cycle_members AS (
    SELECT start_id AS id
    FROM parent_reachability
    WHERE start_id = id
  )
UPDATE sessions
SET root_session_id = COALESCE(
  (
    SELECT ancestor.id
    FROM ancestors ancestor
    LEFT JOIN sessions parent ON parent.id = ancestor.parent_session_id
    WHERE ancestor.start_id = sessions.id
      AND (ancestor.parent_session_id IS NULL OR parent.id IS NULL)
    LIMIT 1
  ),
  (
    SELECT MIN(ancestor.id)
    FROM ancestors ancestor
    JOIN cycle_members ON cycle_members.id = ancestor.id
    WHERE ancestor.start_id = sessions.id
  ),
  sessions.id
);

CREATE INDEX idx_sessions_root_updated
  ON sessions(root_session_id, updated_at);

-- Parent links are immutable in normal session creation, but keep roots correct
-- for repair tooling that rewrites one. Recomputing all roots is intentionally
-- simple and safe for this exceptional path, including cycles and descendants.
CREATE TRIGGER sessions_parent_root_after_update
AFTER UPDATE OF parent_session_id ON sessions
BEGIN
  UPDATE sessions
  SET root_session_id = (
    WITH RECURSIVE
      ancestors(start_id, id, parent_session_id) AS (
        SELECT id, id, parent_session_id FROM sessions
        UNION
        SELECT ancestors.start_id, parent.id, parent.parent_session_id
        FROM ancestors
        JOIN sessions parent ON parent.id = ancestors.parent_session_id
      ),
      parent_reachability(start_id, id) AS (
        SELECT child.id, parent.id
        FROM sessions child
        JOIN sessions parent ON parent.id = child.parent_session_id
        UNION
        SELECT parent_reachability.start_id, parent.id
        FROM parent_reachability
        JOIN sessions current ON current.id = parent_reachability.id
        JOIN sessions parent ON parent.id = current.parent_session_id
      ),
      cycle_members AS (
        SELECT start_id AS id
        FROM parent_reachability
        WHERE start_id = id
      )
    SELECT COALESCE(
      (
        SELECT ancestor.id
        FROM ancestors ancestor
        LEFT JOIN sessions parent ON parent.id = ancestor.parent_session_id
        WHERE ancestor.start_id = sessions.id
          AND (ancestor.parent_session_id IS NULL OR parent.id IS NULL)
        LIMIT 1
      ),
      (
        SELECT MIN(ancestor.id)
        FROM ancestors ancestor
        JOIN cycle_members ON cycle_members.id = ancestor.id
        WHERE ancestor.start_id = sessions.id
      ),
      sessions.id
    )
  );
END;

-- Session deletion leaves descendants alive. Detach direct children first so
-- each surviving subtree receives an existing root rather than a dangling id.
CREATE TRIGGER sessions_root_before_delete
BEFORE DELETE ON sessions
BEGIN
  UPDATE sessions
  SET parent_session_id = NULL
  WHERE parent_session_id = OLD.id;
END;
