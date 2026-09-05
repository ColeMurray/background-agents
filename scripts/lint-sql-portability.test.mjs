import assert from "node:assert/strict";
import test from "node:test";

import {
  RULES,
  findingsIn,
  maskSqlComments,
  scanTypeScript,
  targetsSessionEngine,
} from "./lint-sql-portability.mjs";

test("flags every banned construct in a SQL literal", () => {
  const source = [
    'const a = db.prepare("INSERT OR IGNORE INTO t (id) VALUES (?)");',
    'const b = db.prepare("CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN SELECT 1; END");',
    "const c = db.prepare(\"SELECT strftime('%Y', created_at) FROM t\");",
    "const d = db.prepare(\"SELECT date(created_at, 'unixepoch') FROM t\");",
    'const e = db.prepare("PRAGMA table_info(t)");',
    'const f = db.prepare("SELECT id FROM t ORDER BY name COLLATE NOCASE");',
    'const g = db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)");',
    'const h = db.prepare("SELECT json_group_array(id) FROM t");',
    'const i = db.prepare("SELECT id FROM t WHERE id = ?1 AND owner = ?2");',
  ].join("\n");

  const flagged = scanTypeScript("example.ts", source).map((finding) => finding.rule);

  // Enumerated here rather than derived from RULES: taking the expectation
  // from the thing under test would let a rule that was never written pass.
  const expected = [
    "autoincrement",
    "collate-nocase",
    "create-trigger",
    "insert-or",
    "json-function",
    "numbered-placeholder",
    "pragma",
    "strftime",
    "unixepoch",
  ];
  assert.deepEqual([...new Set(flagged)].sort(), expected, "every banned construct fires");
  assert.deepEqual(
    RULES.map((rule) => rule.id).sort(),
    expected,
    "and the fixture covers every rule there is"
  );
});

test("does not read SQL quoted in a comment as SQL", () => {
  const source = [
    '// "INSERT OR IGNORE INTO t VALUES (?)" is what we used to do',
    "/* CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN SELECT 1; END */",
    "const a = 1;",
  ].join("\n");

  assert.deepEqual(scanTypeScript("example.ts", source), []);
});

test("sees a clause fragment that carries no statement of its own", () => {
  // How this codebase composes a WHERE: the fragment is a literal on its own,
  // and only becomes a statement after interpolation.
  const source = [
    "conditions.push(\"name LIKE ? ESCAPE '\\\\' COLLATE NOCASE\");",
    'const sql = `SELECT * FROM t WHERE ${conditions.join(" AND ")}`;',
  ].join("\n");

  assert.deepEqual(
    scanTypeScript("example.ts", source).map((finding) => finding.rule),
    ["collate-nocase"]
  );
});

test("does not desynchronise on an escaped quote", () => {
  // A scanner that mistook the escaped quote for an opener would swallow the
  // rest of the file and report findings from anywhere in it.
  const source = [
    "const a = \"ESCAPE '\\\\'\";",
    "const b = 1;",
    'const c = db.prepare("SELECT 1");',
  ].join("\n");

  assert.deepEqual(scanTypeScript("example.ts", source), []);
});

test("matches SQL function names whatever their case", () => {
  const flagged = scanTypeScript(
    "example.ts",
    "const a = db.prepare(\"SELECT JSON_OBJECT('x', id) FROM t\");"
  );
  assert.deepEqual(
    flagged.map((finding) => finding.rule),
    ["json-function"]
  );
});

test("reads a migration's comments as documentation, not as SQL", () => {
  const sql = [
    "-- Avoid AUTOINCREMENT here; ids come from the application.",
    "/* An INSERT OR IGNORE would hide a duplicate. */",
    "CREATE TABLE t (id INTEGER PRIMARY KEY);",
  ].join("\n");

  assert.deepEqual(findingsIn(maskSqlComments(sql), 0, sql, "0075_example.sql"), []);
  // Masking keeps offsets, so a real finding still reports its own line.
  const real = "-- comment\nCREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);";
  assert.deepEqual(
    findingsIn(maskSqlComments(real), 0, real, "0075_example.sql").map((f) => f.line),
    [2]
  );
});

test("leaves the session engine's own SQL out of scope", () => {
  assert.equal(targetsSessionEngine("import type { SqlStorage } from './sql-storage';"), true);
  assert.equal(
    targetsSessionEngine("import type { SqlDatabase } from '../db/sql-database';"),
    false
  );
});

test("reports the line the construct sits on", () => {
  const source = [
    "const noop = 1;",
    "",
    'const a = db.prepare("INSERT OR REPLACE INTO t VALUES (?)");',
  ].join("\n");

  assert.deepEqual(scanTypeScript("example.ts", source), [
    {
      file: "example.ts",
      line: 3,
      rule: "insert-or",
      text: "INSERT OR REPLACE",
      portable: RULES.find((rule) => rule.id === "insert-or").portable,
    },
  ]);
});

test("ignores TypeScript that merely looks like SQL", () => {
  const source = [
    "const body = await request.json();",
    "return Response.json({ ok: true });",
    'log.info("Pragma header ignored; insert or update decided downstream");',
  ].join("\n");

  assert.deepEqual(scanTypeScript("example.ts", source), []);
});

test("accepts the portable forms these rules exist to steer toward", () => {
  const source = [
    'const a = db.prepare("INSERT INTO t (id) VALUES (?) ON CONFLICT DO NOTHING");',
    'const b = db.prepare("INSERT INTO t (id, n) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET n = excluded.n");',
    'const c = db.prepare("SELECT created_at / 86400000 AS day_index FROM t GROUP BY day_index");',
    'const d = db.prepare("SELECT id FROM t WHERE LOWER(name) = LOWER(?)");',
  ].join("\n");

  assert.deepEqual(scanTypeScript("example.ts", source), []);
});

test("scans a migration file as one SQL body", () => {
  const source = "CREATE TABLE t (\n  id INTEGER PRIMARY KEY AUTOINCREMENT\n);\n";

  assert.deepEqual(
    findingsIn(source, 0, source, "0075_example.sql").map((finding) => [
      finding.rule,
      finding.line,
    ]),
    [["autoincrement", 2]]
  );
});
