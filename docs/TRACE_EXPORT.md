# Trace export (schema 2)

Trace export is pull-only NDJSON. Each line is an independent JSON object described by
[`trace-export.v2.schema.json`](schemas/trace-export.v2.schema.json). The control plane does not
send exports to a vendor. This release supports manual downloads, not scheduled warehouse loading.

## Access and routes

Both routes require an active user with `sessions.export` (Owners and Administrators by default, or
a custom role granting it). `sessions.read` alone is insufficient; the bot services cannot export.
For unattended export, see [Unattended export](#unattended-export). Manual bulk downloads use the
web app's `/api/sessions/export` proxy with an authenticated browser session; the web app holds its
service secret and signs the control-plane request server-side. The web app also proxies
single-session downloads at `/api/sessions/:id/export`. Treat downloaded files as sensitive session
data.

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
a CLI.

## Unattended export

The `export` service lets a job (for example a weekly report) export without a browser. It is off
until an operator enables it.

### Enable it

1. Pick the user the job acts as. Prefer a dedicated user with a custom role that grants only
   `sessions.read` and `sessions.export`. The job sees everything that user can see: pinning an
   Owner gives an off-platform secret the Owner's visibility, including audited break-glass reads of
   private sessions through single-session export.
2. Find that user's id. It is the `user_id` of their GitHub identity in D1:

   ```sh
   wrangler d1 execute <database> --remote \
     --command "SELECT user_id FROM user_identities WHERE provider = 'github' AND provider_user_id = '<github user id>'"
   ```

3. Set both Terraform variables, `export_service_actor = "github:<github user id>"` and
   `export_service_user_id = "<user_id>"`, then apply. On a self-hosted control plane, set
   `SERVICE_AUTH_SECRET_EXPORT`, `SERVICE_AUTH_EXPORT_ACTOR` and `SERVICE_AUTH_EXPORT_USER_ID`. The
   service stays off unless all three are set.
4. Read the secret from the sensitive `export_service_secret` output into the job's secret store.

### What it may do

- It acts only as the pinned actor, which must already exist and still belong to the pinned user. A
  request that names any other actor, or none, gets 401. When the service is off, requests get 401
  too.
- The user's own access applies: the user must be active and hold `sessions.export`, and the export
  covers only the sessions that user can see.
- The service can only use `sessions.read` and `sessions.export`, and only on the two export routes
  above. Every other route refuses it with `service_capability_required`.
- Actors are GitHub identities for now, like the GitHub bot's.

### Rotation and revocation

- **Rotate:** `terraform apply -replace='random_password.service_auth_secret_export[0]'`, then
  update the job's secret store. There is one key and no overlap window, so the job fails until it
  has the new secret.
- **Re-pin:** changing either variable replaces the secret, so the old secret cannot act as the new
  user. Update the job's secret store after the apply.
- **Revoke:** set both variables to `""` and apply. This removes the secret and its bindings.
  Suspending the pinned user also stops exports (403) without a deploy.
- **User merge:** if the pinned user is merged into another account, their GitHub identity moves to
  the surviving user and export returns 401. Re-pin to the surviving user if that is intended.

### Signing requests

Treat the secret like a password: whoever holds it can export everything the pinned user can. Each
request carries three headers:

| Header                            | Value                                 |
| --------------------------------- | ------------------------------------- |
| `X-OpenInspect-Service`           | `export`                              |
| `X-OpenInspect-Service-Signature` | `sig1.<timestampMs>.<nonce>.<hmac>`   |
| `X-OpenInspect-Actor`             | The pinned actor, e.g. `github:12345` |

`<nonce>` is 1–64 lowercase hex characters. `<hmac>` is the lowercase hex HMAC-SHA256, keyed with
the secret's UTF-8 bytes, of these nine fields joined with `\n` (no trailing newline):

```text
sig1
export
<timestampMs>
<nonce>
<METHOD, upper case>
<URL pathname, as sent>
<canonical query>
<lowercase hex SHA-256 of the body bytes; of the empty string for GET>
<actor>
```

The canonical query decodes every `key=value` pair, sorts the pairs bytewise by the UTF-8 bytes of
`key + "\0" + value`, re-encodes each key and value with `encodeURIComponent`, and joins them with
`&`. A URL without a query uses the empty string. This self-contained Node.js signer has no
dependencies:

```js
import { createHash, createHmac, randomBytes } from "node:crypto";

function canonicalQuery(search) {
  const pairs = [...new URLSearchParams(search)];
  const sortKey = ([key, value]) => Buffer.from(`${key}\0${value}`, "utf8");
  pairs.sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

function exportHeaders({ url, secret, actor, method = "GET", body = "" }) {
  const { pathname, search } = new URL(url);
  const timestampMs = Date.now();
  const nonce = randomBytes(8).toString("hex");
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const canonical = [
    "sig1",
    "export",
    timestampMs,
    nonce,
    method.toUpperCase(),
    pathname,
    canonicalQuery(search),
    bodySha256,
    actor,
  ].join("\n");
  const hmac = createHmac("sha256", secret).update(canonical).digest("hex");
  return {
    "X-OpenInspect-Service": "export",
    "X-OpenInspect-Service-Signature": `sig1.${timestampMs}.${nonce}.${hmac}`,
    "X-OpenInspect-Actor": actor,
  };
}

const url = `${CONTROL_PLANE_URL}/sessions/export?scope=runs&include=messages,events,usage&limit=5`;
const headers = exportHeaders({
  url,
  secret: process.env.EXPORT_SERVICE_SECRET,
  actor: "github:12345",
});
const ndjson = await (await fetch(url, { headers })).text();
```

Inside this repository, `buildServiceAuthHeaders` in `packages/shared/src/service-auth.ts` produces
the same headers.

A signature is accepted for 5 minutes either side of the control plane's clock and covers the
method, path, query, body and actor. The control plane only logs a reused nonce, per isolate, so a
captured request can be replayed within that window. Call the control plane over HTTPS only and keep
request logs private.

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
