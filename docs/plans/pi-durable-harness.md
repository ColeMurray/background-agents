# Pi Durable Harness

## Summary

Add Pi Durable as an additive Open-Inspect harness for instant, durable sessions that run in a
Cloudflare Durable Object without provisioning a sandbox. Existing OpenCode, Claude Agent, Codex,
and sandbox-backed sessions remain unchanged. Pi initially supports OpenAI Codex subscription
accounts brokered by the Open-Inspect control plane; the optional `pi-claude-code` plugin is out of
scope.

The product exposes Pi as a harness and records its execution backend as durable. A Pi session uses
a dedicated `PiSessionDO` namespace. It must not share SQLite storage or alarm ownership with the
existing `SessionDO`.

```text
Web / Slack / Automations
           |
           v
       SessionDO
           |
           +-- OpenCode / Claude / Codex --> sandbox bridge
           |
           +-- Pi Durable ----------------> PiSessionDO
                                                |
                                                +-- remote tools / MCP / web
                                                +-- durable inbox and tasks
                                                +-- Codex subscription broker
```

## Goals

- Provision Pi sessions without creating a sandbox row or warming E2B.
- Preserve Open-Inspect's existing session, team, visibility, participant, message, budget,
  callback, and audit contracts.
- Stream Pi activity through the existing normalized sandbox-event contract so current web and bot
  clients continue to work.
- Keep D1 as the authority for provider accounts. No refresh token, GitHub App private key, or
  long-lived provider credential is stored in Pi Durable Object storage.
- Support OpenAI Codex subscription accounts only in the first release.
- Recover admitted prompts after Durable Object eviction without duplicate model calls or side
  effects.
- Keep the feature disabled unless the deployment has the Pi Durable binding and explicitly enables
  the harness.

## Non-goals

- Replacing existing sandbox harnesses.
- Running local shell, native binaries, code-server, VNC, or repository builds in Pi.
- Adding the optional `pi-claude-code` plugin.
- Adding Cloudflare Computer, Browser Run, container escalation, multi-conversation Slack channels,
  or self-modifying applications in the first implementation.
- Moving existing sessions between harnesses.
- Admitting repository-backed Pi sessions before remote repository tools are available.
- Persisting provider refresh tokens inside the Durable Object.

## Dependencies and maturity

Pin exact versions in the first implementation:

- `agents` 0.28.x
- `@earendil-works/pi-durable` 1.3.x
- `@earendil-works/pi-ai` 1.3.x
- `@earendil-works/chord` at the version required by Pi Durable

Pi Durable is MIT licensed. Cloudflare's `PiHarness` is beta and Pi Durable still documents its API
as experimental. Exact pins and contract tests are therefore required; updates are deliberate, not
automatic.

Chord 1.3 uses `WeakRef` for draft pruning. Cloudflare Workers exposes the native implementation
only with the official `enable_weak_ref` compatibility flag, so both production Terraform and the
workerd test configuration enable that flag. No global polyfill or package patch is used.

## Behavior

### Admission

```gherkin
Scenario: Pi is disabled for a deployment
  Given Pi Durable is not enabled or its binding is absent
  When a user attempts to create a Pi session
  Then creation is rejected before a session or runtime row is written
  And existing harnesses are unaffected

Scenario: Pi receives a supported connected OpenAI account
  Given Pi Durable is enabled
  And the selected model is supported by Codex subscription auth
  And the actor selected an active OpenAI provider account
  When the session is created
  Then the session is initialized with harness pi
  And no sandbox row is created
  And the Pi runtime is initialized in the matching PiSessionDO

Scenario: Pi receives an unsupported auth mode
  When a Pi session selects an API key, legacy OAuth, Anthropic, or xAI account
  Then admission fails with a harness compatibility error
  And no execution is started
```

### Prompt delivery

```gherkin
Scenario: A prompt is durably admitted once
  Given a prompt is pending for a Pi session
  When SessionDO dispatches it to PiSessionDO
  Then the Open-Inspect message id is used as Pi's request id
  And retries return the original Pi submission
  And the prompt is not executed twice

Scenario: Pi completes a prompt
  When Pi streams text, reasoning, tools, usage, and completion
  Then PiSessionDO translates them to Open-Inspect events
  And SessionDO persists and broadcasts them through its existing event processor
  And the message, callback, budget, and automation lifecycle settle normally

Scenario: Pi is interrupted
  When Open-Inspect cancels or stops a running Pi prompt
  Then the matching Pi operation is aborted
  And pending messages remain ordered
  And the final Open-Inspect message state is terminal exactly once
```

### Recovery

```gherkin
Scenario: PiSessionDO is evicted during work
  Given a prompt was durably submitted
  When the object restarts
  Then PiHarness reopens its prefixed SQLite tables
  And its lifecycle wake resumes unfinished safe work
  And SessionDO accepts repeated translated events idempotently
```

## Harness catalog

Add `pi` to the shared harness catalog with:

- label: `Pi Durable`
- strict selection policy
- model family: OpenAI only
- provider auth: OpenAI `provider_account` only
- reasoning configuration: Codex-compatible effort rules
- resume: persisted Pi conversation/session id

The deployment admission check must also require Pi to be enabled and reachable. A static catalog
entry is not authorization to execute it.

## Runtime ownership

### SessionDO remains authoritative for

- workspace and team authorization
- session visibility and participants
- prompt ordering and status
- callbacks and Slack/GitHub publication
- budgets and usage aggregation
- Open-Inspect memories and managed skills
- child-session relationships
- UI event persistence

### PiSessionDO owns

- Pi transcript and inbox
- Pi tasks and checkpoints
- model/tool execution state
- Pi usage records used to produce Open-Inspect usage events
- Pi Lifecycle wake jobs
- short-lived in-memory Codex access tokens

## Pi runtime port

Introduce a control-plane port instead of coupling session services to a Durable Object binding:

```typescript
interface PiRuntimeDispatch {
  submit(input: PiRuntimePrompt): Promise<PiRuntimeReceipt>;
  abort(sessionId: string, operationId?: string): Promise<boolean>;
  status(sessionId: string): Promise<PiRuntimeStatus>;
}
```

Cloudflare adapts the `PI_SESSION` Durable Object namespace to this port. Node hosts either omit the
port and reject Pi admission or provide a test adapter.

## Queue integration

Extract the sandbox-only dispatch branch in `SessionMessageQueue` behind a runtime dispatcher.
Sandbox behavior remains byte-for-byte compatible. The Pi dispatcher:

1. resolves model, reasoning, participant, provider auth, and budget through existing services;
2. atomically claims the pending message and persists the user event;
3. submits to Pi with `operationId = message.id`;
4. broadcasts processing state and schedules the existing execution deadline;
5. lets PiSessionDO send normalized events back to `SessionDO`;
6. restores the message to pending only when Pi proves it never admitted the request.

An ambiguous response is recovered by looking up Pi's receipt by request id, never by resubmitting
with a new id.

## Event translation

Pi's snapshot-plus-events stream is translated into the existing Open-Inspect event vocabulary:

| Pi activity                            | Open-Inspect event                              |
| -------------------------------------- | ----------------------------------------------- |
| committed user input                   | `user_message` (SessionDO already emits it)     |
| assistant text delta/snapshot          | `token`                                         |
| reasoning delta/snapshot               | `token` with reasoning metadata where supported |
| model request start                    | `step_start`                                    |
| model response usage                   | `step_finish`                                   |
| tool admitted/running/completed/failed | `tool_call` snapshots                           |
| compaction                             | `context_compacted`                             |
| terminal answer                        | `execution_complete`                            |
| terminal error                         | `error` then `execution_complete`               |

Every translated event includes the Open-Inspect message id and a deterministic event identity or
monotonic sequence. Replayed Pi commits must upsert rather than duplicate timeline records.

## Codex subscription brokerage

Open-Inspect already stores and rotates OpenAI provider accounts centrally. Pi receives no refresh
token.

Implement a Pi AI `CredentialStore` scoped to one Open-Inspect session:

1. map Pi provider `openai-codex` to Open-Inspect provider `openai`;
2. fetch a short-lived access token from the existing session-bound control-plane broker;
3. return an in-memory Pi OAuth credential with the real access token, sentinel refresh value, and
   broker expiry;
4. never persist that credential in Pi storage;
5. serialize refreshes per provider and retain only an in-memory access-token cache;
6. reject broker denial without falling back to deployment API keys.

The JWT access token already carries the ChatGPT account id used by Pi's Codex transport. Pi's
built-in `openai-codex` provider handles request shape, model filtering, reasoning and transport.

## Tools

The foundation PR exposes no tools: an empty registry is safer than accidentally granting sandbox or
deployment capabilities before replay contracts exist. The tools/product-surface phase adds only
control-plane-backed, replay-classified tools:

- memory read/search/write
- child-session spawn/status/prompt/cancel
- Slack notify
- remote MCP/API tools explicitly marked Pi-compatible

Each tool declares replay behavior. Reads may be replay-safe. Mutations are replay-unsafe unless
their control-plane endpoint accepts a stable idempotency key derived from Pi's task id.

Filesystem, shell, Git, pull-request creation from local changes, and sandbox-only MCP servers are
not offered to Pi conversations.

## Security

- PiSessionDO is reachable only through a binding or authenticated internal service route.
- SessionDO reauthorizes team membership, repository grants, provider-account eligibility, and
  budgets before dispatch.
- Pi tools call session-scoped control-plane endpoints; they do not receive database bindings or
  deployment credentials.
- Provider and GitHub refresh tokens, GitHub App keys, Slack bot tokens, and Executor PATs never
  enter Pi SQLite.
- Tool outputs, MCP responses, webhook payloads, and browser content remain untrusted data.
- Mutating tools retain Open-Inspect approval and audit requirements.

## Product integration

- Add Pi Durable to web, Slack, Linear, repository defaults, and automation harness selectors only
  when the deployment advertises Pi availability.
- Sidebar/session detail uses the Pi harness badge and an `Instant` runtime indicator.
- Pi sessions have no code-server, VNC, sandbox dashboard, repository diff, or local terminal UI.
- Slack and automation continuations reuse the same Open-Inspect session and Pi root conversation.
- If local compute is needed, Pi can explicitly spawn a linked sandbox child session; automatic
  in-place runtime mutation is out of scope.

## Cloudflare and Terraform

- Add a new SQLite-backed `PiSessionDO` class and `PI_SESSION` binding.
- Add an explicit Durable Object migration tag for existing deployments.
- Add `PI_DURABLE_ENABLED` with a default of false.
- Keep the new binding additive; do not rename or migrate `SessionDO`.
- Enable structured logs and measure bundle/startup size before rollout.
- Do not share one SQLite namespace between SessionDO and PiSessionDO.

## Testing

### Shared contracts

- Pi harness catalog, labels, model filtering, reasoning and auth compatibility.
- Session/automation/Slack schemas accept and preserve `pi`.

### Control plane

- disabled/unavailable admission fails before persistence;
- Pi initialization creates no sandbox row;
- dispatch uses message id as the Pi operation id;
- accepted, duplicate, unavailable, denied, abort, timeout and recovery paths;
- translated events settle existing message, callback, budget and automation services;
- existing sandbox queue tests remain unchanged and green.

### Durable Object

- real SQLite-backed PiHarness with Cloudflare Workers Vitest;
- storage conformance and migrations;
- eviction/restart recovery;
- duplicate submission receipt;
- safe and unsafe tool interruption;
- Codex broker denial and expiry without real provider credentials;
- no credential values in SQLite or logs.

### Web and bots

- harness selectors, labels and provider-account controls;
- Pi unavailable messaging;
- Slack session creation, target clarification, continuation and completion;
- automation create/edit/run with Pi;
- no sandbox-only controls in Pi session UI.

## Observability

Add structured fields:

- `harness=pi`
- `execution_backend=durable_object`
- Pi session/operation ids
- prompt admission and first-token latency
- cold-start/open latency
- recovery count and wake reason
- tool replay classification
- provider broker latency/version
- token and cost usage
- sandbox avoidance count
- sandbox child escalation count

Never log prompt contents or credentials.

## Rollout

1. Merge dependencies, contracts, PiSessionDO and tests with the feature disabled.
2. Deploy the additive DO migration without enabling Pi selection.
3. Run fake-provider and internal canaries.
4. Enable one test team and API-created sessions.
5. Enable one Slack channel for no-repository requests.
6. Enable analysis-only automations.
7. Measure latency, recovery, cost and broker failures.
8. Expand only after a soak period; keep a deployment-wide kill switch.

Rollback disables new Pi admission. Existing Pi sessions may finish or be interrupted and restarted
as sandbox child sessions. Removing the Durable Object class or deleting its storage is a separate,
deliberate migration and is never part of rollback.

## Phased pull requests

1. **Design and contracts** — this plan, shared harness catalog, feature flag and schemas.
2. **Pi runtime foundation** — dependencies, PiSessionDO, runtime port, fake provider and DO tests.
3. **Prompt/event bridge** — queue dispatch, translation, recovery and abort.
4. **Codex brokerage** — ephemeral credential store and provider-account tests.
5. **Tools and product surfaces** — controlled tools, web, Slack and automations.
6. **Terraform and canary controls** — additive binding/migration, metrics and runbook.

## Acceptance gates

- All existing suites pass without updating expected sandbox behavior.
- Pi is unreachable when disabled.
- A Pi prompt survives a DO restart and settles once.
- Duplicate dispatch does not duplicate a model request.
- Real refresh tokens never reach Pi storage, config, events, logs or tool output.
- A broker denial never falls back to an API key.
- Slack and automation completion use existing callback/publication gates.
- No sandbox is created for a Pi session.
- Terraform changes are additive and reviewed separately before any production enablement.

## Future work

- Cloudflare Computer durable VFS and JavaScript execution.
- Browser Run and reusable browser sessions.
- Remote MCP and Pi Code Mode catalogs.
- Durable schedules, multiple conversations, forks and search subagents.
- Edge-first analysis with explicit linked sandbox escalation.
- Optional Claude subscription support through `pi-claude-code` only after a separate security and
  provider-terms review.
