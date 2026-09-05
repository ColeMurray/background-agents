#!/usr/bin/env node
/**
 * Fails when control-plane SQL uses a construct that only SQLite understands.
 *
 * The control plane's stores run today on D1 and on Node-hosted SQLite, and
 * are slated to run on Postgres. Every SQLite-only construct written now
 * becomes a migration twin or a store rewrite then, so this check holds the
 * line at the portable subset documented in docs/PORTABLE_SQL.md.
 *
 * Scope:
 *   - TypeScript under packages/control-plane/src, excluding tests and
 *     src/node (that directory is the SQLite driver itself: its job is to
 *     speak SQLite).
 *   - terraform/d1/migrations/NNNN_*.sql numbered above the checked-in
 *     baseline. Migrations at or below it are grandfathered.
 *
 * Occurrences that must stay are listed with a reason in
 * scripts/sql-portability-baseline.json. The counts there are a ratchet:
 * adding one fails, and removing one fails until the baseline is lowered.
 *
 * Usage: node scripts/lint-sql-portability.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = join(repoRoot, "scripts/sql-portability-baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

export const RULES = [
  {
    id: "insert-or",
    pattern: /\bINSERT\s+OR\s+(IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b/gi,
    portable: "INSERT ... ON CONFLICT DO NOTHING / ON CONFLICT (...) DO UPDATE SET ...",
  },
  {
    id: "create-trigger",
    pattern: /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/gi,
    portable: "enforce the invariant in the store, not in a trigger",
  },
  {
    id: "strftime",
    pattern: /\bstrftime\s*\(/gi,
    portable: "format the timestamp in TypeScript",
  },
  {
    id: "unixepoch",
    pattern: /\bunixepoch\b/gi,
    portable: "pass Date.now() in the column's unit, or bucket with integer division",
  },
  {
    id: "pragma",
    pattern: /\bPRAGMA\b/gi,
    portable: "no portable form; keep engine setup and introspection in the adapter",
  },
  {
    id: "collate-nocase",
    pattern: /\bCOLLATE\s+NOCASE\b/gi,
    portable: "LOWER(column) = LOWER(?)",
  },
  {
    id: "autoincrement",
    pattern: /\bAUTOINCREMENT\b/gi,
    portable: "an application-generated id, or a plain INTEGER PRIMARY KEY",
  },
  {
    id: "json-function",
    pattern: /\bjson(?:_[a-z_]+)?\s*\(/g,
    portable: "build the JSON in TypeScript and bind it as a parameter",
  },
];

/** A literal reads as SQL when it contains a statement this codebase issues. */
const SQL_SHAPE =
  /\b(SELECT\s|INSERT\s+INTO\b|INSERT\s+OR\s+(IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b|UPDATE\s+[a-z_"]+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(TABLE|INDEX|TRIGGER|VIEW|UNIQUE)\b|ALTER\s+TABLE\b|DROP\s+(TABLE|INDEX|TRIGGER|VIEW)\b|WITH\s+[a-z_]+\s+AS\s*\()/i;

/**
 * A pragma is always the whole statement, so it is recognised only as a
 * literal of the shape `PRAGMA name`, `PRAGMA name = value` or
 * `PRAGMA name(argument)`. Prose that opens with the word does not qualify.
 */
const SQL_PRAGMA = /^[`'"]\s*PRAGMA\s+[a-z_]+\s*[(=]|^[`'"]\s*PRAGMA\s+[a-z_]+\s*[`'"]/i;

/**
 * String and template literals in TypeScript source, with the offset of each.
 * A regex scan rather than a parse: it over-reports at worst, and SQL_SHAPE
 * then discards anything that is not a statement.
 */
function stringLiterals(source) {
  const literals = [];
  const scanner = /`(?:\\.|\$\{[^}]*\}|[^\\`])*`|"(?:\\.|[^\\"])*"|'(?:\\.|[^\\'])*'/gs;
  let match;
  while ((match = scanner.exec(source)) !== null) {
    literals.push({ text: match[0], offset: match.index });
  }
  return literals;
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}

export function findingsInSql(text, baseOffset, source, file) {
  const found = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      found.push({
        file,
        line: lineOf(source, baseOffset + match.index),
        rule: rule.id,
        text: match[0].replace(/\s+/g, " "),
        portable: rule.portable,
      });
    }
  }
  return found;
}

export function scanTypeScript(file, source) {
  const found = [];
  for (const literal of stringLiterals(source)) {
    if (!SQL_SHAPE.test(literal.text) && !SQL_PRAGMA.test(literal.text)) continue;
    found.push(...findingsInSql(literal.text, literal.offset, source, file));
  }
  return found;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function controlPlaneSources() {
  const root = join(repoRoot, "packages/control-plane/src");
  return walk(root)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => !relative(root, file).split(sep).includes("node"))
    .sort();
}

function newMigrations() {
  const root = join(repoRoot, "terraform/d1/migrations");
  return readdirSync(root)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => {
      const number = Number.parseInt(name.slice(0, 4), 10);
      return Number.isInteger(number) && number > baseline.migrationBaseline;
    })
    .map((name) => join(root, name))
    .sort();
}

function main() {
  const findings = [];
  for (const file of controlPlaneSources()) {
    const rel = relative(repoRoot, file);
    findings.push(...scanTypeScript(rel, readFileSync(file, "utf8")));
  }
  for (const file of newMigrations()) {
    const rel = relative(repoRoot, file);
    const source = readFileSync(file, "utf8");
    findings.push(...findingsInSql(source, 0, source, rel));
  }

  const counted = new Map();
  for (const finding of findings) {
    const key = `${finding.file} ${finding.rule}`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }

  const errors = [];
  for (const finding of findings) {
    const allowed = baseline.allowed[finding.file]?.[finding.rule]?.count ?? 0;
    if (counted.get(`${finding.file} ${finding.rule}`) <= allowed) continue;
    errors.push(
      `${finding.file}:${finding.line}  ${finding.rule}  ${finding.text}\n` +
        `    portable form: ${finding.portable}`
    );
  }

  const stale = [];
  for (const [file, rules] of Object.entries(baseline.allowed)) {
    for (const [rule, entry] of Object.entries(rules)) {
      const actual = counted.get(`${file} ${rule}`) ?? 0;
      if (actual < entry.count) {
        stale.push(`${file}  ${rule}: baseline allows ${entry.count}, found ${actual}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`SQL portability: ${errors.length} disallowed construct(s).\n`);
    for (const error of errors) console.error(error);
    console.error(
      "\nRewrite in the portable subset (docs/PORTABLE_SQL.md), or, if the " +
        "construct must stay, raise its count in scripts/sql-portability-baseline.json " +
        "with a reason."
    );
  }
  if (stale.length > 0) {
    console.error(
      `\nSQL portability: ${stale.length} stale baseline entr(ies) — lower the ` +
        `count in scripts/sql-portability-baseline.json.\n`
    );
    for (const entry of stale) console.error(`  ${entry}`);
  }
  if (errors.length > 0 || stale.length > 0) process.exit(1);

  console.log(
    `SQL portability: clean (${findings.length} baselined occurrence(s) across ` +
      `${Object.keys(baseline.allowed).length} file(s)).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
