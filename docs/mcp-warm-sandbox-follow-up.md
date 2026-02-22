# MCP Warm Sandbox Follow-up

Date: 2026-02-21

MCP v1 intentionally excludes warm sandbox wiring. The warm path (`api_warm_sandbox` and
`SandboxManager.warm_sandbox`) currently creates sandboxes without repository-scoped MCP config and
without secret-ref resolution for MCP server settings.

## Follow-up Scope

- Add MCP config retrieval for warm sandbox creation.
- Thread `mcp_config` through warm sandbox create calls.
- Align warm behavior with create/restore semantics for missing secret refs (non-blocking +
  diagnostics).
- Add tests for warm path parity with regular spawn behavior.
