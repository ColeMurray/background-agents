import assert from "node:assert/strict";
import test from "node:test";

import { RULES, findingsInSql, scanTypeScript } from "./lint-sql-portability.mjs";

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
  ].join("\n");

  const flagged = scanTypeScript("example.ts", source).map((finding) => finding.rule);

  assert.deepEqual(
    [...new Set(flagged)].sort(),
    RULES.map((rule) => rule.id).sort(),
    "each rule should fire exactly once over the fixture"
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
    findingsInSql(source, 0, source, "0075_example.sql").map((finding) => [
      finding.rule,
      finding.line,
    ]),
    [["autoincrement", 2]]
  );
});
