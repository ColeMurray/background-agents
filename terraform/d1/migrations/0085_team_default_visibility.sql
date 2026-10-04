-- Only future sessions inherit this default. Existing session audiences and
-- collaborators are intentionally unchanged, including for archived teams.
UPDATE teams SET default_visibility = 'team' WHERE default_visibility = 'private';

-- Fence the previous Worker's writes between migration commit and deployment.
-- Store validation in the new Worker cannot protect this rollout window.
CREATE TRIGGER teams_default_visibility_insert
BEFORE INSERT ON teams
WHEN NEW.default_visibility NOT IN ('team', 'workspace')
BEGIN
  SELECT RAISE(ABORT, 'Team default visibility must be team or workspace');
END;

CREATE TRIGGER teams_default_visibility_update
BEFORE UPDATE OF default_visibility ON teams
WHEN NEW.default_visibility NOT IN ('team', 'workspace')
BEGIN
  SELECT RAISE(ABORT, 'Team default visibility must be team or workspace');
END;
