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
an aggregate average that could hide a large loss in one package. Fresh before/after runs passed,
and every statement, branch, function, and line denominator remained unchanged.

| Package                   | Before | After | Removed | Largest Coverage Drop |
| ------------------------- | -----: | ----: | ------: | --------------------: |
| control-plane, both hosts |  7,916 | 5,841 |   2,075 |               2.36 pp |
| web                       |  2,708 | 1,881 |     827 |               2.38 pp |
| shared                    |  1,093 |   903 |     190 |               2.25 pp |
| slack-bot                 |    512 |   397 |     115 |               2.27 pp |
| linear-bot                |    267 |   228 |      39 |               1.85 pp |
| github-bot                |    146 |   134 |      12 |               0.57 pp |
| sandbox-runtime           |  1,404 | 1,278 |     126 |               0.90 pp |
| modal-infra               |    541 |   511 |      30 |               0.00 pp |

Other suites, including docs, sandbox-images, native Node tooling tests, and Terraform contracts,
were not reduced and are not included in these totals.

### TypeScript Coverage

Each cell shows baseline coverage followed by coverage after removal, in percent.

| Package       | Statements     | Branches       | Functions      | Lines          |
| ------------- | -------------- | -------------- | -------------- | -------------- |
| control-plane | 92.47 -> 90.79 | 84.84 -> 82.48 | 96.79 -> 95.79 | 94.12 -> 92.64 |
| web           | 75.97 -> 73.60 | 74.56 -> 72.18 | 75.58 -> 73.39 | 77.01 -> 74.77 |
| shared        | 93.58 -> 91.87 | 83.89 -> 81.81 | 91.82 -> 89.57 | 94.56 -> 92.87 |
| slack-bot     | 90.24 -> 88.72 | 81.09 -> 78.82 | 95.48 -> 93.67 | 90.42 -> 89.48 |
| linear-bot    | 86.81 -> 85.43 | 74.24 -> 72.45 | 91.35 -> 89.50 | 88.13 -> 86.84 |
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

Build shared first and run heavyweight checks sequentially. Coverage commands fail if a TypeScript
metric falls below its recorded baseline minus three percentage points. These floors are in the
package Vitest configs; the existing CI test commands are unchanged and do not enable coverage
automatically.

```bash
npm run build -w @open-inspect/shared
npm run test:coverage -w @open-inspect/control-plane -- --maxWorkers=1
npm run test:coverage -w @open-inspect/web -- --maxWorkers=1
npm run test:coverage -w @open-inspect/shared -- --maxWorkers=1
npm run test:coverage -w @open-inspect/slack-bot -- --maxWorkers=1
npm run test:coverage -w @open-inspect/linear-bot -- --maxWorkers=1
npm run test:coverage -w @open-inspect/github-bot -- --maxWorkers=1

uv run --frozen --project packages/modal-infra --extra dev pytest packages/modal-infra/tests --cov=packages/modal-infra/src --cov-branch --cov-report=json:packages/modal-infra/coverage/coverage.json
uv run --frozen --project packages/sandbox-runtime --extra dev pytest packages/sandbox-runtime/tests --cov=packages/sandbox-runtime/src --cov-branch --cov-report=json:packages/sandbox-runtime/coverage/coverage.json
```

TypeScript JSON summaries are written to each package's `coverage/coverage-summary.json`. For
Python, inspect both statement and branch percentages in the JSON `totals`, rather than treating
`percent_covered` as line coverage. Python coverage is measured but has no new automatic threshold.

The control-plane coverage command now runs both Node and workerd projects in one Istanbul report.
V8 coverage cannot run inside workerd because Workers lack its inspector API. Both control-plane
measurements used the same Istanbul provider and source scope, excluding `.test-support.ts` files
that otherwise break uncovered-file instrumentation. Other packages retain their existing V8 source
scopes. Established test-helper/fixture inclusion was not changed between measurements.

## Merge Validation

After merging `main` at `452b0b9`, six modify/delete conflicts were resolved by retaining focused
upstream regressions for canonical automation owners, bounded D1 parameters, linked-session privacy,
synchronous archive failures, executor audit events, and environment selection equality. The old
redundant cases remain removed, and all upstream integration additions are retained.

The following are current coverage percentages, not a new before/after benchmark. All configured
TypeScript coverage floors pass.

| Package                   | Passed | Skipped | Statements | Branches | Functions | Lines |
| ------------------------- | -----: | ------: | ---------: | -------: | --------: | ----: |
| control-plane, both hosts |  6,002 |       1 |      90.92 |    82.66 |     95.86 | 92.72 |
| web                       |  1,965 |       0 |      74.35 |    73.05 |     74.15 | 75.54 |
| shared                    |    909 |       0 |      92.05 |    81.91 |     89.83 | 93.07 |
| sandbox-runtime           |  1,279 |       3 |      89.50 |    80.49 |       N/A | 89.50 |

Sandbox-runtime combined coverage is 87.42%. The eleven focused conflict-resolution cases also pass
independently. Repository typechecks, ESLint, and formatting checks were rerun for the merge.
