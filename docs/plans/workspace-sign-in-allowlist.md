# Workspace Sign-In Allowlist

## Implementation Status

Implemented in the current working tree: shared validation, SQL persistence and migration, dynamic
admission evaluation, administrator GET/PUT routes, the Workspace access editor, and operator
bootstrap/maintenance commands. This document records that implementation, not a proposal for future
work. The verification criteria below are acceptance requirements, not test results or claims of
real-provider validation. This documentation update does not run tests or deploy anything.

**Settings > Workspace access > Sign-in allowlist** lets active built-in Owners and Administrators
manage verified emails, exact email domains, GitHub usernames, and GitHub organizations without
redeploying. Rules stored in SQL are additive to the deployment baseline, never overrides. The
migration starts with editing frozen; an operator explicitly enables it after the backend rollout is
complete and all old authentication runtimes have drained.

## Boundaries and Source Ownership

This is browser sign-in admission, not a universal workspace access policy. Roles, suspension,
resource authorization, bot enrollment, and integration trigger restrictions remain separate. Adding
a rule does not create a member, send an invitation, grant an administrative role, or undo
suspension. New canonical users receive Member; already linked users retain their role.

For each rule type:

```text
effective[type] = unique(normalize(deployment[type]) + normalize(managed[type]))
```

| Rule                        | Environment baseline    | Terraform input         | Providers      |
| --------------------------- | ----------------------- | ----------------------- | -------------- |
| Exact verified email        | `ALLOWED_EMAILS`        | `allowed_emails`        | GitHub, Google |
| Exact verified email domain | `ALLOWED_EMAIL_DOMAINS` | `allowed_email_domains` | GitHub, Google |
| GitHub username             | `ALLOWED_USERS`         | `allowed_users`         | GitHub         |
| GitHub organization         | `ALLOWED_GITHUB_ORGS`   | `allowed_github_orgs`   | GitHub         |

- Any matching rule admits the identity (OR), not an intersection of rule types.
- Trim, lowercase, and deduplicate within each source. The API sorts display arrays; runtime
  organization scheduling retains deployment order before appended managed organizations.
- Email evidence must be verified, including secondary GitHub emails. GitHub requires verified email
  evidence even when a username or organization matches. The member directory's displayed email is
  not necessarily the one that admitted the member.
- Domains are exact: `example.com` does not include `sub.example.com`. Organizations require active
  membership; GitHub-only rules cannot admit Google identities.
- A rule can belong to both sources. Removing its settings copy leaves its deployment grant intact.
  Removing a narrow email rule cannot negate an overlapping domain or organization grant.
- Deployment entries are visible and read-only. Terraform/environment changes do not reset SQL
  rules; the UI cannot narrow the baseline, edit infrastructure, or remove persisted grants by
  changing Terraform. Operators must change each owning source deliberately.

The existing strict baseline requirement remains. Each enabled provider must be supported by
deployment rules before the runtime is constructed; managed rules cannot rescue an invalid baseline
or satisfy Terraform's plan-time gates. Google requires email/domain admission; GitHub also supports
usernames/organizations. Keep a known valid recovery administrator's verified email in the
deployment baseline with unsafe mode disabled. A completely UI-managed baseline is not supported.
The recovery account must also remain active with a usable administrative role.

`UNSAFE_ALLOW_ALL_USERS=true` admits any otherwise valid provider identity **only when all four
effective lists are empty**. It does not override nonempty deployment or managed rules. The editor
and PUT route are read-only whenever the flag is true, even when it is dormant behind rules. To
leave unsafe mode, deploy a compatible recovery baseline and disable the flag together, then verify
the recovery account before enabling editing. Settings cannot toggle this flag or providers.

Removing rules affects subsequent sign-in and other operations that recheck eligibility, including
the existing internal GitHub account-info path. Ordinary browser-session authentication does not
rerun admission, and rule removal does not revoke sessions. Use **Members > Suspend** for account
revocation; existing WebSocket authorization timing remains unchanged. There is no exhaustive
member-impact or guaranteed last-administrator-reachability check based on the local member list.

## Implemented UI

The section sits before the member directory at `/settings?tab=workspace`. Only eligible
administrators mount/fetch it; custom roles with member permissions retain their existing member
view without admission-policy access. Existing settings navigation and permission enums are reused.

Four rule groups show Deployment, Settings, or Both provenance, variable names, and provider
applicability. An add form validates one value at a time. Draft changes remain previews until
**Review and save** and **Confirm and save**. The review shows additions/removals, broad domain/org
grant warnings, exact deployment duplicates, and remaining exact-domain coverage of removed emails.
These warnings are not a complete analysis of affected identities.

Conflicts and unknown save outcomes preserve the draft but disable saving until an explicit reload.
Reload updates the reviewed server snapshot while retaining the draft for comparison; it never
automatically retries a replacement. A successful response becomes the displayed saved state.
401/403 withdraw access, failed initial reads show Retry rather than an editable empty document, and
unsafe/frozen policies explain why editing is disabled. Cancel confirms draft discard.
`beforeunload` warns about unsaved edits; there is no general in-app navigation blocker.

## Validation and Limits

`packages/shared/src/admission-settings.ts` defines the strict managed document and snapshot schema.
The PUT body is only `allowedGitHubUsers`, `allowedEmails`, `allowedEmailDomains`, and
`allowedGitHubOrganizations` arrays. Unknown fields such as actor IDs, deployment entries, roles,
provider credentials, or `unsafeAllowAllUsers` are rejected.

| Input                    | Implemented limit                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Managed rules total      | `MAX_MANAGED_ADMISSION_RULES = 50` distinct entries across all four arrays                                                                             |
| Managed organizations    | `MAX_MANAGED_ADMISSION_ORGANIZATIONS = 10`                                                                                                             |
| Request body             | `ADMISSION_POLICY_MAX_BODY_BYTES = 65_536` (64 KiB), capped before JSON parsing at web and control-plane boundaries                                    |
| Email                    | Single ASCII address, at most 254 characters; no display name or dot/plus alias rewriting                                                              |
| Domain                   | ASCII DNS hostname, at most 253 characters and 63 per label, at least two labels; no IP literal, scheme, path, port, wildcard, or leading/trailing dot |
| Internationalized domain | Explicit ASCII punycode; no automatic Unicode transliteration                                                                                          |
| GitHub login             | Bare alphanumeric/hyphen slug, at most 39 characters; no leading/trailing or consecutive hyphens, `@`, or URL                                          |

Managed values are trimmed, lowercased, sorted, and deduplicated. Empty, non-string,
control-character, and embedded-list inputs are rejected. Validation is syntax-only: saving does not
probe DNS, enumerate people, or verify future organization membership/token permissions.

Deployment rules retain legacy normalization and syntax; managed limits do not reject a large
existing baseline. On replacement, distinct effective organization count must be at most
`max(10, deploymentOrganizationCount)` **or** no greater than its pre-write count. This allows
unrelated edits and reductions when deployment growth or lost overlap has made the union exceed the
bound, but prohibits further over-limit growth. This check uses the revision being replaced; it is
not a persisted-read rejection rule.

## Management API and Persistence

Control plane: `/settings/admission-policy`. Browser proxy: `/api/settings/admission-policy`.

| Method | Behavior                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | Deployment, managed, effective arrays; configured providers; unsafe flag/effective state; editability reason; revision/update metadata; ETag |
| `PUT`  | Atomic whole-document replacement of managed rules with required `If-Match`; returns complete updated snapshot                               |

Both routes require a human principal, `workspace.members.manage`, and an active canonical built-in
Owner/Administrator role. Custom roles (even with that permission), Members, Viewers, team leads
without an administrator role, bots, and service/sandbox principals cannot use them. A signed web
request alone is not human authorization. Responses are private/no-store.

The new Next.js PUT handler requires the exact Fetch Metadata value `Sec-Fetch-Site: same-origin`
before forwarding. Missing metadata, `same-site`, `cross-site`, and `none` are denied with 403. It
does not derive a trusted origin from `Host` or forwarded headers, and requires no new environment
variable or trusted-host configuration. This guard is specific to the new mutation route, not a
claim that all settings routes gained an origin check.

The ETag combines revision with a SHA-256 hash of normalized deployment rules, configured provider
IDs, unsafe flag, and the current frozen state. It excludes OAuth secrets and the full auth-runtime
fingerprint. `If-Match` and `ETag` survive the proxy. Deployment hash is checked against the
handling process; revision is checked transactionally. This fences stale edits but does not
serialize a deployment rollout across processes with different environment bindings.

| Status        | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `200`         | Read, applied replacement, or normalized no-op                                                              |
| `400`         | Invalid JSON, rules, unknown fields, or precondition format                                                 |
| `401` / `403` | Unauthenticated/unauthorized; browser PUT also rejects missing or non-same-origin metadata                  |
| `409`         | Unsafe flag, maintenance freeze, incompatible baseline/provider configuration, or organization growth bound |
| `412`         | Stale revision or deployment fingerprint                                                                    |
| `413`         | Body exceeds 64 KiB                                                                                         |
| `428`         | Missing `If-Match`                                                                                          |
| `503`         | Policy/audit unavailable; no partial mutation                                                               |

Migration `terraform/d1/migrations/0092_workspace_admission_policy.sql` creates the singleton
`workspace_admission_policy` with `id=1`, `schema_version=1`, `revision=0`, empty `rules_json`,
nullable update timestamp/actor snapshot, and **`writes_frozen=1`**. Missing or malformed state is
an integrity failure, not an empty-policy fallback. The store uses the shared `SqlDatabase` contract
on D1 and Node SQLite.

`AdmissionPolicyStore.replace` validates the document and atomically rechecks the actor's active
canonical role, frozen state, expected revision, and validated stored document. The same SQL batch
records an operation decision and conditions the update on it. Required audit failure rolls back the
write. Applied replacements increment revision once; normalized no-ops do not. A stale request still
conflicts even if its proposed document equals current state. Freeze/unfreeze also change revision
when state changes, invalidating outstanding editor snapshots.

### Audit

Policy operations use `workspace.admission_policy_updated`, resource type `admission_policy`, and
resource ID `workspace`. Metadata contains `requested: { expectedRevision }`, `currentRevision`,
`resultRevision`, `deploymentHash`, and managed `before`/`after` documents. There is **no duplicate
full requested document** or separately stored full added/removed copy. Rejected/no-op operations
retain the actual unchanged policy in `after`. Actor, request ID, timestamp, outcome, and reason are
recorded with the operation. Early route/validation failures do not claim a completed mutation.

The 50-rule limit bounds normal managed before/after audit metadata below 30 KiB; 100 such events
are approximately 3 MB before response framing/other fields. These are managed-policy payload
bounds, not limits on legacy deployment data or a guarantee for arbitrary out-of-band database
corruption.

Audit readers with `workspace.audit.read` can see rule values, including emails, even if their
custom role cannot read/edit the live policy. Maintenance uses
`workspace.admission_policy_maintenance`, service attribution `operator-cli`, and
before/requested/after revision/frozen-state metadata. Application logs cover policy read/save
failures and save outcomes without copying rule documents. No dedicated latency metrics, alerting
automation, or new custom audit presentation is promised here.

## Authentication Runtime and Deadlines

Better Auth construction remains cached by database identity and normalized environment fingerprint.
The injected admission evaluator reads managed rules once for each admission evaluation, unions them
with the runtime's deployment snapshot, and evaluates verified provider evidence before identity
claiming. There is no managed-rule TTL cache or process-local invalidation requirement. Ordinary
session/resource authentication does not acquire a new admission-policy read.

The policy read is the evaluation's linearization point. A read after a committed save uses the new
revision; an already-running evaluation can finish with its earlier snapshot. The feature does not
cancel in-flight callbacks. Missing table/singleton, malformed JSON/schema, or database failure
produces unavailable admission, including for deployment-matching users and unsafe deployments.
There is no environment-only fallback. D1 reads must remain authoritative; introducing replicas
requires preserving that consistency explicitly.

GitHub username/email/domain matches avoid organization network calls. Otherwise organization checks
run with **at most four concurrent requests and one total 10-second deadline**, covering queued
checks and response bodies. Any active membership wins without waiting for earlier slow
organizations. A slow earlier request does not serially block all later checks, though four stalled
requests can consume the pool until the shared deadline. Pending/404 do not admit; without a winning
match, provider failures or deadline expiry return unavailable rather than silently allowing access.

The browser OAuth callback transport has a **240-second** timeout. Verified-email pagination can
take up to roughly **200 seconds** (10 pages, up to two 10-second network attempts per page), before
organization evaluation, with remaining budget for token exchange and persistence. The Next.js auth
route declares **`maxDuration = 300` seconds**. Ordinary resource/non-callback transport keeps its
**15-second** default. Both service-binding and direct-fetch dispatch use the selected bound.

These are application budgets, not a guaranteed hosting duration: platform, ingress, and function
caps still apply and can terminate requests earlier. Provider token exchange currently has no
explicit timeout inside the auth library; the application proxy bounds its wait, not guaranteed
cancellation/completion of upstream provider work. Live GitHub/Google behavior and hosting limits
require deployment verification; this document does not assert they were tested against providers.
Organization rules add no OAuth scopes; the GitHub App flow disables default OAuth scopes and uses
App permissions and the signing-in user's token. Configure/approve Organization Members read-only
permission as needed; entering a rule does not request `read:org` or change App permissions.

## Operator Runbook

Run from a checkout with Node.js 24+. Both scripts accept exactly one of `--database <D1-name>`
(remote D1) or `--sqlite <existing-path>`. SQLite must already exist; the runner does not create an
empty database. D1 uses Wrangler credentials (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, or
`wrangler login`). The shared `scripts/operator-sql.ts` runner uses result-bearing
`wrangler d1 execute --remote --command ... --json`, not file-import execution; SQLite writes use
`BEGIN IMMEDIATE`. Do not replace these guarded commands with ad hoc SQL updates.

### Start and Enable

1. Configure OAuth and a provider-compatible deployment baseline, preferably an exact recovery
   email, with unsafe mode disabled. Apply migration `0092` before new readers serve traffic. Node
   startup applies the shared migrations; see
   [container startup](../CONTROL_PLANE_CONTAINER.md#quick-start).
2. Deploy the backend/shared changes and drain every old environment-only auth runtime. Independent
   frontend deployment may happen first: it safely shows unavailable against missing routes or
   read-only maintenance against the seeded frozen policy. Initial frozen state explicitly permits
   staging this rollout without exposing writes early. There is no new automatic CI release gate or
   automatic unfreeze; operators verify completion.
3. On a new installation, sign in once with the intended Owner and obtain their canonical user ID.
   Bootstrap the role with the commands below. No automatic first-user ownership is introduced.
4. Inspect policy status, review an unfreeze dry run, then execute using that observed revision only
   after the backend rollout is complete. Inspect status again and reload the editor.

```bash
# D1 Owner bootstrap: preview, execute, verify (the final preview should report no-op).
node scripts/bootstrap-workspace-owner.ts --database <D1-name> --user <canonical-user-id>
node scripts/bootstrap-workspace-owner.ts --database <D1-name> --user <canonical-user-id> --execute
node scripts/bootstrap-workspace-owner.ts --database <D1-name> --user <canonical-user-id>

# Inspect and enable managed writes. Replace <revision> with the observed current value.
node scripts/admission-policy-maintenance.ts status --database <D1-name>
node scripts/admission-policy-maintenance.ts unfreeze --database <D1-name> --expected-revision <revision>
node scripts/admission-policy-maintenance.ts unfreeze --database <D1-name> --expected-revision <revision> --execute
node scripts/admission-policy-maintenance.ts status --database <D1-name>
```

For SQLite use the identical actions with `--sqlite /path/to/existing/global.db` instead of
`--database <D1-name>`. [AUTH.md](../AUTH.md#initial-owner-setup) and the
[container runbook](../CONTROL_PLANE_CONTAINER.md#sign-in-allowlist-operations) include SQLite
examples. Bootstrap requires an existing unsuspended canonical user and refuses when another active
Owner exists; it is not a general role/suspension bypass.

Maintenance `status` is read-only and accepts neither `--execute` nor `--expected-revision`.
`freeze`/`unfreeze` require `--expected-revision`; without `--execute` they only preview. Changed
state increments revision; an already matching state is an audited no-op on execution. Conflicts
require inspection, not blind retries. Freezing blocks policy writes, **not sign-in or
enforcement**.

### Freeze, Export, and Old-Code Rollback

1. Stop concurrent deployments, baseline configuration changes, and operator policy changes. Disable
   or otherwise control automated rollbacks so they cannot bypass this procedure. The CLI cannot
   lock environment configuration or serialize deployment tools.
2. Inspect revision, preview a freeze, then execute and capture its JSON snapshot. The freeze and
   returned managed-rule snapshot share one transaction. Record its returned revision, not merely
   the pre-freeze revision. Protect the export because it contains email addresses.

```bash
node scripts/admission-policy-maintenance.ts status --database <D1-name>
node scripts/admission-policy-maintenance.ts freeze --database <D1-name> --expected-revision <revision>
umask 077
node scripts/admission-policy-maintenance.ts freeze --database <D1-name> --expected-revision <revision> --execute > admission-policy-frozen.json
node scripts/admission-policy-maintenance.ts status --database <D1-name>
```

3. Check `writesFrozen: true` and the recorded revision. Exported `managed` rules are **not** the
   effective union: the script does not fetch the deployed baseline. Separately obtain the actual
   serving environment's four allowlists, not just stale local Terraform inputs. Normalize and union
   each with the frozen managed arrays; put that complete union into deployment configuration. Set
   unsafe mode false. Apply this baseline using the still-new code while maintaining the freeze.
4. Verify the **deployed** baseline union, provider compatibility, and recovery/representative login
   eligibility. Immediately before old-code rollback, run `status` again and confirm the recorded
   revision and frozen state still hold, and independently confirm the deployed baseline is still
   the reviewed union. If either changed, stop and repeat the review/export process.
5. Only then roll back to environment-only code with the union baseline intact. Keep the singleton,
   frozen state, and audit history. Do not drop rows or unfreeze while old auth runtimes remain.

With unsafe mode enabled, old code could reopen access by ignoring nonempty managed rules; disabling
unsafe mode and installing the union first prevents that rollback hazard. A frontend-only rollback
does not stop new backends enforcing managed rules. Restore a compatible UI/client to edit them;
Terraform cannot subtract a SQL grant.

### Recovery and Re-Enable

For a valid but mistaken policy, add a known valid recovery email to the deployment baseline with
unsafe mode false, deploy the correction, and verify that account's active role and login. Restore a
suspended account through an authorized Owner/Administrator, not the bootstrap tool. For corrupt or
unavailable policy persistence, repair/restore the database before sign-in; a baseline email is not
an outage bypass. Maintenance commands inspect/freeze state, not rewrite or repair rule JSON.

After restoring current code and draining all old runtimes, inspect status and unfreeze with its
current revision using the Start and Enable commands. For SQLite, the recovery sequence is:

```bash
node scripts/admission-policy-maintenance.ts status --sqlite /path/to/existing/global.db
node scripts/admission-policy-maintenance.ts unfreeze --sqlite /path/to/existing/global.db --expected-revision <revision>
node scripts/admission-policy-maintenance.ts unfreeze --sqlite /path/to/existing/global.db --expected-revision <revision> --execute
node scripts/admission-policy-maintenance.ts status --sqlite /path/to/existing/global.db
```

After a timeout or ambiguous command result, inspect status/audit before retrying. Keep any baseline
copies introduced for rollback until deliberately removing them in a separate reviewed deployment;
the tool does not reconcile either source.

## Verification Acceptance Criteria

These checks define acceptance, not results of this documentation change. Existing focused coverage
lives alongside the shared schema, store, runtime, routes, web proxy/hook/components, and operator
scripts, with D1 coverage in `packages/control-plane/test/integration/admission-policy-*.test.ts`.

- Verify all four OR-based rule types, both sources and duplicates, verified secondary emails,
  exact-domain behavior, provider compatibility, and unchanged role/suspension/bot boundaries.
- Verify fresh SQL reads in warmed/independent auth runtimes, old in-flight evaluation semantics,
  fail-closed missing/malformed state, and no new admission check on ordinary session requests.
- Verify four-way organization concurrency, the single 10-second deadline including bodies/queue,
  later active membership winning without waiting for earlier slow checks, and no-match failures.
- Verify the 240-second callback transport, 300-second route declaration, unchanged 15-second
  ordinary resource timeout, and both fetch/service-binding paths. Separately exercise real GitHub
  and Google callbacks, organization permissions, pagination, and hosting caps; mocks do not prove
  live-provider behavior or timeout/cancellation guarantees.
- Verify 50 total/10 managed-org limits, 64-KiB body caps at both boundaries, strict managed syntax,
  legacy baseline preservation, and permitted reductions/unrelated edits to over-limit org unions.
- Verify human/canonical-role authorization, transactional demotion/suspension and freeze races,
  stale revision/baseline conflicts, no-op behavior, audit rollback, bounded before/after metadata,
  and `requested.expectedRevision` without another full rule copy.
- Verify exact same-origin Fetch Metadata, including denial of missing and `same-site` values,
  signed transport, private/no-store responses, and preconditions across proxy hops.
- Verify unavailable/frozen/unsafe UI states, preserved drafts and explicit conflict reload, unknown
  outcomes, review warnings, keyboard access, focus return, and narrow-screen wrapping. Full member
  impact analysis and arbitrary in-app navigation blocking are not implemented acceptance promises.
- Rehearse remote D1 and existing-file SQLite bootstrap/maintenance, dry-run immutability, expected
  revisions, atomic audit/postconditions, and refusal on missing or invalid state. Confirm migration
  seeds revision zero frozen, preserves existing data, and does not silently reset policy.
- Rehearse independently deployed frontend-first/backend-first staging, explicit enable after old
  runtime drain, frontend-only rollback, freeze/export plus actual-baseline union, protection from
  concurrent deployments/automated rollback, recovery, and verified re-enable. Existing Terraform
  safety gates remain unchanged; no new deployment automation is claimed.
