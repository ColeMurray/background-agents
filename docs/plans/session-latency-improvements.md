# OpenInspect session latency improvements

## Selected changes

1. **Creator-filtered inbox query:** materialize only `(id, parent_session_id)` links in the
   recursive child traversal. Seed detection and the full eligible projection remain inline, so
   dense all-visible lineages do not build the temporary relation. Snapshot and category pages share
   the fix. The hint remains limited to nonempty creator filters.
2. **Replay and history payloads:** retain a contiguous newest suffix under an estimated 256 KiB
   UTF-8 stored-event budget. Existing count limits, response schemas, and cursor formats remain.
   One oversized storage row is allowed so pagination progresses. Malformed rows still advance the
   cursor even when they do not yield a visible event. HTTP snapshots and WS subscriptions use the
   same synchronous projection. A separate canonical active-prompt projection preserves attachments,
   attribution, and PR-feedback origin outside the window without changing the paginated suffix. An
   explicit load-older control keeps empty or non-renderable pages traversable without scrolling.
3. **Event cursor seeks:** use `(created_at, timeline_sequence)` tuple comparison and a matching
   index. Preserve the old timestamp/id cursor branches and index for compatibility. `initSchema`
   creates indexes after migrations, so both fresh sessions and existing sessions receive the new
   index after any legacy sequence backfill; no new D1 migration or binding is needed.
4. **Prompt identity:** enrich with the canonical user ID already resolved and authorized during
   admission. Remove the second user/actor lookup; do not change Better Auth account/token refresh,
   permission checks, or service-actor admission. Attribution cannot switch users due to an actor
   relink after admission.

## Production-code verification

Base: `265a5997cf5d2a929344bdecd671ce9972349b36`. Local workerd, real D1 and DO SQLite, generated
credentials and synthetic data, mocked Modal. Thirty sequential warm samples after five warmups. The
candidate measurements below used production sources at `69945bf61`, before review follow-ups, with
no experiment transforms. They have not been remeasured with the active-prompt projection.

| Operation                                               | Baseline p50 / p95 | Candidate p50 / p95 |
| ------------------------------------------------------- | -----------------: | ------------------: |
| Heavy HTTP session snapshot                             |   54.98 / 64.92 ms |     7.57 / 10.27 ms |
| Heavy WS token + subscription                           |   44.34 / 56.14 ms |     9.07 / 11.14 ms |
| Short HTTP snapshot                                     |     5.63 / 8.47 ms |      4.74 / 6.08 ms |
| Prompt acknowledgement, 20 ms injected per D1 operation | 222.44 / 226.53 ms |  200.44 / 203.51 ms |

Heavy snapshot bytes: **8,319,852 → 250,422**. Short snapshot bytes are unchanged. D1 tracing
confirms one removed user lookup; the original generic-cache experiment's three-read saving is
**not** claimed for this implementation. Injection is a sensitivity test, not a measurement of
regional D1 latency.

The original filtered-inbox experiment at 100k sessions measured a 60.9-second baseline probe (only
one, deliberately bounded) versus a 253 ms candidate median over 30 samples, with identical results.
That wide-materialization candidate was superseded after review reproduced a dense-case regression.
The final query materializes only links, and only when recursive traversal runs. A schema-migrated
Node SQLite comparison (one warmup, five warm samples, identical snapshot/list results) verified
both dense all-owned sessions with visible parents and sparse sessions with hidden parents. Dense
queries remain near the original inline plan, while sparse traversal retains its improvement. These
timings come from a separate local-only comparison harness, not the committed regression suites.

| Fixture / operation | Original inline p50 | Final narrow-links p50 |
| ------------------- | ------------------: | ---------------------: |
| Dense 100k snapshot |           194.51 ms |              193.48 ms |
| Dense 100k list     |           126.05 ms |              126.86 ms |
| Sparse 4k snapshot  |            52.74 ms |                7.31 ms |
| Sparse 4k list      |            49.67 ms |                5.94 ms |

The committed real-workerd regression fixture checks work rather than wall time:

- A 50-event deep page over 10k rows read 5,402 rows before the fix; now required to read fewer
  than 200.
- Dense and sparse 4k creator-filtered inbox fixtures require fewer than 160,000 rows read for both
  snapshot and category pagination. The original sparse fixture read 384,806 rows before the fix.
  Both backends share wide synthetic rows and check snapshot/category cursor disjointness.
- Node adapter tests use all production migrations and verify identical snapshot/category results,
  hidden-parent rerooting, and query plans that index narrow links without materializing wide rows.
- Existing inbox integration tests cover rerooting, unread classification, automation visibility,
  tied timestamps, and repository/PR decoration. Additional tests constrain the hint to nonempty
  creator filters, preserve legacy schema initialization, and reconstruct heavy replay over HTTP/WS.

## Deferred experiments and limits

- **Generic request-local SQL caching:** the larger measured saving crosses Better Auth's separate
  session/account API contexts. Successful SCM refresh/account-profile flows were not measured by
  the credential-less fixture. Keep that redesign separate from admitted-ID reuse.
- **Snapshot digest/delta protocol:** roughly halves unchanged transfer but still reads and hashes
  the timeline, with a short-session regression. Insert sequence numbers are not revision
  watermarks; updated/deleted events need a complete protocol design.
- **Session-list keyset API:** promising deep-page results, but requires deterministic tie ordering,
  cursor/client changes, and explicit semantics under concurrent updates. No offset API change here.
- The byte budget trims an already-read SQL page. It reduces parsing/validation/serialization work,
  not the bytes read from SQLite. The response can exceed the estimate for one oversized event or
  non-timeline fields. This is not a strict wire-size cap.
- These are synthetic loopback observations, not production SLOs. No actual browser hydration/WAN
  latency, compressed transfer, cold-start distribution, or real model/sandbox startup was measured.
  The current prompt fallback is covered by DOM tests, not a timed browser benchmark.

## Reproduce regression validation

The commands below validate only the committed regression suites. They do **not** reproduce the
latency timing table above: those samples were collected with a separate local-only benchmark
harness that is not included in this PR.

From the repository root, install the lockfile dependencies and build the shared package. The
integration configuration creates local workerd/D1 bindings, applies the checked-in migrations,
generates test encryption keys, supplies fixture service/browser credentials, and mocks Modal. The
tests seed their own synthetic data; no production credentials, deployed D1 database, or real Modal
sandbox are required.

To run just the committed storage-read and bounded-replay integration fixtures:

```bash
npm ci
npm run build -w @open-inspect/shared
npm run test:integration -w @open-inspect/control-plane -- test/integration/session-query-work.test.ts test/integration/session-snapshot.test.ts
```

For the complete regression validation after that setup:

```bash
npm run build -w @open-inspect/shared
npm test -w @open-inspect/control-plane
npm run test:integration -w @open-inspect/control-plane
npm run typecheck -w @open-inspect/control-plane
npm run build -w @open-inspect/control-plane
npm test -w @open-inspect/web
npm run typecheck -w @open-inspect/web
```

Performance tests use real storage metadata rather than timing assertions. Smaller tests cover UTF-8
accounting, oversized/malformed rows, contiguous paging, HTTP/WS equality, current-prompt fallback
behavior (including removal when the original message loads), and retaining the admitted identity
for browser and bot prompts. Boundary schema validation, authorization, callback rules, and the
synchronous subscription handoff remain intact.
