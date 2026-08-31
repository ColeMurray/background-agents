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
oi session list --output json
oi session create --title "Investigate" --model openai/gpt-5.6-sol --reasoning high \
  --idempotency-key retryable-create-id
oi mcp serve
```

`oi context list` lists contexts without credentials and `oi context use <name>` switches the active
context. Use `oi login --context <name>` to add or replace one.

`oi session events <id> --follow` reads one complete, checkpoint-pinned initial snapshot and then
follows the append-only change journal without rescanning full history. Each emitted record is an
ordered `upsert` or `delete` change; delete/upsert pairs represent event renames. Incremental
records are emitted in strictly increasing revision order, and a checkpoint advances only after all
cursor pages have completed.

All error modes use the stable `{ "error": { "kind", "message", ... } }` envelope. Text mode renders
the same envelope, while JSON modes serialize it directly. Failed create and prompt requests include
their retry identifier under `error.context` so an unknown outcome can be retried safely. MCP waits
accept at most 300,000 ms, and the complete MCP tool-result envelope is capped at 1 MiB.
