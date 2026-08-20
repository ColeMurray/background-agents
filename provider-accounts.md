# Provider Accounts and Subscription Selection

## Status

Implemented V1 architecture. D1 migrations `0064_provider_accounts.sql` and
`0065_provider_account_authorizations.sql`, the shared contracts, and the control-plane routes are
the executable sources of truth. This document records the stable data, lifecycle, selection, and
runtime boundaries, including coexistence with existing managed OAuth secrets.

## Summary

Open-Inspect should let admitted users connect multiple subscription-backed AI provider accounts,
manage them in one Settings experience, choose which account a session uses, and define
deterministic defaults for Slack, GitHub, Linear, automations, and other launches that do not
currently expose an account selector.

V1 introduces five concepts:

- **Provider account**: a stable, installation-wide connection to one provider account or workspace.
- **Provider credential**: encrypted, provider-specific authentication state for that account.
- **Provider default**: the installation-wide account selected by default for a provider.
- **Session provider auth**: immutable account, API-key, or legacy scoped-OAuth mode for one
  provider in one session.
- **Automation provider auth**: an optional account or API-key mode pinned to an automation.

The control plane owns credentials and refreshes them through provider-specific adapters. Sandboxes
continue to receive only short-lived access material through a session-authenticated broker. A
session stores stable provider-account IDs, never credentials, and does not silently move to another
account when defaults or credentials change.

OpenAI and xAI are the V1 subscription providers. Existing API-key credentials remain in generic
secrets, while provider auth rows make the choice between account and API-key mode explicit.

## Decisions

| Area                | V1 decision                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Primitive           | Model connections as provider accounts, not comma-separated secrets or load-balancing pools.      |
| Providers           | OpenAI and xAI behind provider-specific credential adapters.                                      |
| Ownership           | Installation-wide, matching the current single-tenant trust model; retain creator audit metadata. |
| Credentials         | Separate encrypted credential row with a versioned, provider-validated payload.                   |
| Defaults            | At most one installation-wide default account per provider.                                       |
| Resolution          | Explicit auth mode, unattended policy when relevant, default account, then legacy compatibility.  |
| Sessions            | Pin provider auth rows at creation; never consult moving defaults during token refresh.           |
| Provider switching  | Snapshot auth for each configured subscription provider so later model changes are stable.        |
| Children            | Inherit all parent auth rows; agent child-spawn requests cannot override them.                    |
| Automations         | May pin either auth mode; omission resolves policy independently for each run.                    |
| Bots                | Slack, GitHub, and Linear omit choices and use the unattended provider policy.                    |
| Failure policy      | Never fail over to another paid account implicitly.                                               |
| Existing API keys   | Remain generic secrets; do not reinterpret API keys as subscription accounts.                     |
| Usage               | Record account attribution now; defer provider quota collection to supported provider adapters.   |
| Personal accounts   | No personal/private visibility in V1 because the product has no matching session isolation model. |
| Direct hosted OAuth | Deferred until each provider's approved client and redirect requirements are confirmed.           |

## Motivation

Current OpenAI and xAI OAuth credentials are fixed keys in generic global, repository, or
environment secret stores. That representation supports only one effective credential bundle per
scope and does not provide:

- a stable ID for a connected provider account;
- multiple accounts in the same scope;
- a display name, connection status, or reconnect workflow;
- an account selector during session creation;
- deterministic account attribution on sessions and automations;
- a formal default for launchers without selectors;
- a safe place to attach future usage or quota observations;
- provider-neutral behavior as subscription authentication expands.

Comma-separated values cannot provide these properties. They also make token rotation ambiguous,
prevent atomic account updates, obscure which account handled a request, and introduce implicit
billing failover. Provider accounts make each credential lifecycle explicit and independently
auditable.

## Goals

- Manage multiple connected accounts for each subscription-backed model provider.
- Present all provider accounts in a first-party Settings experience.
- Let an initiating web user explicitly choose the account used by a session.
- Give unattended launch paths deterministic account/API-key policy.
- Surface legacy managed OAuth secrets so operators can connect provider accounts and retire legacy
  credentials deliberately, without importing or translating them.
- Pin provider-account choices to sessions for reproducibility and attribution.
- Keep long-lived credentials control-plane-only.
- Centralize provider-neutral refresh, cache, concurrency, and lifecycle behavior.
- Keep provider-specific authentication formats and endpoints behind typed adapters.
- Support future provider usage retrieval without requiring it for V1.
- Preserve a clean path to real personal ownership and authorization when the product gains matching
  workspace, session, and repository isolation.

## Non-Goals

- Round-robin, random, quota-aware, or failure-based load balancing.
- Automatically moving an active session to another account.
- Combining allowance from multiple provider subscriptions.
- Guaranteeing access to undocumented provider quota or billing endpoints.
- Replacing all provider API keys with provider accounts.
- Adding a workspace, membership, administrator, or role model only for this feature.
- Treating `created_by` as an authorization boundary.
- Allowing agents to choose billing accounts for child sessions.
- Changing provider accounts during a running session in V1.
- Hosted OAuth using another application's client ID without provider approval.
- Sharing accounts across separate Open-Inspect installations.

## Terminology

### Provider

A model vendor with subscription-backed authentication supported by Open-Inspect. V1 provider IDs
are `openai` and `xai`.

Provider IDs are stable protocol and database identifiers. UI names such as "ChatGPT" or "SuperGrok"
must not be persisted as provider identity.

### Provider account

A stable Open-Inspect catalog record representing one usable provider account, organization, or
workspace. The record has an opaque local ID. It may also have a provider-supplied external account
ID, but sessions and defaults always reference the local ID.

The UI may call these "provider accounts" or "connected subscriptions." Internally,
`ModelProviderAccount` avoids collision with Better Auth and SCM provider-account identifiers:
authentication identifies an account or workspace, while plan and entitlement details may change.

### Provider credential

The encrypted authentication state associated one-to-one with a provider account. The payload is
opaque to generic storage and parsed only by the matching provider adapter. Its version supports
optimistic concurrency during rotating refresh-token exchanges.

### Provider default

The installation-wide provider account used when a session does not explicitly select one. Defaults
are moving configuration. They are resolved when a session starts and are never consulted by that
session again.

### Session provider auth

The provider-account, API-key, or legacy scoped-OAuth mode pinned to a session for one provider.
Account-mode rows include a concrete account ID. All modes retain routing provenance and are runtime
authorization inputs; they contain no credential data.

## Current Architecture

### Identity and tenancy

Open-Inspect has canonical users and resolves browser and integration actors to canonical user IDs.
The deployment is nevertheless single-tenant: admitted users share repository access, settings,
secrets, environments, and session visibility. There are no workspace memberships, roles, or private
sessions.

V1 provider accounts are therefore installation-wide. `created_by` and `updated_by` are audit
metadata, not ownership checks. A personal/private account flag would imply an isolation boundary
that the rest of the product cannot enforce: other admitted users can discover and participate in
sessions, and prompts in a shared session consume its pinned provider account regardless of prompt
author.

If personal provider accounts become a requirement, the prerequisite design must cover session
visibility, repository authorization, account ACLs, bot identity linking, and per-prompt consumption
rules consistently.

### Existing managed OAuth

OpenAI and xAI currently store refresh tokens, cached access tokens, expiry timestamps, and account
metadata as generic encrypted secret keys. The token brokers resolve an environment or primary
repository scope first and then fall back to global. Managed OAuth keys are removed from sandbox
environment injection; the runtime receives a marker and requests short-lived access through a
session-bound endpoint.

This design preserves those security boundaries while replacing moving secret-scope lookup with an
immutable session provider-auth snapshot.

The existing OpenAI broker already refreshes centrally in the control plane, uses isolate-local
single-flight, and rereads D1 after an unauthorized response to detect another isolate's rotation.
V1 retains that architecture. The account credential row adds a portable atomic exchange claim so
multiple control-plane processes cannot intentionally start the same rotation concurrently; it does
not add another Durable Object.

### Session creation

Web, Slack, GitHub, Linear, automations, and child sessions converge on `initializeSession()`. Model
and reasoning choices are written to both the D1 session index and the session Durable Object.
Models can also change per prompt, so one provider-specific account column is insufficient.

The account-resolution step occurs before D1 and Durable Object initialization. D1 stores the
resolved provider-auth rows atomically with the session index and is their sole authority. The
Durable Object remains authoritative for session lifecycle and sandbox-token authentication but does
not replicate provider-account bindings.

## Provider Support Model

### Shared provider registry

The shared package defines subscription provider IDs and display metadata:

```ts
export const SUBSCRIPTION_PROVIDER_IDS = ["openai", "xai"] as const;
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];
```

Availability is separate from identity. The control plane's `ModelProviderAccountAdapterRegistry` is
the authoritative set of connectable providers for server-side validation. The web groups provider
accounts using the shared provider IDs and display metadata. Register OpenAI and xAI in V1. Do not
reserve unsupported providers in shared schemas or persistence. If a later deployment removes an
adapter, existing accounts remain visible but cannot be connected, selected, set as default, or used
by the broker.

The model registry already identifies a model by `provider/model`. Account resolution uses the
provider prefix and does not duplicate model-to-provider mappings.

### Provider adapter contract

Provider-neutral orchestration must not parse provider credential payloads directly. Each provider
implements a typed adapter behind a registry:

```ts
interface ModelProviderAccountAdapter<TCredential, TConnectInput> {
  readonly provider: SubscriptionProviderId;
  readonly credentialSchemaVersion: number;

  parseConnectInput(input: unknown): TConnectInput;
  connect(input: TConnectInput): Promise<ProviderConnectionResult<TCredential>>;
  parseCredential(payload: unknown, schemaVersion: number): TCredential;
  refresh(credential: TCredential): Promise<ProviderRefreshResult<TCredential>>;
}

interface ProviderConnectionResult<TCredential> {
  credential: TCredential;
  externalAccountId?: string;
  accessTokenExpiresAt?: number;
}
```

The generic service owns encryption, persistence, status transitions, retries, optimistic
concurrency, single-flight coordination, audit logging, and session auth checks. Adapters own:

- provider endpoints and request formats;
- provider credential schemas;
- token response validation;
- external account/workspace ID extraction;
- provider error classification;
- runtime metadata derivation from trusted credentials and external identity;
- documented retry safety for ambiguous and stale exchanges.

Sandbox environment preparation owns the canonical provider environment-name registry. The current
source is `PROVIDER_ENV` in `packages/control-plane/src/sandbox/managed-provider-env.ts`; it maps
each provider to its API-key name, managed marker, and legacy refresh-token name. Adapters do not
declare environment-variable ownership.

### Initial adapters

| Provider | V1 source behavior                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| OpenAI   | Successful refresh requires a replacement refresh token; persist it and account-ID metadata before returning access.          |
| xAI      | A replacement refresh token is optional; retain the source token when absent, but persist the complete new state fail-closed. |

This intentionally strengthens the current xAI path, which has no account-level single-flight and
currently returns a new access token even when rotated-state persistence fails. V1 must not preserve
that behavior. Each adapter documents which upstream failures are provably retry-safe; OpenAI's
required replacement token makes ambiguous outcomes especially strict, while xAI may classify an
explicit non-rotating response differently.

## Data Model

The schema is implemented across `0064_provider_accounts.sql` and
`0065_provider_account_authorizations.sql`. The excerpts below summarize the current design; the
migrations remain authoritative for complete SQLite constraints and indexes.

### `model_provider_accounts`

```sql
CREATE TABLE model_provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  external_account_id TEXT,
  status TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  last_verified_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  lifecycle_version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (id, provider),
  CHECK (status IN ('active', 'disabled', 'reconnect_required')),
  CHECK (length(display_name) BETWEEN 1 AND 100)
);

CREATE INDEX idx_model_provider_accounts_provider_status
  ON model_provider_accounts(provider, status, display_name);

CREATE UNIQUE INDEX idx_model_provider_accounts_external_identity
  ON model_provider_accounts(provider, external_account_id)
  WHERE external_account_id IS NOT NULL AND archived_at IS NULL;
```

The uniqueness rule prevents duplicate usable connections to the same provider identity. Providers
without a stable external ID leave `external_account_id` null. OpenAI requires a trusted external
identity on connect, reconnect, and verify; xAI may leave it null.

Provider validity comes from the adapter registry rather than a database `CHECK`, so adding a future
provider does not require rebuilding this FK parent table. Stores validate provider IDs at every
write. The composite `(id, provider)` key lets defaults and auth rows enforce that an account
belongs to the provider named by the referencing row.

Archival is soft because sessions and historical usage may reference the account. Archived accounts
cannot be selected for new sessions.

`lifecycle_version` increments when an account lifecycle operation could invalidate an in-progress
reconnect. Device authorization records snapshot it together with account status and reject stale
completion attempts.

### `model_provider_account_credentials`

```sql
CREATE TABLE model_provider_account_credentials (
  provider_account_id TEXT PRIMARY KEY,
  encrypted_payload TEXT NOT NULL,
  credential_schema_version INTEGER NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  exchange_generation INTEGER NOT NULL DEFAULT 0,
  exchange_state TEXT NOT NULL DEFAULT 'idle',
  exchange_owner TEXT,
  exchange_started_at INTEGER,
  access_token_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_account_id) REFERENCES model_provider_accounts(id) ON DELETE CASCADE,
  CHECK (credential_schema_version > 0),
  CHECK (credential_version > 0),
  CHECK (exchange_generation >= 0),
  CHECK (exchange_state IN ('idle', 'in_flight')),
  CHECK (
    (exchange_state = 'in_flight' AND exchange_owner IS NOT NULL AND exchange_started_at IS NOT NULL)
    OR (exchange_state = 'idle' AND exchange_owner IS NULL AND exchange_started_at IS NULL)
  )
);
```

The complete credential payload is encrypted as one unit so refresh-token rotation is persisted
atomically. `access_token_expires_at` is duplicated as non-secret operational metadata so the broker
can decide whether decryption and refresh work is necessary; the access token itself remains only in
the encrypted payload. Exchange state is either `idle` or `in_flight`; the owner and start fields
represent the transient durable lease and contain no credential.

Use a dedicated `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`. New encryption should bind ciphertext to the
provider account ID, provider ID, and credential schema version using authenticated associated data.
The stored encoding must carry an encryption format version to permit later key or format migration.

### `model_provider_account_authorizations`

Migration `0065_provider_account_authorizations.sql` adds user-owned device-authorization
transactions. A transaction records provider, `create` or `reconnect` operation, reconnect lifecycle
snapshot or create display name, encrypted provider state, polling cadence and expiry, terminal
result, and processing-claim metadata. Its state is one of `initiating`, `pending`, `processing`,
`connected`, `denied`, `expired`, `failed`, `cancelled`, or `superseded`.

Provider state is encrypted with transaction ID, provider, and schema version as authenticated
context. Terminal transitions clear that ciphertext. The store uses conditional processing claims so
only one poller may exchange or finalize a transaction; stale reconnect completions are fenced by
the account's captured status and `lifecycle_version`.

The same migration adds `model_provider_account_authorization_attempts`. It records per-user start
attempts for throttling without storing credentials. Authorization rows are user-scoped even though
connected provider accounts are installation-wide: only the initiating user may poll or cancel the
temporary flow.

### `model_provider_account_defaults`

```sql
CREATE TABLE model_provider_account_defaults (
  provider TEXT PRIMARY KEY,
  provider_account_id TEXT NOT NULL,
  unattended_mode TEXT NOT NULL DEFAULT 'provider_account',
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (unattended_mode IN ('provider_account', 'api_key'))
);
```

The store validates that the account provider matches the default provider. Provider accounts and
defaults intentionally live outside repository and environment secret scopes. This avoids coupling
subscription identity to SCM repository IDs and gives Slack and other unattended launchers one
predictable default per provider.

`unattended_mode` lets operators keep interactive web sessions on the subscription default while
Slack, GitHub, Linear, and unpinned automations continue using metered API keys. An automation or
session request may explicitly select either an account or API-key mode and overrides this policy.

An account cannot be disabled or archived while it is a default unless the request atomically
replaces or removes that default. The API should return a conflict rather than silently changing
resolution.

### `session_model_provider_auth`

```sql
CREATE TABLE session_model_provider_auth (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  provider_account_id TEXT,
  selection_source TEXT NOT NULL,
  inherited_from_session_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, provider),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider),
  CHECK (auth_mode IN ('provider_account', 'api_key', 'legacy_scoped_oauth')),
  CHECK (
    (auth_mode = 'provider_account' AND provider_account_id IS NOT NULL)
    OR (
      auth_mode IN ('api_key', 'legacy_scoped_oauth')
      AND provider_account_id IS NULL
    )
  )
);

CREATE INDEX idx_session_model_provider_auth_account
  ON session_model_provider_auth(provider_account_id, created_at)
  WHERE provider_account_id IS NOT NULL;
```

Runtime consumers read these rows from D1 using the authenticated public session ID. A secret-free
session snapshot may expose provider IDs and selection source, but account display metadata should
be fetched from the model-provider-account API rather than copied into the WebSocket snapshot.

`provider_account_id` is present only for `provider_account` mode; API-key and legacy modes require
it to be null. `selection_source` records how the row was chosen. V1 sources include explicit
selection, provider default, unattended policy, automation pin, legacy fallback, migration, and
parent inheritance. Children copy the selected auth row and set `inherited_from_session_id` to their
parent.

### `automation_model_provider_auth`

```sql
CREATE TABLE automation_model_provider_auth (
  automation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  provider_account_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (automation_id, provider),
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider),
  CHECK (auth_mode IN ('provider_account', 'api_key')),
  CHECK (
    (auth_mode = 'provider_account' AND provider_account_id IS NOT NULL)
    OR (auth_mode = 'api_key' AND provider_account_id IS NULL)
  )
);
```

Absence means "resolve defaults and unattended policy when this automation executes." Presence pins
either the selected account or API-key mode for future runs until the automation is edited.

### Future usage snapshots

Do not create this table until at least one provider has a supported retrieval mechanism, but
reserve the conceptual contract:

```text
ModelProviderAccountUsageSnapshot
  id
  provider_account_id
  collected_at
  collection_status
  primary_limit_used
  primary_limit_resets_at
  secondary_limit_used
  secondary_limit_resets_at
```

Normalized fields support a common UI without putting provider response payloads into the core
account table.

## Account Lifecycle

### Create

The Settings UI uses the provider's device-authorization flow for OpenAI and xAI:

1. A human starts a user-scoped `create` authorization with provider and display name.
2. The control plane reserves the transaction and rate-limit attempt before calling the provider.
3. It encrypts the provider's device state and returns only the user code, verification URL, expiry,
   and poll interval to the browser.
4. The browser polls no faster than the returned interval. The store atomically claims one poller,
   and the adapter reports pending, denied, expired, failed, or connected state.
5. On connection, the service derives external identity from the trusted provider result, encrypts
   the complete credential, and atomically creates or safely reconnects the matching account.
6. Terminal state clears encrypted provider state. Cancellation is an explicit terminal transition.

If another non-archived account already has the trusted external identity, finalization uses the
same authorized atomic reconnect path and reports that existing account. A concurrent unique
conflict rereads and follows the winner. Unsafe or ambiguous persistence fails closed and requires a
fresh device flow; it never leaves a partial account or credential row.

Provider-discriminated manual create remains an authenticated compatibility endpoint for legacy or
administrative input. It is not the primary Settings workflow, and the browser never receives a
stored credential from either path.

### Verify

Verification uses a valid cached access token or refreshes through the adapter. It updates status,
external identity, sanitized metadata, and `last_verified_at`. An external account ID change is an
identity conflict, not a metadata update or reconnect.

### Reconnect

Reconnect starts the same user-owned device flow with a target account. The transaction snapshots
the target's provider, status, and `lifecycle_version`; finalization succeeds only if all still
match. It verifies that the resulting trusted external identity matches the existing account. If the
user intends to connect a different provider identity, they must create a new provider account
instead.

Changing provider identity therefore requires a new account, explicit updates to defaults and
automation pins, and new sessions. Existing sessions remain immutably bound to the old account and
fail when it becomes unusable. Bulk session rebinding is intentionally out of V1 because it would
change paid-account identity after session creation.

Successful reconnect increments `credential_version` and `lifecycle_version`, replaces the encrypted
payload atomically, clears stale cached access state, and returns the account to active status.
Provider-discriminated manual reconnect remains only as a compatibility path, including legacy xAI
accounts that have no external identity to fence through the device flow.

### Disable

Disabled accounts remain visible and retain credentials but cannot be selected or broker access.
Disabling blocks new selections and all subsequent broker calls. It does not revoke access tokens
already cached inside running sandboxes, so enforcement is bounded by the issued token lifetime and
the runtime refresh buffer. V1 does not terminate bound sandboxes or proxy every provider request.
The UI must disclose this delay and warn that running sessions and automations pinned to the account
will fail when they next request access.

### Archive

Archived accounts disappear from ordinary selection but remain referenced by historical sessions. V1
does not hard-delete referenced account metadata. Credential erasure may be offered as a separate
destructive operation, after which historical attribution remains but old sessions cannot resume.

## Default Resolution

### Resolution order

For each connectable subscription provider:

1. Validate and use an explicitly requested account or API-key mode.
2. For unattended launches, apply the provider's `unattended_mode`.
3. Otherwise use the active installation-wide default account.
4. Persist `legacy_scoped_oauth` with `legacy_fallback` when no default applies.

Persist auth mode, concrete account ID when applicable, and routing provenance. A configured but
disabled, archived, missing, or unavailable provider default is a configuration error when policy
selects it. It does not silently fall through to API-key authentication because that policy
expresses subscription intent.

### Provider completeness

Session creation resolves auth rows for every enabled, connectable subscription provider, not only
the initial model's provider. This keeps later per-prompt model changes deterministic. It also means
the initiating user can review the effective provider accounts before launch.

If no account is available for a provider, the session can still be created for other providers. The
legacy row uses a matching scoped refresh token when one is available in the resolved secrets;
otherwise sandbox environment preparation leaves the provider API key available as the effective
fallback. The persisted mode remains `legacy_scoped_oauth` in both cases. Runtime refresh must never
resolve a new moving default for an already-created session.

### Authentication precedence

Provider selection determines authentication mode:

1. If the session is in provider-account mode, subscription authentication is mandatory and takes
   precedence over any API key available in global or target secrets.
2. If the session is in API-key mode, existing provider API-key behavior remains available.
3. If the session is in legacy scoped-OAuth mode and has a matching legacy refresh token, the legacy
   broker path is mandatory and suppresses that provider's API key.
4. If legacy mode has no matching refresh token, the API key remains available as its effective
   compatibility fallback.
5. If the effective API-key path lacks the required key, model use fails with the existing
   provider-not-configured error.

An explicitly selected account and a resolved provider default both create a provider-account auth
row. Explicit or policy-selected API-key mode creates an API-key auth row without an account ID. The
control plane removes or suppresses the corresponding provider API key from the sandbox environment
when account mode applies so OpenCode cannot bypass the selected subscription. API keys for other
providers are unchanged.

This precedence applies to the initial model and later per-prompt model changes. Account selection
is not inferred from the mere presence of an API key.

## Session Semantics

### Create request

Extend the shared session request with a bounded provider-keyed map:

```ts
type ProviderAuthSelection = { mode: "provider_account"; accountId: string } | { mode: "api_key" };

type ModelProviderSelections = Partial<Record<SubscriptionProviderId, ProviderAuthSelection>>;

interface CreateSessionRequest {
  // Existing fields omitted.
  providerSelections?: ModelProviderSelections;
}
```

Omission means resolve provider policy. Unknown providers, duplicate normalized keys, malformed IDs,
provider/account mismatches, and inactive accounts are rejected. The web BFF must explicitly forward
this field rather than spreading untrusted request data.

### Initialization

Extend `SessionInitInput` and the D1 writer with resolved auth rows. D1 session creation and auth
insertion must use failure-enforcing statements in the same D1 batch; zero-row dependent inserts are
not assumed to roll back the batch. Provider auth does not cross the Durable Object initialization
transport. Schedule sandbox warming only after the Durable Object's existing core session,
repository, sandbox, and participant transaction commits.

If Durable Object initialization fails, the existing D1 failure reconciliation remains responsible
for marking the session failed. This feature does not attempt to redesign the broader session
initialization retry protocol. Ambiguous initialization recovery is a pre-existing concern and is
out of scope for V1.

### Prompt model changes

At prompt dispatch, derive the provider from the selected model. Account mode uses subscription auth
and suppresses that provider's API key. API-key mode continues to use existing injected secrets when
configured.

Billing-path provider derivation must use a new strict helper: canonicalize and validate the model
against the model registry, then return a recognized `SubscriptionProviderId | null`. Do not use the
existing permissive helper that accepts unknown prefixes and defaults bare or malformed IDs to
Anthropic. Unknown, legacy-bare, aggregator, and unsupported provider routes must be normalized by
an explicit compatibility map or rejected before account resolution.

The prompt request cannot supply a provider-account override. Account selection is a session
creation concern in V1.

### Child sessions

Child initialization reads the parent's complete provider auth set from D1, copies its original
routing provenance, and records the parent session as the immediate inheritance source. The public
child-spawn request and agent tool do not accept provider auth overrides.

Child creation does not re-resolve defaults or reject an unusable inherited account. It copies the
auth row verbatim and fails at broker time only if that provider is used, matching parent behavior
and preventing an unrelated disabled provider from blocking child creation.

### Existing sessions

Existing sessions using scoped managed OAuth are backfilled with immutable legacy routing metadata.
They continue using the old credential path until operators remove the scoped secrets. New sessions
use explicit choices, provider defaults, or legacy scoped behavior when neither is configured.

## Launch-Path Behavior

| Launch path              | V1 behavior                                                         |
| ------------------------ | ------------------------------------------------------------------- |
| Web                      | User may select auth; omission resolves policy/default/legacy.      |
| Slack                    | Resolve unattended policy, default, then legacy compatibility.      |
| GitHub                   | Resolve policy/default/legacy after target lookup.                  |
| Linear                   | Resolve policy/default/legacy after target lookup.                  |
| Automation with auth pin | Use the pinned account or API-key mode.                             |
| Automation without pin   | Resolve provider defaults and unattended policy for each execution. |
| Child session            | Copy every parent auth row; no override.                            |
| Repository-less service  | Resolve unattended policy and defaults.                             |

Bots need no provider-account contract in V1. They continue to call `POST /sessions`; the control
plane owns default resolution. This avoids duplicating credential visibility or selection policy in
each Worker.

Automation resolution differs intentionally from sessions: an unpinned automation follows current
defaults for future runs, while each resulting session pins the concrete account chosen for that
run.

## Broker Architecture

### Generic account broker

Introduce a provider-account broker with this responsibility boundary:

```ts
class ModelProviderAccountBroker {
  getAccess(accountId: string, expectedProvider: SubscriptionProviderId): Promise<ProviderAccess>;
}

interface ProviderAccess {
  accessToken: string;
  expiresIn?: number;
  externalAccountId?: string;
  providerMetadata?: Record<string, string>;
}
```

`providerMetadata` in broker responses is an allowlisted runtime header/input map generated by the
adapter. It is not persisted on the account. OpenAI derives `accountId` from the trusted credential
or external account identity; xAI returns an empty map.

### Session broker endpoint

Use one provider-neutral sandbox route:

```text
POST /sessions/:id/provider-auth/:provider/access-token
```

The route:

1. Requires the matching session's sandbox principal.
2. Rejects user and service credentials.
3. Reads the provider auth row from D1 using the sandbox-authenticated session ID.
4. Rejects an absent or API-key-mode provider.
5. Delegates a legacy-bound session to the existing provider-specific scoped refresh handler.
6. Calls the generic broker with the bound account ID and expected provider in account mode.
7. Applies `Cache-Control: no-store` through a route-level response wrapper to every success and
   error, including authentication, validation, missing-account-auth, provider, and unexpected
   failures.
8. Returns a provider-neutral access response.

The sandbox cannot submit a provider-account ID. Provider path validation plus the session auth row
prevents it from probing other accounts.

The generic route is the compatibility entry point: for a `legacy_scoped_oauth` binding it delegates
to the existing provider-specific refresh implementation. The old sandbox-facing OpenAI and xAI
routes accept only legacy-bound sessions and reject account- or API-key-bound sessions. Remove those
routes only after no deployed runtime images or legacy-bound sessions depend on them.

### Runtime plugins

Provider plugins retain provider-specific request behavior:

- OpenAI sets bearer authorization and `ChatGPT-Account-Id` when available.
- xAI applies its required authorization and request rewriting.

The runtime writes only managed sentinels to OpenCode authentication state. Refresh tokens never
cross the control-plane boundary.

Sandbox environment preparation reads the complete resolved session auth snapshot from D1.
`prepareManagedProviderEnv` owns the `PROVIDER_ENV` registry of API-key, managed-marker, and legacy
refresh-token names. For account mode, preparation sets the managed-auth marker and strips the API
key and legacy refresh token. It does the same for legacy mode only when the resolved secrets
contain the matching legacy refresh token; otherwise it preserves the API key as the compatibility
fallback. API-key mode receives no managed marker and retains existing injection behavior. D1 read
failures and incomplete snapshots fail closed rather than falling back to API-key exposure.

Suppression happens before `CreateSandboxConfig` reaches a sandbox provider, but provider-specific
environment layering must obey the same result. Add cross-provider create and restore conformance
tests for Modal's Python assembly and the TypeScript paths used by Daytona, E2B, Vercel, and
OpenComputer; later provider layering must not reintroduce a suppressed key.

### Cache behavior

The encrypted credential may include a cached access token. The broker reuses it only when it
remains valid beyond the provider's refresh buffer. The adapter defines token-expiry interpretation,
while the generic broker enforces a bounded default when the provider omits expiry.

Updating `last_used_at` must not create a D1 write for every model request. Update it during token
broker calls at a coarse interval, for example only when the stored value is older than fifteen
minutes, or during refresh.

## Concurrency and Rotation

Rotating refresh tokens require stronger coordination than ordinary secret upserts.

### Control-plane broker coordination

Keep refresh inside the existing control-plane broker. Do not introduce a provider-account Durable
Object or require Cloudflare-specific execution semantics. The broker coordinates through a narrow
`ProviderCredentialStore` interface implemented with atomic SQL updates in D1 and portable to other
transactional stores.

The broker:

1. Loads the current credential row and version from D1.
2. Returns a sufficiently fresh cached access token without an upstream exchange.
3. Coalesces requests within one process using the existing account/version single-flight pattern.
4. Atomically claims the account's exchange row before provider dispatch.
5. Performs the rotating-token exchange only when it owns that durable claim.
6. Persists the replacement credential and clears its claim before releasing the result.
7. Makes losing processes reread or briefly poll for the winner's persisted result.
8. Retries only outcomes known to be safe before or after provider dispatch.

The control plane remains the only component allowed to call provider refresh endpoints. The durable
SQL claim is the cross-process correctness boundary; in-memory single-flight is only an
optimization. This works across Cloudflare Worker isolates today without coupling the design to an
additional Durable Object and can map to conditional updates, row locks, or transactions in future
control-plane deployments.

### Credential persistence

The broker claims an exchange with one conditional update:

```sql
UPDATE model_provider_account_credentials
SET exchange_state = 'in_flight',
    exchange_owner = ?,
    exchange_generation = exchange_generation + 1,
    exchange_started_at = ?,
    updated_at = ?
WHERE provider_account_id = ?
  AND credential_version = ?
  AND exchange_state = 'idle';
```

Exactly one process observes a successful row change. Credential completion uses the matching owner,
generation, and version:

```sql
UPDATE model_provider_account_credentials
SET encrypted_payload = ?,
    credential_schema_version = ?,
    credential_version = credential_version + 1,
    exchange_state = 'idle',
    exchange_owner = NULL,
    exchange_started_at = NULL,
    access_token_expires_at = ?,
    updated_at = ?
WHERE provider_account_id = ?
  AND credential_version = ?
  AND exchange_generation = ?
  AND exchange_owner = ?
  AND exchange_state = 'in_flight';
```

Before dispatch, the broker conditionally changes `exchange_state` from `idle` to `in_flight`, sets
a random request-scoped `exchange_owner`, increments `exchange_generation`, and records
`exchange_started_at`. The update succeeds only for the expected credential version while state is
idle. Only the winner may call the provider. A successful response updates credentials and clears
the matching generation and owner in one write. A provider response explicitly classified as not
consuming the credential may also clear the marker.

If claim or completion affects no row because another process won, or reconnect or administrative
replacement changed the credential concurrently, reread the current credential:

- Return a valid access token written by the winner.
- Retry through the adapter if the credential version changed but no usable access token exists.
- Bound retries and surface a reconnect-required error rather than looping.

If an upstream refresh fails as unauthorized, reread once for a concurrent reconnect or credential
replacement, then mark the account reconnect-required. Do not try another provider account.

An ambiguous upstream outcome is not retryable by default. If a request may have reached the
provider but its rotating-token response was lost, the only valid replacement refresh token may be
unrecoverable. Mark the account `reconnect_required` unless the provider adapter can prove from a
documented response or idempotency contract that retrying the same credential is safe. Network
timeouts, connection resets after dispatch, malformed success responses, and truncated bodies are
ambiguous. Bounded retries apply only before dispatch or to provider-specific outcomes explicitly
classified as retry-safe.

An `in_flight` marker younger than the bounded provider request timeout tells losing processes to
poll briefly. A stale marker is treated as an ambiguous exchange. Stale recovery uses one D1 batch
to conditionally update the account to `reconnect_required` and fence the observed
`(version, generation, owner, in_flight)` lease back to `idle`, incrementing the generation and
clearing the owner and start time. Both guarded statements transition together. A late completion
using the prior generation affects zero rows and must not return access. If completion wins first,
stale recovery affects zero rows, rereads the valid committed credential, and does not change
account status. If an operator disables the account while the exchange is in flight, fencing clears
the lease without replacing the disabled status or its audit metadata.

The broker never steals a stale claim or reuses the stored pre-exchange refresh token. This
deliberately allows a crash before actual provider dispatch to require reconnection rather than risk
replaying a consumed rotating token. Every adapter must document stale-exchange semantics; it may
clear or retry only outcomes proven safe by provider behavior.

The credential store exposes `tryBeginExchange`, `completeExchange`, `clearSafeFailure`, and
`readCredentialState`. A narrow atomic writer owns terminal exchange failure. Provider adapters
never update exchange fields directly.

### Persistence failure

Never return a newly obtained access token when its rotated refresh credential could not be durably
persisted after bounded retries. Mark the account `reconnect_required` when safe and surface an
actionable error. Returning the access token would provide short-term success while guaranteeing a
later outage.

## API Design

Account-management and device-authorization routes require a human principal through the web service
boundary; they do not inherit broad `user-or-service` route policy. Under the current installation-
wide trust model, those routes are the `view` and `manage` boundary for admitted humans. Selection
is validated separately during session or automation resolution. Consumption is separately
authorized by the sandbox-authenticated session binding at the generic broker route. Bots and
services never list account metadata or retrieve credentials.

There is intentionally no unified `view`/`manage`/`select`/`consume` policy interface or hidden-
account nondisclosure guarantee in V1 because accounts are installation-wide. A future RBAC or
personal-account design must introduce those authorization and error-disclosure semantics together
instead of implying they already exist.

### Account routes

```text
GET    /model-provider-accounts/legacy-credentials
GET    /model-provider-accounts
POST   /model-provider-accounts
POST   /model-provider-accounts/:provider/device-authorizations
POST   /model-provider-accounts/:provider/device-authorizations/:id/poll
DELETE /model-provider-accounts/:provider/device-authorizations/:id
GET    /model-provider-accounts/:id
PATCH  /model-provider-accounts/:id
POST   /model-provider-accounts/:id/verify
POST   /model-provider-accounts/:id/reconnect
POST   /model-provider-accounts/:id/disable
POST   /model-provider-accounts/:id/enable
DELETE /model-provider-accounts/:id
```

Settings and session selectors derive provider groups from `SUBSCRIPTION_PROVIDER_IDS` and
`SUBSCRIPTION_PROVIDER_DISPLAY_METADATA`. The server-side adapter registry independently remains
authoritative for connection and selection availability.

The legacy-credentials endpoint lists legacy key locations without returning values. It is an
operator warning, not a routing gate.

List filters may include provider, status, and archived state. Responses contain no credential
fields and use `Cache-Control: private, no-store`.

`DELETE /model-provider-accounts/:id` is idempotent soft archive: it returns `204`, retains
encrypted credentials and historical references, and returns `409` while the account is a provider
default. V1 has no unarchive route. Destructive credential erasure is a separate future operation.

Device authorization is the primary create and reconnect interface for OpenAI and xAI. Start returns
only user-facing device-flow metadata; poll and cancel require the initiating human. Manual create
and reconnect use provider-discriminated compatibility schemas. Example shape:

```ts
type ConnectModelProviderAccountRequest =
  | {
      provider: "openai";
      displayName: string;
      refreshToken: string;
      accountId: string;
    }
  | {
      provider: "xai";
      displayName: string;
      refreshToken: string;
    };
```

Avoid an unvalidated `credentials: Record<string, string>` API even though the stored encrypted
payload is generic.

### Default routes

```text
GET    /model-provider-account-defaults
PUT    /model-provider-account-defaults/:provider
DELETE /model-provider-account-defaults/:provider
```

The route verifies provider/account compatibility, adapter availability, and account status.

### Session and automation routes

Session create accepts `providerSelections`. Session reads may return a secret-free auth summary:

```ts
interface SessionModelProviderAuth {
  provider: SubscriptionProviderId;
  authMode: "provider_account" | "api_key" | "legacy_scoped_oauth";
  providerAccountId?: string;
  selectionSource: string;
}
```

Automation create accepts a complete provider-keyed selection map, where omission means no pins.
Automation PATCH follows existing semantics: omitted `providerSelections` leaves all pins unchanged;
a present map replaces the complete pin set; and an explicitly empty map clears all pins and
restores policy-at-execution behavior.

## Settings Experience

Add **Provider Accounts** to Settings. The page groups accounts by provider and shows:

| Field               | Example           |
| ------------------- | ----------------- |
| Display name        | Team ChatGPT Plus |
| Provider            | OpenAI            |
| External account ID | `acct_...`        |
| Provider default    | Yes               |
| Status              | Connected         |
| Last verified       | 10 minutes ago    |
| Last used           | 2 minutes ago     |

Actions are add, rename, verify, reconnect, set default, disable, enable, and archive. Credential
values are write-only. Reconnect forms start empty and never display placeholders derived from
secret values.

The provider group should explain authentication precedence: account mode overrides that provider's
API key for the session, while API-key mode retains it.

### Session creation

When the selected model uses a connectable subscription provider, show an auth selector adjacent to
model and reasoning controls. It includes provider policy, explicit API-key mode, and accessible
accounts. The default option displays the resolved account:

```text
Provider account
Default: Team ChatGPT Plus (acct_...)
```

Changing models retains explicit selections per provider in form state. An expandable summary can
show all provider auth rows that will be pinned, which matters when users expect to switch models
inside the session.

The current web "warming" path eagerly creates the real session and sandbox on the first prompt
character; adoption only reuses its ID. Provider selections join the client-side warm identity
beside target, model, reasoning, and managed skills. Changing any selection invalidates that pending
ID and starts a different real session. The implementation must propagate cancellation where
possible and explicitly stop/archive a superseded session that completed creation; merely dropping
the browser's pending ID is not cleanup. Account usage and "sessions using this account" views
exclude unadopted draft sessions.

### Automation editing

Expose every connectable subscription provider in the automation editor, collapsed except for the
configured model's provider. For each provider offer:

```text
Use defaults when each run starts
Pin to <account>
Pin to API-key mode
```

The form should disclose that changing a default or unattended policy affects future unpinned runs
but never sessions already launched. Changing the configured model does not silently discard pins
for other providers because automation sessions can switch model later.

## Security and Trust Model

### Credential isolation

- Encrypt credentials with a dedicated key and authenticated context.
- Never return refresh tokens, cached access tokens, or encrypted payloads to browsers.
- Encrypt device-authorization provider state at rest and clear it on every terminal transition.
- Scope authorization polling and cancellation to the initiating canonical user.
- Never inject provider credentials into generic sandbox environment variables.
- Allow only the matching session sandbox to request its bound provider access.
- Return broker responses with `Cache-Control: no-store`.
- Keep secret values and raw provider responses out of logs, errors, analytics, and audit metadata.
- Bound provider metadata size and allowlist runtime metadata sent to sandboxes.

### Authorization

V1 follows the installation-wide trust model: every admitted human can view and manage provider
accounts. This is consistent with current shared secrets and integration settings but should be
called out prominently because subscriptions may be personal purchases.

This boundary explicitly addresses security finding `OI-SEC-16`: account catalog and management
routes accept human principals only, while bots and services reach provider auth solely through
session creation and sandbox-scoped brokering.

`created_by` and `updated_by` provide attribution only. They must not be described as ownership.

Do not add a `personal` visibility option until the product can enforce corresponding session and
repository access. A personal account attached to a globally visible collaborative session would not
be private in any meaningful consumption sense.

### Session authorization

The initiating principal may choose only active catalog accounts. Once pinned, all authorized
participants in that session use the same auth rows. Follow-up prompt authors cannot substitute an
account. Disable and archive are checked on every broker call, but already issued access tokens
remain usable until their provider expiry or revocation. V1 promises bounded prevention of future
refresh, not immediate revocation inside a running sandbox.

### Account identity

External account IDs are derived from trusted provider responses when possible. User-supplied IDs
are claims to verify, not authoritative metadata. A mismatch fails connection or reconnect.

JWT claim extraction from a successful TLS-protected token exchange can be used as provider response
metadata, but the adapter must validate the token response schema and must not accept arbitrary JWTs
submitted by the browser as identity proof.

### Audit logging

Logs and eventual audit records may contain:

- local provider-account ID;
- provider ID;
- actor canonical user ID;
- action and result;
- status transition;
- credential and schema version numbers;
- external account ID presence or a safely shortened value.

They must not contain credentials, authorization headers, raw token claims, or complete upstream
error bodies that may echo secrets.

## Legacy Coexistence

V1 does not import, decrypt, translate, or map existing managed OAuth secrets. Existing sessions are
backfilled with an explicit `legacy_scoped_oauth` binding and continue using scoped credentials. New
sessions resolve an explicit choice, then a provider default, then legacy scoped behavior.

### Legacy secret inventory

The settings inventory reports these fixed keys in global, repository, and environment stores:

```text
OPENAI_OAUTH_REFRESH_TOKEN
OPENAI_OAUTH_ACCESS_TOKEN
OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT
OPENAI_OAUTH_ACCOUNT_ID
XAI_OAUTH_REFRESH_TOKEN
XAI_OAUTH_ACCESS_TOKEN
XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT
```

`OPENAI_OAUTH_MANAGED` and `XAI_OAUTH_MANAGED` are generated non-secret sandbox sentinels, not
persisted credentials. Operators do not migrate them. Secret validation reserves and rejects those
names so user input cannot impersonate managed authentication. Do not remove unrelated provider API
keys.

Operators may add and verify accounts while legacy sessions continue running. Setting a default
changes only future sessions. Do not reuse the same rotating refresh token in both credential
systems. Remove legacy keys only after the legacy-bound sessions that depend on them are no longer
needed.

## Failure Semantics

| Condition                               | Behavior                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Explicit account ID is malformed        | Reject session creation with `400`.                                       |
| Well-formed explicit account not found  | Reject session creation with `404`.                                       |
| Explicit account provider mismatch      | Reject session creation with `400`.                                       |
| Account inactive or adapter unavailable | Return `409`; do not fall through.                                        |
| Device authorization is still pending   | Return pending state and the bounded next poll interval.                  |
| Device authorization denied or expired  | Terminalize and clear encrypted provider state; start a new flow.         |
| Reconnect lifecycle snapshot is stale   | Supersede the transaction; do not overwrite newer account state.          |
| API-key mode and provider key exists    | Use the existing API-key authentication path.                             |
| API-key mode but no provider key        | Reject model use with an actionable provider configuration error.         |
| Refresh unauthorized                    | Check concurrent rotation, then mark reconnect required.                  |
| Explicitly retry-safe upstream failure  | Return bounded retryable provider error; do not switch accounts.          |
| Ambiguous refresh outcome               | Mark reconnect required; do not retry unless adapter proves safety.       |
| Rotated credential cannot persist       | Fail access and require reconnect; do not return the new access token.    |
| Bound account disabled after launch     | Future broker calls fail; cached tokens remain valid until expiry.        |
| Default changes after launch            | Existing session remains on its pinned account.                           |
| Account archived with references        | Keep metadata and reject new/runtime use; retain historical references.   |
| Provider identity is replaced           | Create a new account; update defaults/automation pins; recreate sessions. |

Error responses should identify provider and safe account display name when available, but never
include credential material or raw upstream bodies.

## Observability

Emit structured events for:

```text
model_provider_account.created
model_provider_account.verified
model_provider_account.reconnected
model_provider_account.status_changed
model_provider_account.default_changed
model_provider_account.refresh_started
model_provider_account.refresh_completed
model_provider_account.refresh_failed
model_provider_account.concurrent_rotation_observed
model_provider_account.exchange_fenced
session.model_provider_accounts_resolved
```

Useful metrics include refresh latency and outcome by provider, active/reconnect-required account
counts, default-resolution source, sessions by provider account, concurrency retries, fenced stale
exchanges, legacy-bound session counts, and broker calls rejected for missing or disabled auth.

Do not put external account IDs in high-cardinality metric labels. Use provider and status labels;
retain local IDs only in structured logs where access is controlled.

## Testing Strategy

### Shared contracts

- Strict billing-path provider derivation rejects malformed, bare, aggregator, unknown, and
  unsupported routes unless explicitly canonicalized.
- Provider-keyed selection maps, unknown keys, malformed IDs, and size bounds.
- Explicit account, API-key, and omitted-policy selections.
- Account status and provider-auth response schemas.
- Provider-discriminated connect and reconnect inputs.
- Automation provider-auth create/update semantics.

Build `@open-inspect/shared` before dependent packages.

### Storage and crypto tests

- Account CRUD, soft archival, external identity uniqueness, and status transitions.
- Concurrent create collisions update an authorized existing identity atomically or fail with
  consumed- credential guidance; no partial row survives.
- Credential encryption/decryption with associated-data mismatch rejection.
- Credential schema-version dispatch and unsupported-version failures.
- Optimistic credential-version updates and stale-writer rejection.
- One default per provider and provider/account compatibility.
- Unavailable adapters reject default assignment without deleting existing account metadata.
- Real-D1 partial-index, trim-check, composite-FK, and provider/account referential behavior.
- Session and automation auth-row referential behavior.
- Device-authorization ownership, state transitions, expiry, attempt throttling, processing claims,
  terminal ciphertext cleanup, and lifecycle fencing.

### Provider adapter tests

- OpenAI required replacement-token and xAI optional replacement-token responses.
- Provider response schema failures and bounded upstream errors.
- Device start/poll response validation and provider-state serialization.
- External identity extraction and claimed-ID mismatch.
- Rotated refresh-token persistence.
- xAI persistence failure is fail-closed and never returns access.
- Optional/missing expiry defaults.
- Provider-specific runtime metadata allowlists.

### Broker tests

- Valid cached access reuse.
- Refresh buffers and coarse `last_used_at` writes.
- Same-account local single-flight and independent-account concurrency.
- Atomic exchange claims ensure concurrent requests from multiple Worker isolates perform one
  upstream exchange.
- Durable exchange intent is written before dispatch and cleared only with credential persistence.
- Process restart with an uncleared exchange marker fails closed as reconnect-required.
- Stale recovery fences the generation before status change; both late-completion race orderings are
  deterministic and covered.
- In-flight rejection and optimistic-concurrency defense paths.
- Unauthorized refresh followed by concurrent-state reread.
- Persistence failure prevents access-token return.
- Disabled, archived, reconnect-required, and provider-mismatch rejection.
- Disable blocks subsequent broker calls but does not claim to invalidate a token already cached in
  the sandbox.
- No implicit fallback to another account.

### Resolution tests

- Explicit selection wins over defaults.
- Explicit API-key mode suppresses provider-account default resolution.
- Unattended account/API-key policy applies to bots and unpinned automations.
- The provider default applies consistently to repository, environment, multi-repository, and
  repository-less launches.
- Account mode suppresses the same provider's API key.
- API-key mode retains existing provider-key behavior.
- Invalid configured provider defaults fail closed.
- Every configured provider receives a session auth row.
- Concrete account outcome and routing provenance are persisted accurately.
- Default edits do not mutate existing sessions.
- Child sessions copy exact auth rows despite unusable unrelated accounts and fail only at broker
  use.

### Control-plane integration tests

- Apply migration and add all tables to D1 test cleanup.
- Authenticated account/default CRUD against real D1.
- Credential values never appear in API responses.
- Session creation writes the authoritative D1 auth snapshot atomically with the session index.
- Sandbox preparation and child inheritance fail closed when the D1 auth snapshot is unavailable or
  incomplete.
- Sandbox A cannot request account access through session B.
- User and service principals cannot call the sandbox broker endpoint.
- Every broker success and early error response carries `Cache-Control: no-store`.
- Account disable blocks the next broker request from an existing session.
- Automation account pin, API-key pin, and policy-at-run behavior across all providers.
- Legacy credential inventory reports every configured scope without exposing values.
- Existing sessions are backfilled and remain legacy-bound when defaults change.
- Device start, poll, and cancel require the initiating human and never return encrypted provider
  state or credentials.
- Concurrent pollers finalize at most once; disable, archive, or reconnect races fence stale
  results.

### Web tests

- Settings navigation, provider grouping, empty/loading/error states.
- Device-code add/reconnect polling, cancellation, expiry, denial, disable, enable, archive, and
  conflict flows.
- Write-only credential forms and no secret hydration.
- Provider default editing.
- Session selector follows model provider and retains per-provider form state.
- Real pending-session invalidation after selection changes, including cancellation and cleanup of a
  completed superseded session.
- Account usage views exclude unadopted draft sessions.
- Automation account/API-key/policy controls for all connectable providers.

### Bot tests

- Slack, GitHub, and Linear create requests remain account-agnostic.
- Control plane resolves unattended policy and provider defaults after each bot's final target
  lookup.
- An invalid configured default produces actionable bot-visible failure text; an absent default
  preserves legacy compatibility.

### Sandbox runtime tests

- Generic provider-auth endpoint URL and session authentication.
- Provider plugins consume only their own broker response metadata.
- Refresh tokens never appear in environment variables or auth files.
- Account mode suppresses registry-owned API-key names across create and restore for Modal, Daytona,
  E2B, Vercel, and OpenComputer.
- Legacy mode suppresses the API key only when its matching scoped refresh token is present and
  keeps the API-key fallback otherwise.
- Snapshot restore continues to use the session's pinned provider auth.

### Coexistence tests

- Detect every legacy managed OAuth key in global, repository, and environment scopes.
- Backfill complete legacy auth rows for existing sessions.
- Route new generic plugins through the legacy broker for legacy-bound sessions.
- Prevent account-bound sessions from calling legacy provider-specific endpoints.
- Preserve legacy secret writes while dependent sessions remain.

## Implementation Status and Source of Truth

V1 is implemented by these architectural layers:

- D1 migrations `0064_provider_accounts.sql` and `0065_provider_account_authorizations.sql` define
  account, credential, default, session/automation binding, and device-authorization persistence.
- `@open-inspect/shared` owns provider IDs and API contracts.
- The control plane owns adapters, device authorization, account lifecycle, default resolution,
  session binding, credential refresh, environment preparation, and sandbox broker routes.
- The web BFF and Settings/session/automation UI expose the human workflows without credential
  reads.
- `packages/sandbox-runtime` owns the generic broker client and provider-specific request behavior.
- Terraform supplies the Worker encryption binding and tracks sandbox runtime source hashes.

Executable migrations, schemas, and code are authoritative when implementation details change. This
document describes stable boundaries and invariants; Git history and pull requests describe rollout
sequence. Do not duplicate a file-by-file implementation checklist here. All sandbox providers use
the same control-plane broker contract through the shared runtime; provider-specific credential
selection does not belong in Modal, Daytona, E2B, Vercel, or OpenComputer.

## Alternatives Considered

### Comma-separated credentials

Rejected because values cannot be independently validated, rotated, disabled, named, selected,
attributed, or assigned defaults. It also embeds an undocumented routing policy in a secret string
and makes persistence after token rotation unsafe.

### Automatically import or map legacy OAuth secrets

Rejected because rotating credentials would require dual-read compatibility, in-flight handoff,
legacy session discrimination, and long-lived mapping code. V1 instead requires a maintenance
window, fresh provider authentication, and recreation of affected sessions.

### One provider-specific column on sessions

Rejected because sessions can switch models and providers per prompt. `openai_account_id`,
`xai_account_id`, and future columns would repeatedly expand session schemas. An auth table keeps
one stable contract.

### One generic account ID column on sessions

Rejected because one session may need deterministic auth for multiple providers. A single value
cannot represent provider switching.

### Resolve defaults at every token refresh

Rejected because changing Settings would silently move active sessions between paid accounts and
destroy historical attribution. Resolve once and pin.

### Resolve another account after quota or auth failure

Rejected for V1 because implicit failover changes billing identity and can hide credential outages.
Future load balancing must be an explicit policy resource with user-visible pool membership and
routing rules.

### Store credentials directly on provider accounts

Rejected because list-heavy metadata access should not read or project encrypted secrets. A separate
one-to-one credential table narrows query surfaces and isolates high-frequency token updates.

### Separate tables for OpenAI and xAI accounts

Rejected because catalog, defaults, session selection, lifecycle, and usage attribution are common.
Provider-specific differences belong in typed adapter code and encrypted credential schemas, not in
duplicated session and Settings architectures.

### Fully generic unvalidated credential JSON API

Rejected because it weakens boundary validation and allows accidental secret fields or unsupported
credential shapes. Storage may be generic and encrypted; create/reconnect request contracts remain
provider-discriminated and typed.

### Personal/private accounts in V1

Rejected because current sessions and repository access are installation-wide. Marking an account
personal would not prevent another participant from consuming it through a shared session. Real
personal ownership requires a broader authorization design.

### Put provider accounts in `user_identities`

Rejected because sign-in identity and model-provider billing authentication have different
lifecycles, selectors, visibility, and runtime consumers. Provider accounts are operational model
credentials, not browser authentication identities.

### Treat API keys and subscriptions identically immediately

Rejected because API keys and consumer subscriptions have different setup, rotation, billing, and
provider runtime behavior. The catalog can support additional credential kinds later without
blocking subscription accounts now.

## Future Extensions

The account model permits later additions without changing session provider-auth rows:

- explicit account pools and quota-aware routing policies;
- supported provider usage and reset-window collection;
- account health dashboards and proactive reconnect alerts;
- approved hosted OAuth connect and callback flows;
- provider organizations containing multiple selectable workspaces;
- true personal/team visibility after product-wide authorization exists;
- administrator-only workspace account management;
- budget and concurrency policy by account;
- API-key-backed provider accounts when unified selection is valuable;
- account usage attribution in analytics and automation reports;
- controlled account changes through explicit session restart or fork operations.

A future pool is a separate resource referencing provider account IDs and resolves once at session
creation. Defaults may later target either an account or a pool. Pool routing records the pool ID
and policy revision in routing provenance, then pins one concrete account for the session and
descendants. Per-request balancing is a separate architecture and is intentionally excluded because
it would lose provider cache affinity and require request-level proxying or brokering.

Future RBAC adds grants around `view`, `manage`, `select`, and `consume` without changing credential
or session tables. V1 accounts are semantically installation-owned; `created_by` never implies
personal ownership. Authorization is evaluated when a session or automation establishes its provider
auth rows. Session participants and child sessions inherit that original authorization envelope
rather than reevaluating each prompt. Revocation blocks future refresh after cached access expires
but does not terminate a running session immediately. Truly actorless launches may consume only
unrestricted installation accounts or accounts granted to their service principal; otherwise they
fail closed.

Usage reporting remains informational. Session, account, automation/run, child lineage, and routing
provenance are retained, but V1 does not build ledger-grade per-message chargeback.

## Product Validation

V1 implements these product decisions; revalidate them with intended operators before changing the
trust or routing model:

- All admitted users may manage and consume installation-wide subscriptions in V1.
- One installation-wide default plus an unattended account/API-key policy per provider is sufficient
  for V1 launches.
- Session account choice is immutable; changing it requires a new session or future explicit fork.
- No automatic failover occurs when allowance or authentication fails.
- Provider-hosted device authorization is acceptable until approved redirect-based OAuth is
  available; manual credential input remains a compatibility path only.
- Displaying provider external account IDs in Settings is acceptable for the installation trust
  model.
- Operators may retain scoped OAuth during coexistence and remove it after dependent sessions age
  out.

If private personal subscriptions are required at launch, this document must return to Draft and be
paired with a product-wide authorization design. If automatic load balancing is required at launch,
it likewise needs a separate routing-policy design covering account pools, quota signals, sticky
selection, billing disclosure, and failure behavior.

## Related Open-Inspect Documentation

- [Using OpenAI Models](docs/OPENAI_MODELS.md)
- [Using Grok Models](docs/GROK_MODELS.md)
- [Secrets Management](docs/SECRETS.md)
- [Available Models](docs/AVAILABLE_MODELS.md)
- [How It Works](docs/HOW_IT_WORKS.md)
- [Session Snapshot Handoff ADR](docs/adr/0003-session-snapshot-handoff.md)
- [E2B Sandbox Provider](docs/E2B_SANDBOX_PROVIDER.md)
- [Vercel Sandbox Provider](docs/VERCEL_SANDBOX_PROVIDER.md)
- [OpenComputer Provider](docs/OPENCOMPUTER_PROVIDER.md)
