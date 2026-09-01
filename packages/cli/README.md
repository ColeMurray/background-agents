# `@open-inspect/cli`

The `oi` CLI and bundled local stdio MCP server provide the full V1 automation surface: discovery,
targeted session creation, prompts and image attachments, event following, settlement waits, and
read-only session outputs.

Context metadata is stored separately from credentials. Immutable credential references make context
rotation atomic: readers observe either the complete old URL/credential pair or the complete new
pair. The CLI uses `@napi-rs/keyring` for macOS Keychain, Linux Secret Service, and Windows
Credential Manager. If that optional native module is unavailable, it explicitly falls back to an
atomic file in the platform configuration directory. Native operation failures do not copy secrets
into the fallback. The fallback is forced to mode `0600` on POSIX systems; Windows does not provide
equivalent mode guarantees. Use `OPEN_INSPECT_CONFIG_DIR` to relocate and profile the fallback
store.

```bash
oi login --url https://control-plane.example.com
oi auth status
oi session list --limit 50 --offset 0 --output json
oi session create --title "Investigate" --model opencode/kimi-k2.5 \
  --repo-owner acme --repo-name app --attach ./context.png \
  --idempotency-key retryable-create-id
oi repo list --output json
oi environment list --output json
oi session events <session-id> --follow --output stream-json
oi session wait <session-id>
oi mcp serve
```

`oi context list` lists contexts without credentials and `oi context use <name>` switches the active
context. Use `oi login --context <name>` to add or replace one.

Session listing accepts a shared bounded `limit` and zero-based `offset` in both the CLI and MCP
tool. When `hasMore` is true, pass the returned `continuationOffset` as the next offset. Create
reasoning is optional for models without reasoning support; follow-up `--reasoning` remains an
independent optional override.

Before polling, login stores the device authorization secret and recovery metadata. If exchange
issues a credential but local staging or promotion fails, that secret can revoke the issued
credential without bearer plaintext, including after process restart. Newly issued credentials are
also stored under a deterministic reference derived from the server credential ID and recorded as
pending revocation. One atomic promotion installs the new context, changes device recovery to
local-only cleanup, removes the bearer staging marker, and moves any replaced credential to the
pending queue. Login and logout drain both queues. Logout always removes the local active context.
Its result reports `remoteRevocationComplete: false` when remote revocation or queued recovery is
incomplete.

`oi session events <id> --follow` reads one complete, checkpoint-pinned initial snapshot and then
polls the bounded change feed without rescanning full history. Each emitted record is an `upsert` or
`delete` change in forward commit/checkpoint order; delete/upsert pairs represent event renames.
Revision comparisons apply only to records with the same event ID, and the server may coalesce
high-frequency revisions. A checkpoint advances only after all cursor pages have completed. Changes
are retained for up to 24 hours and at most 50,000 revisions per session; an expired checkpoint
causes the CLI to resume from a fresh snapshot.

`oi session prompt <id> [prompt]` accepts prompt text positionally, through `--content`, from
`--content-file` (use `-` for stdin), or as a complete request object through `--input`. Use
`--idempotency-key` to make retries safe; `--client-request-id` remains accepted for compatibility.
Artifact lists remain available through `oi session artifacts <id>`; add `--artifact <id>` to fetch
screenshot or video content as bounded base64. Pull request lists remain available through
`oi session prs <id>`; add `--pr <id>` to retrieve one pull request.

All error modes use the stable `{ "error": { "code", "message", ... } }` envelope. Text mode renders
the same envelope, while JSON modes serialize it directly. Failed create and prompt requests include
their retry identifier under `error.context` so an unknown outcome can be retried safely. MCP waits
accept at most 300,000 ms, and the complete MCP tool-result envelope is capped at 1 MiB.

Exit codes are stable for V1: `0` success, `1` general failure, `2` authentication, `3` invalid
input, `4` conflict/session-state rejection, `5` timeout, `6` transport failure, `7` service
failure, `8` not found, `9` expired checkpoint, `10` rate limited, `11` forbidden, `12` remote
session failure, and `13` incompatible client.
