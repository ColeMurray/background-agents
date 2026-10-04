import { assertD1QueryParameterLimit } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/**
 * Parameterized SQL whose values travel with the text that uses them.
 *
 * Building a query by interpolating conditional clauses into a string and binding a separately
 * assembled value list makes placeholder order a hidden invariant. `sql` keeps each value next to
 * its placeholder: interpolated fragments are inlined with their own values, and every other
 * interpolation becomes one `?`. Identifiers are never interpolated — write them as fragments.
 */
export interface SqlFragment {
  readonly text: string;
  readonly values: readonly unknown[];
}

const FRAGMENT = Symbol("SqlFragment");
type TaggedFragment = SqlFragment & { readonly [FRAGMENT]: true };

function fragment(text: string, values: readonly unknown[]): TaggedFragment {
  return { text, values, [FRAGMENT]: true };
}

function isFragment(value: unknown): value is TaggedFragment {
  return typeof value === "object" && value !== null && FRAGMENT in value;
}

export function sql(strings: TemplateStringsArray, ...params: unknown[]): SqlFragment {
  let text = strings[0];
  const values: unknown[] = [];
  params.forEach((param, index) => {
    if (isFragment(param)) {
      text += param.text;
      values.push(...param.values);
    } else {
      text += "?";
      values.push(param);
    }
    text += strings[index + 1];
  });
  return fragment(text, values);
}

/** The empty fragment, for optional clauses. */
sql.empty = fragment("", []) as SqlFragment;

/** Join fragments with a literal separator such as `" AND "` or `", "`. */
sql.join = (fragments: readonly SqlFragment[], separator: string): SqlFragment =>
  fragment(
    fragments.map((part) => part.text).join(separator),
    fragments.flatMap((part) => part.values)
  );

/**
 * Embed constant SQL text declared in code, such as a shared clause. Only string literal types
 * are accepted, so runtime (and therefore user-supplied) strings cannot be passed.
 */
sql.constant = <T extends string>(text: string extends T ? never : T): SqlFragment =>
  fragment(text, []);

/** Prepare and bind a fragment, enforcing the D1 bound-parameter limit. */
export function prepareSql(db: SqlDatabase, query: SqlFragment): SqlStatement {
  assertD1QueryParameterLimit(query.values.length);
  return db.prepare(query.text).bind(...query.values);
}
