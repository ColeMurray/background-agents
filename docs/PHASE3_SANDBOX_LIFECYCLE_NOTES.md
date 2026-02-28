## Phase 3: Sandbox Lifecycle Contract Stabilization

### Decisions

- **Timeout propagation**: `timeout_seconds` is now validated and forwarded through
  `api_create_sandbox` into `SandboxConfig.timeout_seconds`, preserving caller intent for fresh
  sandbox creates.
- **Restore branch propagation**: restore now carries `session_config.branch` into sandbox
  `SESSION_CONFIG`, so restored sandboxes keep branch context identical to fresh spawns.
- **Error contract normalization**: Modal web APIs now return a consistent response shape for
  failures:
  - HTTP non-2xx status
  - `{ "success": false, "error": { "code", "message", "status_code", "details?" } }`
- **Control-plane client hardening**:
  - request timeouts for all Modal API calls
  - bounded retries only on safe paths (`health`, `getLatestSnapshot`, `deleteProviderImage`)
  - structured error parsing for non-2xx responses and `success: false` bodies
- **Correlation IDs**: lifecycle manager now generates and passes correlation context (`trace_id`,
  `request_id`, `session_id`, `sandbox_id`) consistently for spawn/restore/snapshot provider calls.

### Risks

- Error body format changed from string-only errors to structured errors. Existing clients that
  assume `error` is always a string must parse either shape.
- Retry behavior, while bounded and limited to safe operations, slightly increases upstream request
  volume during transient failures.

### Rollout Considerations

- Deploy control-plane and modal-infra changes together to maximize compatibility.
- Monitor 4xx/5xx rates and timeout/retry logs (`modal.request`, `modal.http_request`) after rollout
  to validate improved resilience.
- Keep an eye on warning logs from local Modal test execution; these are expected in unit tests
  invoking `.local`.
