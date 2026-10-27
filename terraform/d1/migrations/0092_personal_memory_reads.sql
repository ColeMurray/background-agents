-- Personal memory follows the session owner's own prompts. Once someone other than the personal
-- owner receives the session's sandbox credentials (terminal, editor or desktop), the session and
-- its children stop searching and reading the owner's personal store for the rest of their life.
-- The store clears this together with personal_auto_save_eligible when it hands those credentials
-- out, and children copy it from their parent.
ALTER TABLE session_memory_manifests ADD COLUMN personal_reads_eligible INTEGER NOT NULL DEFAULT 1
  CHECK (personal_reads_eligible IN (0, 1));

-- Sessions created before this change cannot show who already holds their sandbox credentials
-- (the web fetched them for every viewer with sandbox access), and automation and integration
-- sessions may have pinned a personal owner they no longer select. Switch off live personal reads
-- and auto-save in all of them; their pinned context is unchanged, and new sessions start eligible.
UPDATE session_memory_manifests SET personal_reads_eligible = 0, personal_auto_save_eligible = 0
WHERE personal_owner_user_id IS NOT NULL;
