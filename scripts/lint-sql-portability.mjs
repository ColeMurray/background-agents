#!/usr/bin/env node
/**
 * Fails when control-plane SQL uses a construct that only SQLite understands.
 *
 * The control plane's stores run today on D1 and on Node-hosted SQLite, and
 * are slated to run on Postgres. Every SQLite-only construct written now
 * becomes a migration twin or a store rewrite then, so this check holds the
 * line at the portable subset documented in docs/PORTABLE_SQL.md.
 *
 * Scope is the storage contract, not the directory tree. Checked: TypeScript
 * under packages/control-plane/src whose SQL goes to the engine-neutral
 * `SqlDatabase`. Not checked:
 *   - src/node, the SQLite adapter itself; speaking SQLite is its job.
 *   - any file naming `SqlStorage`, the session Durable Object's synchronous
 *     engine, which src/db/sql-database.ts states is "a different engine with
 *     a load-bearing sync contract, and is intentionally not covered by this
 *     port". Holding it to Postgres policy would be a category error — its
 *     PRAGMA introspection is adapter surface, not portability debt.
 *   - every terraform/d1/migrations/*.sql except the ones named in the
 *     baseline's `grandfatheredMigrations`. Naming them rather than taking
 *     everything below a number is what stops a new migration from being
 *     written into the gap the numbering leaves.
 *
 * Occurrences that must stay are listed with a reason in
 * scripts/sql-portability-baseline.json, which lists the exact text of each
 * one rather than a count: a ratchet in both directions, and one that a
 * swapped construct cannot slip through while the total stays the same.
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
    portable:
      "LOWER(lhs) = LOWER(?) for equality, LOWER(lhs) LIKE LOWER(?) for a match, ORDER BY LOWER(expr) for a sort",
  },
  {
    id: "autoincrement",
    pattern: /\bAUTOINCREMENT\b/gi,
    portable: "an application-generated id, or a plain INTEGER PRIMARY KEY",
  },
  {
    id: "json-function",
    pattern: /\bjson(?:_[a-z_]+)?\s*\(/gi,
    portable: "build the JSON in TypeScript and bind it as a parameter",
  },
  {
    id: "numbered-placeholder",
    pattern: /\?\d+/g,
    portable: "positional ?, bound in order",
  },
];

/**
 * A pragma is the whole statement, so it is recognised only as a literal of
 * the shape `PRAGMA name`, `PRAGMA name = value` or `PRAGMA name(argument)`.
 * Prose that opens with the word does not qualify. Every other rule matches a
 * token that means nothing outside SQL, so those run over every literal —
 * including a fragment that carries no statement of its own, which is how
 * this codebase composes a `WHERE` clause.
 */
const SQL_PRAGMA = /^\s*PRAGMA\s+[a-z_]+\s*(?:[(=]|$)/i;

/**
 * The contents of every string and template literal in TypeScript source,
 * with the offset each begins at.
 *
 * A scanner rather than a regex: a regex cannot tell a quote that opens a
 * literal from one inside another literal or a comment, and desynchronising
 * once makes the rest of the file one long "literal". Comments are skipped,
 * because SQL quoted in one is documentation and reporting it would make the
 * check reject its own explanations. A template yields one literal per chunk
 * between substitutions, and the substitutions themselves are scanned as the
 * code they are.
 */
export function stringLiterals(source) {
  const literals = [];
  scanCode(source, 0, literals, false);
  return literals;
}

/**
 * Scan code, collecting the literals in it. With `untilBrace`, stops after
 * the `}` that closes the substitution this call is scanning and returns the
 * index past it.
 */
function scanCode(source, start, literals, untilBrace) {
  let i = start;
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = scanQuoted(source, i, literals);
      continue;
    }
    if (c === "`") {
      i = scanTemplate(source, i, literals);
      continue;
    }
    if (untilBrace) {
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) return i + 1;
        depth--;
      }
    }
    i++;
  }
  return i;
}

/** Read one `'`- or `"`-quoted literal; an unterminated one is not a literal. */
function scanQuoted(source, start, literals) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "\n") return start + 1;
    if (source[i] === quote) {
      literals.push({ text: source.slice(start + 1, i), offset: start + 1 });
      return i + 1;
    }
    i++;
  }
  return start + 1;
}

/** Read a template literal, emitting each chunk between substitutions. */
function scanTemplate(source, start, literals) {
  let i = start + 1;
  let chunk = i;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "`") {
      literals.push({ text: source.slice(chunk, i), offset: chunk });
      return i + 1;
    }
    if (source[i] === "$" && source[i + 1] === "{") {
      literals.push({ text: source.slice(chunk, i), offset: chunk });
      i = scanCode(source, i + 2, literals, true);
      chunk = i;
      continue;
    }
    i++;
  }
  return i;
}

/** The members of `from` left after removing one of each member of `remove`. */
function withoutFirst(from, remove) {
  const left = [...remove];
  return from.filter((item) => {
    const at = left.indexOf(item);
    if (at === -1) return true;
    left.splice(at, 1);
    return false;
  });
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}

export function findingsIn(text, baseOffset, source, file, rules = RULES) {
  const found = [];
  for (const rule of rules) {
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
    const rules = SQL_PRAGMA.test(literal.text) ? RULES : RULES.filter((r) => r.id !== "pragma");
    found.push(...findingsIn(literal.text, literal.offset, source, file, rules));
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

/**
 * Source with every comment blanked, offsets preserved. Literals are left
 * as they are: a module specifier is one, so blanking them would hide the
 * import this is read from. `stringLiterals` says where they are, and the
 * caller uses that to reject a match that sits inside one.
 */
export function withoutComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const end = c === "`" ? scanTemplate(source, i, []) : scanQuoted(source, i, []);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Whether the file's SQL belongs to the session engine rather than the port.
 * Read from an import of the engine's own module in the code — not from the
 * type's name appearing anywhere in the text, which a comment could supply
 * and so turn the check off for a whole file.
 */
const SESSION_ENGINE_IMPORT = /^\s*import\b[^;]*?\bfrom\s*["'][^"']*sql-storage["']/gm;

export function targetsSessionEngine(source) {
  const code = withoutComments(source);
  const literals = stringLiterals(source).map((l) => [l.offset, l.offset + l.text.length]);
  SESSION_ENGINE_IMPORT.lastIndex = 0;
  let match;
  while ((match = SESSION_ENGINE_IMPORT.exec(code)) !== null) {
    // An import inside a literal is text about an import, not one.
    if (!literals.some(([from, to]) => match.index >= from && match.index < to)) return true;
  }
  return false;
}

function controlPlaneSources() {
  const root = join(repoRoot, "packages/control-plane/src");
  return walk(root)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => !relative(root, file).split(sep).includes("node"))
    .filter((file) => !targetsSessionEngine(readFileSync(file, "utf8")))
    .sort();
}

/**
 * Migration text with its comments blanked, offsets preserved so a finding
 * still reports the line it is on. A comment is documentation: a migration
 * that says why it avoids AUTOINCREMENT must not be read as using it.
 */
export function maskSqlComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      let j = i + 1;
      // SQL escapes a quote by doubling it, so a pair is not the end.
      while (j < sql.length && !(sql[j] === quote && sql[j + 1] !== quote)) {
        j += sql[j] === quote ? 2 : 1;
      }
      out += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

function newMigrations() {
  const root = join(repoRoot, "terraform/d1/migrations");
  return readdirSync(root)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => !baseline.grandfatheredMigrations.includes(name))
    .map((name) => join(root, name))
    .sort();
}

/**
 * Findings weighed against the baseline. `errors` are the occurrences it does
 * not cover; `stale` names the entries it still lists that are gone.
 *
 * Grouped by file and rule and compared as a multiset of the matched text
 * rather than a count: swapping one allowed construct for a different one of
 * the same rule would keep the count and change the SQL.
 */
export function compareToBaseline(findings, allowed) {
  const found = new Map();
  for (const finding of findings) {
    const key = `${finding.file} ${finding.rule}`;
    if (!found.has(key)) found.set(key, []);
    found.get(key).push(finding);
  }

  const errors = [];
  const stale = [];
  const keys = new Set([
    ...found.keys(),
    ...Object.entries(allowed).flatMap(([file, rules]) =>
      Object.keys(rules).map((rule) => `${file} ${rule}`)
    ),
  ]);
  for (const key of [...keys].sort()) {
    const [file, rule] = [key.slice(0, key.lastIndexOf(" ")), key.slice(key.lastIndexOf(" ") + 1)];
    const occurrences = found.get(key) ?? [];
    const permitted = [...(allowed[file]?.[rule]?.occurrences ?? [])].sort();
    const actual = occurrences.map((finding) => finding.text).sort();
    if (permitted.join("\u0000") === actual.join("\u0000")) continue;
    // One report per surplus occurrence, not per occurrence whose text is
    // over budget: with two `json(` and one allowed, only one is disallowed.
    const surplus = withoutFirst(actual, permitted);
    for (const finding of occurrences) {
      const at = surplus.indexOf(finding.text);
      if (at === -1) continue;
      surplus.splice(at, 1);
      errors.push(
        `${finding.file}:${finding.line}  ${finding.rule}  ${finding.text}\n` +
          `    portable form: ${finding.portable}`
      );
    }
    const missing = withoutFirst(permitted, actual);
    if (missing.length > 0) {
      stale.push(
        `${file}  ${rule}: baseline still allows ${missing.join(", ")}, no longer present`
      );
    }
  }
  return { errors, stale };
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
    findings.push(...findingsIn(maskSqlComments(source), 0, source, rel));
  }

  const { errors, stale } = compareToBaseline(findings, baseline.allowed);

  if (errors.length > 0) {
    console.error(`SQL portability: ${errors.length} disallowed construct(s).\n`);
    for (const error of errors) console.error(error);
    console.error(
      "\nRewrite in the portable subset (docs/PORTABLE_SQL.md), or, if the " +
        "construct must stay, list it in scripts/sql-portability-baseline.json " +
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
