# Coverage-Guided Test Reduction

## Results

These figures record the initial reduction measured against `d343cac`, before later changes from
`main` were merged. Subsequent merge resolutions retain newly introduced regression tests rather
than restoring the removed redundant suites, so these are historical counts, not current-main
totals.

Removed **3,414 test cases** and **278 complete test files** across eight packages. The measured
suites decreased from 14,587 to 11,173 cases, a **23.4% reduction**. Counts include four unchanged
skipped tests.

The limit is a maximum **three-percentage-point decrease in each coverage metric, per package**, not
an aggregate average that could hide a large loss in one package. The historical comparisons below
were recomputed from saved counters with identical production-only exclusions on both sides. Every
statement, branch, function, and line denominator remains unchanged within that comparison.

| Package                   | Before | After | Removed | Largest Coverage Drop |
| ------------------------- | -----: | ----: | ------: | --------------------: |
| control-plane, both hosts |  7,916 | 5,841 |   2,075 |               2.34 pp |
| web                       |  2,708 | 1,881 |     827 |               2.40 pp |
| shared                    |  1,093 |   903 |     190 |               2.28 pp |
| slack-bot                 |    512 |   397 |     115 |               2.27 pp |
| linear-bot                |    267 |   228 |      39 |               2.04 pp |
| github-bot                |    146 |   134 |      12 |               0.57 pp |
| sandbox-runtime           |  1,404 | 1,278 |     126 |               0.90 pp |
| modal-infra               |    541 |   511 |      30 |               0.00 pp |

Other suites, including docs, sandbox-images, native Node tooling tests, and Terraform contracts,
were not reduced and are not included in these totals.

### TypeScript Coverage

Each cell shows baseline coverage followed by coverage after removal, in percent.

| Package       | Statements     | Branches       | Functions      | Lines          |
| ------------- | -------------- | -------------- | -------------- | -------------- |
| control-plane | 92.45 -> 90.78 | 84.82 -> 82.48 | 96.95 -> 96.09 | 94.11 -> 92.63 |
| web           | 75.79 -> 73.39 | 74.55 -> 72.17 | 75.28 -> 73.05 | 76.84 -> 74.59 |
| shared        | 93.63 -> 91.91 | 84.02 -> 81.94 | 91.90 -> 89.62 | 94.62 -> 92.93 |
| slack-bot     | 90.24 -> 88.71 | 81.09 -> 78.82 | 95.46 -> 93.65 | 90.41 -> 89.47 |
| linear-bot    | 86.61 -> 85.18 | 74.06 -> 72.19 | 90.47 -> 88.43 | 87.82 -> 86.48 |
| github-bot    | 93.65 -> 93.65 | 88.57 -> 88.00 | 93.75 -> 93.75 | 94.69 -> 94.69 |

### Python Coverage

Coverage.py reports executable lines as statements and does not provide Vitest-style function
coverage. Statement and branch percentages were compared separately, not just the combined score.

| Package         | Statements / Lines | Branches       | Combined       |
| --------------- | ------------------ | -------------- | -------------- |
| sandbox-runtime | 89.83 -> 89.49     | 81.36 -> 80.46 | 87.87 -> 87.40 |
| modal-infra     | 96.20 -> 96.20     | 89.92 -> 89.92 | 95.15 -> 95.15 |

## Selection

Per-suite coverage was compared using original source locations, then candidate deletions were
evaluated cumulatively. A point is redundant only while another retained suite still covers it;
individually redundant files are not necessarily redundant when removed together. Python test
contexts also identified duplicated cases within suites and redundant parameter combinations.

The reduction favors removing mocked SQL, handler delegation, helper, and orchestration tests when
retained integration or higher-level behavioral tests exercise the implementation. It keeps:

- All 140 control-plane workerd integration files, using real D1 and Durable Object storage.
- All Node-host and storage conformance suites.
- Web component and hook integration suites.
- Core authentication, signature, cookie identity, migration, architecture, and type contracts.
- Focused sandbox manager signature, spawn-admission, and late-provider-result race regressions.
- Real local-process, Git, shell, socket, and tool tests in the sandbox runtime.

Coverage overlap is not assertion equivalence. Some isolated input permutations, error wording,
provider error-classification matrices, and interleavings no longer have dedicated assertions. The
retained integration tests cover their broader behavior, but this reduction does not claim to
preserve every old assertion or to be a mathematically optimal minimum test set.

## Reproducing Coverage

Build shared first and run heavyweight checks sequentially. `scripts/coverage-baseline.json` stores
the normalized baseline counters and the three-point budget. `scripts/coverage-policy.ts` derives
floors from those exact counters, rounding up to two decimals rather than loosening the budget. The
Vitest configs and report checker share this policy. Python statement and branch floors are enforced
independently; a high combined score cannot hide a branch regression.

`.github/workflows/coverage.yml` runs the entire policy on every PR targeting `main` and every push
to `main`, without path filters or `continue-on-error`. Control-plane and web coverage run in
parallel shards; the final `Coverage` check merges their reports before enforcing full-suite floors
and fails if any shard or other package job fails. It also fails on missing/invalid reports or any
metric below its floor, and uploads the combined coverage artifact. The workflow tests its gate,
including CLI failure on low Python branch coverage.

Repository rules are separate from workflow files: an administrator must add `Coverage` as a
required status check in the main ruleset. The authenticated integration cannot administer rules
(HTTP 403), and the current effective main rules have no required-status-check rule. This external
setting remains outstanding; the workflow alone is not claimed to make GitHub merges conditional.

```bash
npm run build -w @open-inspect/shared
npm run test:coverage -w @open-inspect/control-plane -- --maxWorkers=1
npm run test:coverage -w @open-inspect/web -- --maxWorkers=1
npm run test:coverage -w @open-inspect/shared -- --maxWorkers=1
npm run test:coverage -w @open-inspect/slack-bot -- --maxWorkers=1
npm run test:coverage -w @open-inspect/linear-bot -- --maxWorkers=1
npm run test:coverage -w @open-inspect/github-bot -- --maxWorkers=1

uv run --frozen --project packages/modal-infra --extra dev pytest packages/modal-infra/tests --cov=packages/modal-infra/src --cov-branch --cov-report=json:packages/modal-infra/coverage/coverage.json
node scripts/check-coverage.mjs modal-infra packages/modal-infra/coverage/coverage.json
uv run --frozen --project packages/sandbox-runtime --extra dev pytest packages/sandbox-runtime/tests --cov=packages/sandbox-runtime/src --cov-branch --cov-report=json:packages/sandbox-runtime/coverage/coverage.json
node scripts/check-coverage.mjs sandbox-runtime packages/sandbox-runtime/coverage/coverage.json
npm run test:coverage-gate
```

TypeScript JSON summaries are written to each package's `coverage/coverage-summary.json`. For
Python, both statement and branch percentages in the JSON `totals` are checked, rather than treating
`percent_covered` as line coverage. Missing branch counters fail closed.

The control-plane coverage command now runs both Node and workerd projects in one Istanbul report.
V8 coverage cannot run inside workerd because Workers lack its inspector API. Both control-plane
measurements used the same Istanbul provider. Other packages retain V8. Both sides of the normalized
comparison exclude `.test`/`.spec` implementations, named test helpers/support/fixtures, declaration
files, and the existing `src/index.ts` entrypoint exclusions. Shared additionally excludes its
test-only `src/triggers/testing.ts`. No generic `*helper*` pattern excludes production credential
helpers. Python reports still measure only production `src/` files, so their baselines are
unchanged.

Vitest 4 already excluded discovered `.test.tsx` suites before this correction: the original web
report contains zero `.test.tsx` or `.test.ts` files. The actual normalization removes two web
fixtures, three control-plane helpers, and one helper each from shared, Slack, and Linear. Counter
filtering, not averages of per-file percentages, produces the recorded baselines.

## Merge Validation

After merging `main` at `452b0b9`, six modify/delete conflicts were resolved by retaining focused
upstream regressions for canonical automation owners, bounded D1 parameters, linked-session privacy,
synchronous archive failures, executor audit events, and environment selection equality. The old
redundant cases remain removed, and all upstream integration additions are retained.

The following are historical validation percentages from that merge, before helper/fixture
normalization, not a new before/after benchmark.

| Package                   | Passed | Skipped | Statements | Branches | Functions | Lines |
| ------------------------- | -----: | ------: | ---------: | -------: | --------: | ----: |
| control-plane, both hosts |  6,002 |       1 |      90.92 |    82.66 |     95.86 | 92.72 |
| web                       |  1,965 |       0 |      74.35 |    73.05 |     74.15 | 75.54 |
| shared                    |    909 |       0 |      92.05 |    81.91 |     89.83 | 93.07 |
| sandbox-runtime           |  1,279 |       3 |      89.50 |    80.49 |       N/A | 89.50 |

Sandbox-runtime combined coverage is 87.42%. The eleven focused conflict-resolution cases also pass
independently. Repository typechecks, ESLint, and formatting checks were rerun for the merge.

## Security Review Follow-Up

Three focused security checks were restored without restoring the removed suites: single-session
export refuses a readable session without `sessions.export` before loading its trace; the public
prompt route rejects caller-provided `authorId` before runtime dispatch; and failed
repository-scoped credential minting remains unavailable without retrying with broader credentials.
The route checks use real D1/DO sessions and verified browser credentials. The planner check injects
only the mint failure and retains the real scope resolver and planning path.

## Deep Review Follow-Up

Compact tests now preserve the contracts aggregate coverage cannot establish:

- Real D1 environment membership/current-team grant intersection and TOCTOU rejection, including
  unavailable credentials without broad-auth retry.
- Real SQLite post-encryption generation, status, fence, and provider-reference predicates, with
  successor URLs/secrets unchanged and successful controls.
- Shutdown-handler-before-ACK and no-ACK-on-failure for both critical shutdown event types.
- Incoming bridge ACK routing through the real forwarder, including boot-time passthrough.
- Gated same-repository PR conflicts, claim release after failure, and independent-repository
  concurrency through the real service and claims object.

Production-only runs at `6f4c32f` pass all floors. These validation results are separate from the
historical fixed-denominator comparison above.

| Package                   | Passed | Skipped | Statements | Branches | Functions | Lines |
| ------------------------- | -----: | ------: | ---------: | -------: | --------: | ----: |
| control-plane, both hosts |  6,038 |       1 |      90.97 |    82.74 |     96.21 | 92.77 |
| web                       |  1,965 |       0 |      74.15 |    73.04 |     73.83 | 75.37 |
| shared                    |    909 |       0 |      92.10 |    82.04 |     89.89 | 93.13 |
| slack-bot                 |    397 |       0 |      88.71 |    78.95 |     93.65 | 89.47 |
| linear-bot                |    228 |       0 |      85.18 |    72.19 |     88.43 | 86.48 |
| github-bot                |    134 |       0 |      93.65 |    88.00 |     93.75 | 94.69 |
| modal-infra               |    511 |       0 |      96.20 |    89.92 |       N/A | 96.20 |
| sandbox-runtime           |  1,285 |       3 |      89.56 |    80.70 |       N/A | 89.56 |

## Additional Main Merge

After merging `main` at `5abc1fb`, eight test conflicts were resolved by retaining the new analytics
source/user attribution, Slack channel/team boundary, and channel-binding audit assertions. The
older redundant cases remain removed. All 57 focused resolution cases, all eight full coverage
suites, and the unchanged coverage floors pass. No baseline or coverage budget was reset for the
upstream features. The required-check administration setting remains a separate external step.
