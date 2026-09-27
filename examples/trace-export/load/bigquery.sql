-- Replace YOUR_PROJECT.YOUR_DATASET and gs://YOUR_BUCKET/trace-export-data/.
-- Run the CREATE statements first, upload dated .ndjson files to your own GCS
-- bucket, then run LOAD DATA. Repeating the load is safe for the views.
CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.trace_export_lines` (
  schemaVersion INT64, type STRING, id STRING, rootSessionId STRING,
  spawnDepth INT64, createdAt INT64, updatedAt INT64, totalCost FLOAT64,
  inputTokens INT64, outputTokens INT64, reasoningTokens INT64,
  cacheReadTokens INT64, cacheWriteTokens INT64,
  ingestedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

LOAD DATA INTO `YOUR_PROJECT.YOUR_DATASET.trace_export_lines` (
  schemaVersion, type, id, rootSessionId, spawnDepth, createdAt, updatedAt,
  totalCost, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens
)
FROM FILES (
  format = 'JSON',
  uris = ['gs://YOUR_BUCKET/trace-export-data/*/*.ndjson'],
  ignore_unknown_values = TRUE
);

-- The JSON load intentionally ignores other session/trace fields; raw files
-- remain in your bucket if you need to build additional dimensions later.
CREATE OR REPLACE VIEW `YOUR_PROJECT.YOUR_DATASET.trace_sessions` AS
SELECT * FROM `YOUR_PROJECT.YOUR_DATASET.trace_export_lines` AS t
WHERE type = 'session' AND schemaVersion = 2
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY id ORDER BY updatedAt DESC, ingestedAt DESC, TO_JSON_STRING(t) DESC
) = 1;

CREATE OR REPLACE VIEW `YOUR_PROJECT.YOUR_DATASET.runs` AS
SELECT COALESCE(rootSessionId, id) AS root_session_id,
  MIN(createdAt) AS first_created_at,
  COUNT(*) AS session_count,
  ARRAY_AGG(id ORDER BY spawnDepth, createdAt, id) AS session_ids,
  SUM(totalCost) AS total_cost_usd,
  SUM(inputTokens) AS input_tokens,
  SUM(outputTokens) AS output_tokens,
  SUM(reasoningTokens) AS reasoning_tokens,
  SUM(cacheReadTokens) AS cache_read_tokens,
  SUM(cacheWriteTokens) AS cache_write_tokens
FROM `YOUR_PROJECT.YOUR_DATASET.trace_sessions`
GROUP BY COALESCE(rootSessionId, id);

-- SELECT * FROM `YOUR_PROJECT.YOUR_DATASET.runs` ORDER BY first_created_at DESC;
