-- NULL means the runtime has not reported token usage for this session.
ALTER TABLE sessions ADD COLUMN total_tokens INTEGER;
