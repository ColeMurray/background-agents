-- Personal memory follows the session owner's own prompts. Once someone other than the personal
-- owner receives the session's sandbox credentials (terminal, editor or desktop), the session
-- stops searching and reading the owner's personal store for the rest of its life. The store
-- clears this together with personal_auto_save_eligible when it hands those credentials out.
ALTER TABLE session_memory_manifests ADD COLUMN personal_reads_eligible INTEGER NOT NULL DEFAULT 1
  CHECK (personal_reads_eligible IN (0, 1));
