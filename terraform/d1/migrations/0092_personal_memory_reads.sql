-- Personal memory follows the session owner's own prompts. Once someone other than the personal
-- owner receives the session's sandbox credentials (terminal, editor or desktop), the session and
-- its children stop searching and reading the owner's personal store for the rest of their life.
-- The store clears this together with personal_auto_save_eligible when it hands those credentials
-- out, and children copy it from their parent.
ALTER TABLE session_memory_manifests ADD COLUMN personal_reads_eligible INTEGER NOT NULL DEFAULT 1
  CHECK (personal_reads_eligible IN (0, 1));

-- Automation runs and sessions the GitHub or Linear integration starts no longer select personal
-- memory. Those created earlier, and their children, keep the personal owner they pinned; switch
-- off live personal reads and auto-save there so their own later prompts cannot read that store.
UPDATE session_memory_manifests SET personal_reads_eligible = 0, personal_auto_save_eligible = 0
WHERE personal_owner_user_id IS NOT NULL AND session_id IN (
  SELECT s.id FROM sessions s
  JOIN sessions root ON root.id = COALESCE(s.root_session_id, s.id)
  WHERE root.spawn_source IN ('automation', 'github-bot', 'linear-bot')
);
