# Trace export (schema 2)

Trace export is pull-only NDJSON. Each line is an independent JSON object described by
[`trace-export.v2.schema.json`](schemas/trace-export.v2.schema.json). The control plane does not
send exports to a vendor. This release supports manual downloads, not scheduled warehouse loading.

## Access and routes

Both routes require an active user with `sessions.export` (Owners and Administrators by default, or
a custom role granting it). `sessions.read` alone is insufficient; the bot services cannot export.
Manual bulk downloads use the web app's `/api/sessions/export` proxy with an authenticated browser
session; the web app holds its service secret and signs the control-plane request server-side. The
web app also proxies single-session downloads at `/api/sessions/:id/export`. There is no bearer API
token path for export. Treat downloaded files as sensitive session data.

| Route                      | Behavior                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /sessions/export`     | Bulk, paginated. Defaults to `scope=sessions`, no included trace, `limit=100`.                                                                                                                    |
| `GET /sessions/:id/export` | Exactly one session, full `messages,events,usage` trace by default. Accepts `include` and `format`; `scope` returns 400. No bulk cursor or run export on this route. Missing session returns 404. |

Bulk query parameters:

| Name                            | Meaning                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`                         | `sessions` (default) orders sessions newest first by `(createdAt,id)`; `runs` orders root families by root creation time.                                        |
| `createdAfter`, `createdBefore` | Inclusive epoch **milliseconds**, applied to session creation in `sessions` scope and root creation in `runs` scope. Supply both for a repeatable window.        |
| `include`                       | Comma-separated subset of `messages,events,usage`, in any order; omitted means metadata only.                                                                    |
| `format`                        | `full` (default) or `compact` (changes included event output only).                                                                                              |
| `limit`                         | Sessions per page: 1–500 without `include` (default 100); 1–5 with any `include` (default 5). Counts session lines, not families.                                |
| `cursor`                        | Opaque `nextCursor` from the prior page's cursor line. Keep the same scope, window, include and format on every page. Invalid or wrong-scope cursors return 400. |

## Manual download

For one session, open its page in the web app and select **Download trace**. For a bulk window, sign
in as an operator with `sessions.export`, then open a URL on the **web app** origin such as:

```text
https://your-web-app.example/api/sessions/export?scope=runs&include=messages%2Cevents%2Cusage&format=compact&createdAfter=1767225600000&createdBefore=1767311999999&limit=5
```

Save the NDJSON response locally. If its last line has `type: "cursor"`, append its URL-encoded
`nextCursor` as the `cursor` parameter and save the next page; repeat until a page has no cursor
line. Keep the same scope, date window, include and format on each request. Inspect every page for
`session_error` or `error` lines: these are not successful session exports. Re-export the window if
the index changes during pagination. No browser cookie or web service secret needs to be copied into
a CLI. Unattended export requires a separate machine credential, which is not available yet.

The response has `Content-Type: application/x-ndjson` and `Cache-Control: private, no-store`. Lines
are `schemaVersion: 2` and one of:

| `type`          | Meaning                                                                                                                                                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`       | Session-index metadata (identity, hierarchy, owner, model/provider, repositories, PRs, token totals, cost and timestamps), plus only the requested trace arrays. Nullable fields are present; unrequested arrays are absent.                                                                             |
| `session_error` | An included trace could not be read; **no partial session line** is emitted for this ID. `reason` is `http_error` (with `status`), `runtime_failure`, `page_cap_reached`, or `trace_budget_exceeded`. Retry the window or use `format=compact`/fewer includes; do not count this as an exported session. |
| `cursor`        | Last line of a nonterminal page; pass `nextCursor` on the next request. A terminal page has no cursor line.                                                                                                                                                                                              |
| `error`         | Terminal streaming error, for example a failed index read. Treat the page/window as incomplete.                                                                                                                                                                                                          |

Each included session trace is read via **one** runtime `GET /internal/trace-export` call in a
single storage snapshot. Its collections share a 4 MiB serialized-response budget and at most 25
repository reads of up to 100 rows each; the control-plane runtime read also has a 10-second
timeout. Budget or page-cap failures replace the session line with `session_error`, not a partially
populated session. Within a schema 2 session line, **messages, events and usage are all oldest
first**. Events use timeline sequence for equal timestamps. Schema 1 listed messages newest first;
reverse them when migrating a consumer.

## Runs and consistency

With `scope=runs`, the root's `createdAt` determines window membership, even if a child was created
outside the window. Roots sort newest first; within a root family the root precedes descendants, by
spawn depth, creation time and ID. All lines of a family stay consecutive but **a family can
continue on the next page**. `rootSessionId` is normally the root ID; use
`COALESCE(rootSessionId,id)` for legacy rows without one. Whole runs are available only through the
bulk route.

Pagination is best-effort, **not a database snapshot**. On the first page each scope captures
`MAX(rowid)` and fences later inserts; a late insert is normally excluded. If the highest-rowid
session is deleted, SQLite can reuse its rowid and a rare late insert may slip through. Deletions
are not fenced: deleting a root mid-export re-roots children, so a run can be incomplete in that
export. Re-export the window to recover it. Concurrent mutations can cause omissions or duplicates;
de-duplicate on session `id` when combining overlapping or rerun windows. Orphaned children whose
root row no longer exists are excluded by the run join.

## Compact events and known gaps

`format=compact` leaves session metadata, messages and usage unchanged. For `tool_call` event data:

- A `Read`/`read` file output becomes `data.compacted: {output:"file_read",originalChars:N}`.
- Duplicate output may become `data.compacted: {output:"ref",ref:"<event-id>"}` when that is
  smaller. `ref` points to the **latest** occurrence, which appears _later_ in the oldest-first
  exported array. Resolve references by event ID, not array position.
- A unique long output is shortened to 4,096 UTF-16 code units with
  `data.compacted: {output:"truncated",originalChars:N}`. The index is capped at 256 outputs and 1
  MiB of characters; once full, further outputs may not deduplicate. Full format still preserves the
  stored value. `tool_call.truncated` (inside event `data`) instead denotes fields truncated by the
  upstream bridge **before persistence**; compact export cannot restore them.

The persisted timeline has tool output in `tool_call.data.output`. Separately emitted `tool_result`
events are also persisted and exported when present; consumers must handle both types. Per-step
usage is raw harness-reported data: step boundaries and counts are **not comparable across
harnesses**. Session token totals are index projections; older sessions may have zero-valued totals
without raw step usage.

## Versioning

The line discriminator and `schemaVersion` form the published contract. Additive fields can arrive
within a major schema version; consumers **must ignore unknown fields**. A breaking change requires
a new major version and a new JSON Schema file. Schema 2 publishes the fields introduced since
schema 1, changes the message array to oldest-first, and renames the budget error to
`trace_budget_exceeded`. Regenerate the schema after changing shared Zod types with
`node packages/control-plane/scripts/generate-trace-export-schema.mjs`; the route test detects
drift.
