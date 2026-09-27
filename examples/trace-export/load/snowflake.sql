-- Replace YOUR_DB.YOUR_SCHEMA, bucket URI and storage integration with your own.
-- Upload the dated .ndjson files to S3, then run the stage and COPY statements.
CREATE TABLE IF NOT EXISTS YOUR_DB.YOUR_SCHEMA.trace_export_lines (
  payload VARIANT NOT NULL,
  loaded_at TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE FILE FORMAT IF NOT EXISTS YOUR_DB.YOUR_SCHEMA.trace_json TYPE = JSON;
CREATE STAGE IF NOT EXISTS YOUR_DB.YOUR_SCHEMA.trace_stage
  URL = 's3://YOUR_BUCKET/trace-export-data/'
  STORAGE_INTEGRATION = YOUR_STORAGE_INTEGRATION
  FILE_FORMAT = YOUR_DB.YOUR_SCHEMA.trace_json;

COPY INTO YOUR_DB.YOUR_SCHEMA.trace_export_lines (payload)
FROM (SELECT $1 FROM @YOUR_DB.YOUR_SCHEMA.trace_stage)
FILE_FORMAT = (FORMAT_NAME = YOUR_DB.YOUR_SCHEMA.trace_json)
PATTERN = '.*[.]ndjson';

-- Snowflake COPY skips previously loaded files unless FORCE = TRUE. Overlapping
-- windows may still contain the same session; the view de-duplicates by id.
CREATE OR REPLACE VIEW YOUR_DB.YOUR_SCHEMA.trace_sessions AS
SELECT payload:id::string AS id, payload
FROM YOUR_DB.YOUR_SCHEMA.trace_export_lines
WHERE payload:type::string = 'session' AND payload:schemaVersion::integer = 2
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY payload:id::string ORDER BY payload:updatedAt::bigint DESC, loaded_at DESC, TO_JSON(payload) DESC
) = 1;

CREATE OR REPLACE VIEW YOUR_DB.YOUR_SCHEMA.runs AS
SELECT COALESCE(payload:rootSessionId::string, id) AS root_session_id,
  MIN(payload:createdAt::bigint) AS first_created_at,
  COUNT(*) AS session_count,
  ARRAY_AGG(id) WITHIN GROUP (ORDER BY payload:spawnDepth::bigint, payload:createdAt::bigint, id) AS session_ids,
  SUM(payload:totalCost::float) AS total_cost_usd,
  SUM(payload:inputTokens::bigint) AS input_tokens,
  SUM(payload:outputTokens::bigint) AS output_tokens,
  SUM(payload:reasoningTokens::bigint) AS reasoning_tokens,
  SUM(payload:cacheReadTokens::bigint) AS cache_read_tokens,
  SUM(payload:cacheWriteTokens::bigint) AS cache_write_tokens
FROM YOUR_DB.YOUR_SCHEMA.trace_sessions
GROUP BY COALESCE(payload:rootSessionId::string, id);

-- SELECT * FROM YOUR_DB.YOUR_SCHEMA.runs ORDER BY first_created_at DESC;
