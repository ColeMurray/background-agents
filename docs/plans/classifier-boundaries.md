# Classifier Protocol and Policy Boundaries

## Context

Follow-up to [PR #2307](https://github.com/ColeMurray/background-agents/pull/2307), reviewed on
`main` at `c33bc21` after the Bedrock support merged. The review covered shared classification
plumbing, both bot classifiers and their callers/tests, Terraform provider selection and bindings,
deployment workflow inputs, and the operational documentation.

The objective is a behavior-preserving refactor: make protocol compatibility changes local, make bot
policy visible, and reduce the amount of provider-specific code a reader must track.

## Review Conclusions

| Observation                                                                                                                                                   | Decision                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI transport returns an unknown payload, but Messages API paths also validate bot-specific results. Each bot repeats validation across provider wrappers. | Return unknown structured payloads from both paths and validate once after dispatch in each bot.                                                                |
| Messages API request policy and tool extraction are duplicated. The output-token budget is defined twice.                                                     | Share a small request builder, one token-budget constant, and named-tool extraction. Keep bot schemas and prompts local.                                        |
| Slack constructs and caches its SDK client inside the classifier class.                                                                                       | Inject the model caller through the constructor. Keep protocol dispatch, lazy SDK construction, and caching in the existing production factory.                 |
| OpenAI accepts credentials/model as separate arguments while Messages API callers accept a resolved target.                                                   | Pass the resolved OpenAI target directly; there are no other repository consumers requiring a compatibility wrapper.                                            |
| Both bot environment interfaces restate classifier credentials and reasoning configuration.                                                                   | Extend the shared environment contract, preserving Slack's required model binding.                                                                              |
| Linear repeats repository matching and comment escaping.                                                                                                      | Reuse the local escaping helper and one local repository lookup without changing normalization or alternative ordering.                                         |
| Terraform already centralizes provider selection and secret bindings; its grammar is necessarily implemented in a different language.                         | Preserve this structure and shared model-ID fixtures. Add exact workflow-input assertions for all classifier credentials, model fallback, and reasoning effort. |

## Implementation Plan

1. Add shared Messages request construction and envelope/tool extraction, independent of the
   Anthropic SDK. Keep helpers specific to classification rather than introducing a provider
   registry, generic classifier base class, or transport framework.
2. Change OpenAI transport to consume its resolved target. Extend the shared environment interface
   with reasoning effort and reuse it in both bots.
3. Remove provider-specific domain-validation wrappers. Keep validation immediately after protocol
   dispatch. Move Slack's SDK construction to `createClassifier` and pass its caller into
   `RepoClassifier`; preserve lazy initialization so deterministic routes need no keys.
4. Apply the small Linear matching/escaping cleanup. Move envelope tests to shared, retain bot
   request-wiring tests, and add cross-provider domain-validation and shortcut tests. Restore test
   spies after every Slack classifier test.
5. Strengthen exact plan/apply input assertions without changing workflow or Terraform behavior.
6. Build shared first; run targeted shared, Slack, Linear, and workflow tests sequentially with one
   Vitest worker. Typecheck the affected packages, lint changed code, and review the final diff for
   unnecessary abstractions before opening a PR.

## Compatibility Constraints

- Preserve provider/model parsing, selected-provider credentials, endpoint paths, timeouts,
  reasoning effort, SDK retries, and the default model. No new configuration or migration.
- Preserve Messages API `tool_choice: auto`, the tool-use system instruction, omitted temperature,
  and each bot's schema. Slack alone retains `disable_parallel_tool_use: true`; Linear continues to
  omit `additionalProperties` on its Messages API tool schema.
- Preserve the first matching named tool block; do not interpret JSON-looking text as tool output or
  start enforcing an exactly-one-tool response rule.
- Keep Slack's trimming, confidence normalization, escaped reasoning, alternative deduplication, and
  repository-less confirmation. Keep Linear's stricter confidence parsing, untrimmed identifiers,
  and existing alternative ordering/duplicates.
- Keep deterministic Slack routes and Linear's zero/one-repository shortcuts ahead of model
  resolution. Do not change catalog authorization, snapshot lifetime, or cache behavior.
- Keep bot-specific error logging and user-facing clarification results. Protocol envelope errors
  may use shared wording; domain validation errors become provider-neutral.

## Verification and Limits

Shared tests own request defaults, response-envelope validation, named-tool selection, and
model/credential resolution. Bot tests retain real transport wiring with mocked network/SDK
boundaries and cover valid/invalid domain payloads across Anthropic, Bedrock, and OpenAI. Explicit
tests must protect routing bypass, lazy SDK creation/reuse, clarification, and the different bot
normalization policies. Workflow tests assert exact plan/apply expressions.

No live AWS calls, deployment, IAM changes, or Terraform structural changes are planned. Tests
cannot establish regional model availability, live credentials, or provider latency. Broader
routing/catalog decomposition and behavioral changes to normalization are outside this refactor.

## Implementation Outcome

Implemented the scope above. The final simplification pass moved both protocol branches into Slack's
existing factory, so the class receives one model caller and contains no SDK or OpenAI dispatch. The
now-single-use normalization wrapper was inlined at the validation boundary. No transport framework,
runtime dependency, configuration change, or migration was added.

Local verification passed:

- Shared package build and shared/Slack/Linear typechecks.
- Shared classification tests: 58 passed.
- Slack classifier tests: 70 passed.
- Linear classifier tests: 50 passed.
- Terraform workflow-contract and plan-comment tests: 27 passed.
- ESLint, Prettier, and `git diff --check` for the changed files.

An independent final diff review found no actionable regressions. Its two coverage suggestions were
included: preserving Linear's Messages schema omission of `additionalProperties`, and escaping
trigger-comment markers inside the original wrapper. No live provider requests or Terraform
plan/apply were run.
