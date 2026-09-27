# Export sessions into runs

This dependency-free Node 24 example pulls schema 2 trace pages into dated NDJSON files and loads
the session lines into a warehouse. No export is sent to the Open-Inspect project or a vendor. Start
with an operator account with `sessions.export` (Owner, Administrator, or custom role).

The control-plane endpoint does **not** accept API bearer tokens. Supply its reachable HTTPS base
URL, the deployment's `SERVICE_AUTH_SECRET_WEB` as `OPEN_INSPECT_WEB_SECRET`, and a current Better
Auth session cookie for that operator as `OPEN_INSPECT_SESSION_COOKIE`. The script signs each GET as
the `web` service (`sig1`) and forwards the user session; the control plane still checks the user's
permission. Obtain the cookie from your own browser session (the `Cookie` request header for an
authenticated web request). Use a trusted machine and protect both credentials; do not put them on
the command line, commit them, or reuse the web service secret for other services. An expired
session produces HTTP 401 and must be refreshed before resuming.

```sh
export OPEN_INSPECT_WEB_SECRET='your deployed SERVICE_AUTH_SECRET_WEB'
export OPEN_INSPECT_SESSION_COOKIE='__Secure-openinspect.session_token=your-session-cookie'
node examples/trace-export/export.mjs \
  --url https://your-control-plane.example \
  --out ./trace-export-data \
  --created-after 1767225600000 \
  --created-before 1767311999999 \
  --scope runs --compact
```

The dates are inclusive epoch milliseconds (example: one UTC day). `--scope runs` uses the root's
creation date for the window, keeping descendants even if they were created later. Omit `--scope`
for session-order export; omit `--compact` for the full stored event output. By default the script
requests all three trace collections (`include=messages,events,usage`), five sessions per page.
`--include none` exports session metadata only (100 sessions per page), or use `--include messages`,
`--include events`, or `--include usage` for a single collection.

Files are `trace-export-data/YYYY-MM-DD/page-000001.ndjson`, etc. The output directory also holds a
private `.resume.json` recording the endpoint and effective export parameters. Each nonterminal file
ends with a `cursor` line. Rerunning **the same command and window** checks that metadata, then
reads the most recent file's last cursor and resumes from it; a terminal file causes a no-op.
Directories with existing pages but no resume metadata are rejected. Writes are atomic so a failed
page is not mistaken for a completed page. A `session_error`, stream `error`, unexpected version or
HTTP failure stops the script without saving that page. Correct the cause and retry; for persistent
budget errors try `--compact` in a **new** output directory, or re-export a metadata-only window. Do
not change scope, window or include on resume in the same directory. Exported files contain
sensitive prompts, tool results and tokens; secure the output directory and warehouse.

## Load

The SQL examples in [`load/`](load/) create a staging table, a de-duplicated session view and a
`runs` view with cost and token sums grouped by `COALESCE(rootSessionId,id)`. PostgreSQL and
Snowflake retain raw JSON; BigQuery loads **selected metadata columns only**, ignoring trace arrays
and other fields, so keep the source NDJSON files if you need the complete trace. Choose one
warehouse:

- **PostgreSQL:** run `load/postgres.sql` with `psql`, then for each dated file use the
  `COPY FROM STDIN` command in that recipe. It reads local files directly.
- **BigQuery:** create the table/views with `load/bigquery.sql`, upload the dated `.ndjson` files to
  your own GCS bucket, then run its `LOAD DATA` example with your bucket URI.
- **Snowflake:** create the table/views with `load/snowflake.sql`, stage the files in your own S3
  bucket and run its `COPY INTO` example with your storage integration.

For example, after loading, `SELECT * FROM runs ORDER BY first_created_at DESC` gives one row per
root family. PostgreSQL and Snowflake staging tables retain cursor lines; BigQuery loads their
recognized fields with a null `id`. All session views filter them out. Repeated windows and
overlapping files are safe: the views de-duplicate on session `id` before grouping. Re-export a
window after concurrent root deletions; see [`docs/TRACE_EXPORT.md`](../../docs/TRACE_EXPORT.md) for
the consistency contract and field meanings.
