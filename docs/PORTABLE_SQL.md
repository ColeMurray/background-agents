# Portable SQL

Control-plane stores speak to more than one engine. Today that is Cloudflare D1 and the Node host's
local SQLite; Postgres is the planned engine for container deployments. A store written against
SQLite-only syntax does not simply fail to compile on the new engine — it has to be rewritten, and
its migrations have to be forked into a per-engine twin. That cost is paid once per construct, so
the cheapest time to avoid it is while the statement is being written.

`npm run lint:sql-portability` enforces the subset below over `packages/control-plane/src`
(excluding tests and `src/node`) and over D1 migrations numbered above the baseline in
`scripts/sql-portability-baseline.json`. It runs in the `Lint & Format (TypeScript)` CI job.

## The subset

| Instead of                              | Write                                                     |
| --------------------------------------- | --------------------------------------------------------- |
| `INSERT OR IGNORE INTO t …`             | `INSERT INTO t … ON CONFLICT DO NOTHING`                  |
| `INSERT OR REPLACE INTO t …`            | `INSERT INTO t … ON CONFLICT (key) DO UPDATE SET …`       |
| `?1`, `?2` numbered placeholders        | positional `?`, bound once per occurrence                 |
| `unixepoch()`, `strftime(…)`            | pass `Date.now()` from TypeScript; format dates there too |
| `json_object(…)`, `json_group_array(…)` | build the JSON in TypeScript and bind it as a parameter   |
| `COLLATE NOCASE`                        | see below — the portable form depends on the clause       |
| `AUTOINCREMENT`                         | an application-generated id, or `INTEGER PRIMARY KEY`     |
| `CREATE TRIGGER`                        | enforce the invariant in the store                        |
| `PRAGMA …`                              | nothing — pragmas belong in the engine adapter            |

Notes on the three that are easy to get wrong:

- **`COLLATE NOCASE` has no single replacement.** It is a property of a comparison, so the portable
  form depends on the clause it sits in: `LOWER(lhs) = LOWER(?)` for equality,
  `LOWER(lhs) LIKE LOWER(?)` for a pattern match, and `ORDER BY LOWER(expr)` for a sort. Rewriting a
  `LIKE` or an `ORDER BY` as an equality is not the same query. Note also that `LOWER(expr)` in an
  `ORDER BY` or a predicate will not use a plain index on `expr`; where that matters, the portable
  answer is an expression index on `LOWER(expr)`, which both engines support.

- **`OR REPLACE` is not an upsert.** It deletes the conflicting row and inserts a new one, so every
  column absent from the statement is reset to its default and any delete-side trigger or cascade
  fires. `ON CONFLICT … DO UPDATE` leaves unlisted columns alone. When converting one, check the
  table for columns the statement does not name and decide deliberately which behaviour you want.
- **Date bucketing.** `date(col / 1000, 'unixepoch')` has no Postgres equivalent. Group by the
  integer day instead — `col / 86400000`, which is integer division on both engines — and render the
  calendar date in TypeScript with `utcDateFromDayIndex`.

## Scope, and what is deliberately outside it

`packages/control-plane/src/node` is the SQLite adapter itself. Its `PRAGMA journal_mode = WAL`,
`PRAGMA busy_timeout` and `PRAGMA foreign_keys` calls are the point of the module, and a Postgres
host would bring its own adapter rather than reinterpret this one. The check skips that directory;
in exchange, store logic does not belong there — anything a Postgres deployment would also need
lives in `src/db` or `src/session` and is checked.

Migrations already merged are grandfathered by number, not rewritten. Converting them is a separate
piece of work; the baseline exists so the pile stops growing meanwhile.

## Exceptions

A construct that genuinely has no portable form is listed in `scripts/sql-portability-baseline.json`
with a count and a written reason. The counts ratchet: adding an occurrence fails the check, and so
does removing one until the count is lowered, which keeps the file honest as the debt is paid down.

Adding an entry is a review decision. The reason field should say what the portable form would cost
here, not merely that one does not exist.
