-- Only future sessions inherit this default. Existing session audiences and
-- collaborators are intentionally unchanged, including for archived teams.
UPDATE teams SET default_visibility = 'team' WHERE default_visibility = 'private';
