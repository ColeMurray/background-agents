# Fix reasoning effort delivery to OpenCode

The runtime now sends the selected effort through OpenCode's top-level `variant`. This report
records the original bug, the fix, and the verification limits.

## Problem

Previously, the sandbox runtime sent OpenAI and Anthropic reasoning settings inside `model.options`
in prompt requests. OpenCode 1.18.18 accepts only `providerID` and `modelID` in that object. It
discards the extra options, so a valid effort selected in Open-Inspect does not necessarily reach
the provider.

The request-level selector OpenCode accepts is top-level `variant`. Model configuration also accepts
`options`, including OpenAI `reasoningEffort`. The bug is the placement of these options in a prompt
request, not universal lack of support for `reasoningEffort`.

For example, an OpenAI Max selection produced Medium in the saved provider request capture with the
existing payload. Sending `variant: "max"` produced Max. Anthropic Haiku Max produced no thinking
configuration with the existing payload; `variant: "max"` produced an enabled thinking budget of
31,999 tokens.

This is independent of adding any new model or upgrading OpenCode. The verified binary was 1.18.18,
the version pinned by this repository at investigation time.

## Evidence and limits

The local tests ran the actual OpenCode 1.18.18 server against localhost mock provider endpoints and
captured the serialized outbound request. Dummy credentials were used. These tests prove request
translation, not provider acceptance or model quality. Each case used a new OpenCode session.

The tables describe OpenCode 1.18.18 with the tested catalog snapshot. The harness loaded the public
catalog obtained from `https://models.opencode.ai/api.json` during the September 4, 2026
investigation through `OPENCODE_MODELS_PATH`, with `OPENCODE_DISABLE_MODELS_FETCH=1`. Its SHA-256 is
`ef112420273b7e572ef9c87db13a2f30fe1a562c29ea30d365b911889f9ff46c`. Variants depend on this mutable
catalog, so the binary version alone does not fully specify the test environment.

### OpenAI request placement

Test model: GPT 5.6 Sol. No configured effort unless stated.

| Input                                                     | Captured outbound effort |
| --------------------------------------------------------- | ------------------------ |
| No effort override                                        | `medium`                 |
| `model.options.reasoningEffort: "low"`                    | `medium`                 |
| `model.options.reasoningEffort: "max"`                    | `medium`                 |
| Top-level `reasoningEffort: "max"`                        | `medium`                 |
| Top-level `options.reasoningEffort: "max"`                | `medium`                 |
| Top-level `providerOptions.openai.reasoningEffort: "max"` | `medium`                 |
| Top-level `variant: "low"`                                | `low`                    |
| Top-level `variant: "max"`                                | `max`                    |
| Model **configuration** `options.reasoningEffort: "high"` | `high`                   |
| Configured High plus prompt `variant: "max"`              | `max`                    |

The two Low rows were observed during an earlier run. Their result files were subsequently
overwritten by the Max matrix; the Low test script survives, but those historical rows lack
independently reviewable captures. The new contract suite repeats Low against a deliberately
configured High baseline, as described below. The saved investigation captures independently support
the other rows.

Medium is the observed fallback for this tested configuration. This does not prove that every
historical session used Medium. Agent settings, model configuration, plugins, model defaults, and
OpenCode versions can affect the resulting request.

Separate new-model experiments used an explicit custom model configuration and checked Low, Medium,
High, XHigh, and Max through both the API-key path and this repository's managed OAuth plugin with a
mock token broker. All five efforts reached the mock outbound endpoint. These experiments did not
use real inference or real OAuth credentials, and custom model registration is outside this fix.

### Anthropic request placement

| Model      | Selected effort | Existing nested options: outbound thinking | Top-level variant: outbound thinking       |
| ---------- | --------------- | ------------------------------------------ | ------------------------------------------ |
| Haiku 4.5  | High            | absent                                     | enabled, budget 16,000                     |
| Haiku 4.5  | Max             | absent                                     | enabled, budget 31,999                     |
| Sonnet 4.6 | High            | absent                                     | adaptive, output effort High               |
| Sonnet 4.6 | Max             | absent                                     | adaptive, output effort Max                |
| Opus 4.5   | High            | absent                                     | enabled, budget 16,000; output effort High |
| Opus 4.5   | Max             | absent                                     | absent                                     |

Opus 4.5 is a compatibility gap. The tested OpenCode catalog exposed Low, Medium, and High variants,
but no Max. Open-Inspect offers High and Max for that model. A blanket replacement with
`variant: reasoning_effort` would still silently fail for that selection. A variant name being
accepted by the prompt schema does not prove that the selected model defines it.

### Live Haiku observation recorded during investigation

This comparison was observed through the deployment terminal and recorded in the investigation
conversation. No standalone live capture was retained for independent review, and the independent
reviewer did not reproduce this live test.

A separate, disposable deployment session used Haiku 4.5 with Max selected and the prompt
`Reply only READY. Do not run tools or modify files.` The model replied successfully. The stored
OpenCode user message had no variant, and the assistant parts were `step-start`, `text`, and
`step-finish`.

A fresh OpenCode session in the same sandbox received the same small prompt with an explicit
top-level `variant: "max"`. It also succeeded, returned `READY`, and included a `reasoning` part.
The running provider configuration defined Max as
`thinking: {type: "enabled", budgetTokens: 31999}`. Together with the local wire capture, this
verifies a working Haiku fix path using a real provider.

No live Sonnet or Opus inference was performed. Absence of a stored variant alone is not sufficient
to infer the effective provider settings; inspect configuration and the outgoing request as well. No
historical provider request was recovered.

## Source and history

The affected builder is `packages/sandbox-runtime/src/sandbox_runtime/prompt_stream.py`,
`_build_prompt_request_body`. Existing tests in
`packages/sandbox-runtime/tests/test_bridge_message_tracking.py` assert the nested options shape, so
they currently preserve the faulty contract.

OpenCode's
[prompt schema](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/session/prompt.ts)
accepts top-level `variant`. Its
[LLM request construction](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/session/llm.ts)
and
[provider transformation](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/provider/transform.ts)
resolve the selected variant into provider options. The
[request option merge](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/session/llm/request.ts#L73-L84)
applies base options, model options, agent options, then the selected variant. A missing variant
contributes no override.

The nested request shape was introduced on February 8, 2026 in
[PR #83](https://github.com/ColeMurray/background-agents/pull/83), commit `3679f189`. OpenCode
source inspected from that date already exposed `variant` and no prompt `model.options`. This
supports the likely origin of the bug; it is not a test of every intervening release or deployment.

## Implementation

Prompt requests now send top-level `variant` for OpenAI and Anthropic, as the existing xAI path
already did. No effort still omits the selector. Message IDs, model IDs, and attachments retain
their existing handling.

At OpenCode startup, the runtime defines High and Max variants for Haiku 4.5, Sonnet 4.5, and Opus
4.5 with the application's established thinking budgets of 16,000 and 31,999. Defining all three
lets sessions switch models. Defining a variant does not select it or activate thinking by default.

OpenCode merges these definitions with generated variants. Opus 4.5 High retains its supported
output effort High. Its new Max variant specifies only the larger thinking budget; it does not send
an unsupported output effort Max. Adaptive Anthropic and OpenAI models continue to use OpenCode's
generated variants. No model catalog selections or OpenCode version pins change in this PR.

The tests exercise the actual startup configuration and prompt builder. The opt-in contract suite
runs the pinned binary against fake localhost providers and a checked-in public catalog subset. It
covers every OpenAI/Anthropic model in the shared catalog at implementation time, all fixture effort
values, manual budgets, adaptive output efforts, omission, an agent default, explicit overrides,
model switches, and ignored alternative request fields. The existing bridge tests cover xAI's
unchanged path, legacy bare Anthropic IDs, and other request fields.

Low is now repeated in the contract suite, including the corrected variant and all four ignored
placements. Unlike the earlier Medium-baseline investigation, the contract suite deliberately
configures a High agent default and proves that ignored fields leave that default unchanged. The
serialized request assertions are reproducible; raw request payloads are not written to disk.

### Recorded checks

- Real OpenCode 1.18.18 contract suite: 3 passed, including 77 model/effort pairs,
  default/model-switch cases, and the negative request-placement matrix.
- Focused runtime unit tests: 67 passed.
- Full runtime suite: 789 passed, 3 opt-in contract tests skipped, 3 failed. Two failures were
  localhost socket restrictions and passed when rerun with sockets enabled. The remaining
  Git-signing test expects a `-U` argument absent from this macOS Git invocation; the unchanged
  upstream test reproduces it.
- Runtime Ruff lint, changed Python-file formatting, and the full repository Prettier check passed.
- Local mypy reports five errors in unchanged `managed_skills.py` and `auth/github_app.py`. Running
  the same check against an extracted upstream source tree reproduces the identical five errors.

The tests retain only model and reasoning settings from mock requests. They use explicit session
titles so auxiliary title generation cannot contaminate captures.

### Run the contract tests

From `packages/sandbox-runtime`, with the package's test dependencies installed:

```sh
npm install --prefix /tmp/opencode-reasoning-test opencode-ai@1.18.18
OPENCODE_TEST_BINARY=/tmp/opencode-reasoning-test/node_modules/.bin/opencode \
  PYTHONPATH=src pytest tests/test_opencode_reasoning_contract.py -v
```

Without `OPENCODE_TEST_BINARY`, these three tests skip during the normal unit suite. They require
localhost socket access. Provider keys are fake, model fetching is disabled, and
config/cache/data/state are isolated. The fixture's source and checksum are recorded in
`tests/fixtures/reasoning-models.md`.

The retained live Haiku observation verifies provider acceptance of the corrected request shape; it
is not a deployment of this code change or a live test of every model. Contract mocks prove
serialization, not each provider's current acceptance of every effort. Arbitrary repository or agent
configuration can still contribute provider options through OpenCode's normal merge rules.

## Reproduce in a disposable sandbox

Use an existing authenticated OpenCode server. Do not print its environment, auth files, request
headers, or full provider configuration. First record `opencode --version`. On the server's
localhost port, these are the two payloads for separate new sessions:

```json
{
  "model": {
    "providerID": "anthropic",
    "modelID": "claude-haiku-4-5",
    "options": { "thinking": { "type": "enabled", "budgetTokens": 31999 } }
  },
  "parts": [{ "type": "text", "text": "Reply only READY. Do not run tools or modify files." }]
}
```

```json
{
  "model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" },
  "variant": "max",
  "parts": [{ "type": "text", "text": "Reply only READY. Do not run tools or modify files." }]
}
```

Create each session with `POST /session`, then submit its payload to `POST /session/<id>/message`.
Inspect only the response error, text, and part types. `GET /session/<id>/message` exposes the
stored user variant. `GET /provider` can be filtered to the selected model's `variants`. Never
publish the session IDs, terminal links, credentials, or full logs. Raw mock captures can also
contain generated prompts, tool definitions, and local environment metadata; publish only
allowlisted result fields.

## Verification scope

Every OpenAI/Anthropic effort in the checked-in fixture reaches the asserted provider settings on
OpenCode 1.18.18. The fixture includes every effort offered by this repository for those models at
implementation time. Additional OpenAI efforts in the provider catalog are exercised by the test
without enabling them in Open-Inspect. Recheck this contract when the catalog or binary changes.
