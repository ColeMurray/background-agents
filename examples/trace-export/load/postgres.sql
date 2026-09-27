-- Run with: psql "$DATABASE_URL" -f examples/trace-export/load/postgres.sql
CREATE TABLE IF NOT EXISTS trace_export_lines (
  ingest_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payload jsonb NOT NULL
);

-- For each dated NDJSON file (from a shell, not inside psql):
-- psql "$DATABASE_URL" -c "COPY trace_export_lines(payload) FROM STDIN WITH (FORMAT csv, DELIMITER E'\x02', QUOTE E'\x01')" < "$file"
-- JSON has no literal control characters; this preserves backslashes and quotes
-- that PostgreSQL's default COPY text/CSV formats would otherwise interpret.

CREATE OR REPLACE VIEW trace_sessions AS
SELECT id, payload
FROM (
  SELECT payload->>'id' AS id, payload,
    ROW_NUMBER() OVER (PARTITION BY payload->>'id' ORDER BY ingest_id DESC) AS rank
  FROM trace_export_lines
  WHERE payload->>'type' = 'session' AND payload->>'schemaVersion' = '2'
) AS deduplicated
WHERE rank = 1;

CREATE OR REPLACE VIEW runs AS
SELECT COALESCE(payload->>'rootSessionId', id) AS root_session_id,
  MIN((payload->>'createdAt')::bigint) AS first_created_at,
  COUNT(*) AS session_count,
  ARRAY_AGG(id ORDER BY (payload->>'spawnDepth')::integer, (payload->>'createdAt')::bigint, id) AS session_ids,
  SUM((payload->>'totalCost')::numeric) AS total_cost_usd,
  SUM((payload->>'inputTokens')::bigint) AS input_tokens,
  SUM((payload->>'outputTokens')::bigint) AS output_tokens,
  SUM((payload->>'reasoningTokens')::bigint) AS reasoning_tokens,
  SUM((payload->>'cacheReadTokens')::bigint) AS cache_read_tokens,
  SUM((payload->>'cacheWriteTokens')::bigint) AS cache_write_tokens
FROM trace_sessions
GROUP BY COALESCE(payload->>'rootSessionId', id);

-- SELECT * FROM runs ORDER BY first_created_at DESC;
