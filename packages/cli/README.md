# `@open-inspect/cli`

Increment 1 provides the `oi` CLI and a local stdio MCP server for repository-less, text-only
external sessions.

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
  --idempotency-key retryable-create-id
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
pending queue. Login and logout drain both queues. Logout removes the active context only after all
recoveries and revocations succeed or are definitively invalid; transport, rate-limit, and service
failures preserve retry handles.

`oi session events <id> --follow` reads one complete, checkpoint-pinned initial snapshot and then
polls the bounded change feed without rescanning full history. Each emitted record is an `upsert` or
`delete` change in forward commit/checkpoint order; delete/upsert pairs represent event renames.
Revision comparisons apply only to records with the same event ID, and the server may coalesce
high-frequency revisions. A checkpoint advances only after all cursor pages have completed. Changes
are retained for up to 24 hours and at most 50,000 revisions per session; an expired checkpoint
causes the CLI to resume from a fresh snapshot.

All error modes use the stable `{ "error": { "kind", "message", ... } }` envelope. Text mode renders
the same envelope, while JSON modes serialize it directly. Failed create and prompt requests include
their retry identifier under `error.context` so an unknown outcome can be retried safely. MCP waits
accept at most 300,000 ms, and the complete MCP tool-result envelope is capped at 1 MiB.
