# Hono endpoint integration coverage plan

## Baseline

- Target `public/origin/main` at `637209be9f6e7036e9e32ad591969f55aaad3eba`.
- Work in the isolated `test/hono-integration-coverage` worktree.
- Exercise endpoint behavior through the deployed Worker boundary (`SELF.fetch` / `serviceFetch`),
  with real Workerd bindings, D1 migrations, authentication, admission, and response finalization.

The existing Hono suites already freeze all 171 method/path/policy contracts and exercise every
route with its applicable credential classes. Those matrices intentionally use placeholder bodies
and mostly assert admission outcomes. They do not replace valid body/query/parameter to persistence
workflows through production handlers.

## Implementation scope

### 1. SCM settings workflows

Add real Worker/D1 coverage for the six `/scm-settings` routes:

- read the empty global state;
- PUT, GET, and DELETE normalized global defaults;
- PUT, list, and DELETE a repository override whose owner contains an encoded subgroup slash;
- reject malformed JSON and invalid schemas without changing stored settings.

This closes the largest endpoint-family gap: current tests mock `ScmSettingsStore` and therefore do
not cover Hono dispatch, decoded parameters, real persistence, or response envelopes together.

### 2. Autofix activity workflows

Add route-level coverage for `GET /autofix/activity`:

- seed real feedback records and traverse stable newest-first cursor pagination;
- verify default and explicit limits;
- reject invalid limits and cursors with the route's public error contract;
- reject unsigned and non-web service requests.

The store already has cursor tests, but the production Hono route and web-service boundary are only
incidentally reached by the all-route matrix.

### 3. Routing and authentication regressions

Extend the focused compatibility suites to cover two Hono boundary contracts:

- `/model-provider-accounts/legacy-credentials` selects the literal handler, while an encoded
  literal alias selects `/:id` and is validated as a dynamic account ID;
- a tampered Sig1 service credential is terminal and cannot downgrade to an otherwise valid session
  sandbox bearer on a sandbox-fallback route.

## Deferred follow-ups

After these high-value gaps, useful later slices are stateful repository metadata/secret workflows,
the regular automation lifecycle, successful skill preview/profile mutation workflows, and a full
service-actor-by-route sentinel matrix. They are broader domain additions and are not required to
close the concrete Hono handler gaps above.

## Verification

For each slice, add one observable behavior at a time and run its focused integration file. Then
run:

1. Hono unit and boundary integration suites.
2. All control-plane unit tests.
3. All control-plane Workerd/D1 integration tests.
4. Control-plane typecheck and build.
5. Repository ESLint, Prettier, and `git diff --check`.
