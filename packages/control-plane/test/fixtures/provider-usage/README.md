# Provider usage protocol sources

These are protocol fixtures, not captured live account responses.

## OpenAI

Pinned official source:
[`openai/codex@922510f4d7570b42838e015787ed53abfa8761a1`](https://github.com/openai/codex/tree/922510f4d7570b42838e015787ed53abfa8761a1).

- [Passive usage endpoint](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/backend-client/src/client/rate_limit_resets.rs):
  `GET https://chatgpt.com/backend-api/wham/usage`. No reset-credit consumption or reserve opt-in.
- [Client headers](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/backend-client/src/client.rs):
  bearer authentication and `ChatGPT-Account-Id`.
- [Payload](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs),
  [limit details](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs),
  and
  [window](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs)
  define nullable windows, integer percentages, durations in seconds, and Unix reset timestamps in
  seconds.
- `openai.json` instantiates the official test case `(Some(true), 100)` in
  [ordinary_usage_permission_comes_from_backend_not_display_percent](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/backend-client/src/client/rate_limit_resets_tests.rs).
  In particular, usage at 100% does not override the independent `allowed` field. Other test values
  are deliberately varied to exercise boundaries and secondary windows.
- [Official app-server documentation](https://developers.openai.com/codex/app-server) exposes
  `account/rateLimits/read`. We reuse its underlying passive HTTP protocol, without starting a CLI
  or exposing auth material.

This implements Codex subscription windows, not API billing, additional model-specific pools,
credits, or a guarantee of inference admission. No live authenticated quota request or Cloudflare
egress qualification was performed.

## xAI and Anthropic

The inspected official
[Grok Build billing implementation at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/billing.rs)
uses a CLI proxy `/billing?format=credits` with Grok.com auth, `X-XAI-Token-Auth`, and `x-userid`.
Its compatibility with the `auth.x.ai` OAuth credentials and scopes held by this installation is not
established. We do not substitute cookie/session credentials or guess an endpoint. xAI is explicitly
unsupported by this implementation.

Anthropic accounts here hold an inference-scoped static setup token, without a verified usage-read
capability. They are explicitly unsupported. This does not assert that either provider lacks usage
APIs.
