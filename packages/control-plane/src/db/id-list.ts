import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlBoundList, SqlDatabase } from "./sql-database";

/** Build parameterized IN-list bodies; identifiers remain the caller's SQL. */
export function idListBatches(db: SqlDatabase, ids: readonly string[]): SqlBoundList[] {
  if (db.idList) return db.idList(ids);
  const lists: SqlBoundList[] = [];
  for (let start = 0; start < ids.length; start += MAX_D1_QUERY_PARAMETERS) {
    const values = ids.slice(start, start + MAX_D1_QUERY_PARAMETERS);
    lists.push({ sql: values.map(() => "?").join(", "), values });
  }
  return lists;
}
