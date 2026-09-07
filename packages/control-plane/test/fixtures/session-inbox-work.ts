import type { SqlDatabase } from "../../src/db/sql-database";

/** Same wide, schema-backed inbox fixture for Node SQLite and Workerd/D1. */
export async function seedSessionInboxWork(
  db: SqlDatabase,
  count: number,
  shape: "dense" | "sparse"
) {
  await db
    .prepare(
      `INSERT INTO users(id,display_name,created_at,updated_at)
    VALUES ('query-viewer','Viewer',1,1),('query-other','Other',1,1)`
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE n(x) AS (
    SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?
  ) INSERT INTO sessions(id,title,repo_owner,repo_name,model,status,user_id,
      parent_session_id,root_session_id,spawn_source,spawn_depth,created_at,updated_at)
    SELECT 'work-'||x,printf('%0256d',x),'acme','lab','model','completed',
      CASE WHEN ?='sparse' AND x%3=0 THEN 'query-other' ELSE 'query-viewer' END,
      CASE WHEN x%10=2 THEN 'work-'||(x-1) ELSE NULL END,
      'work-'||(CASE WHEN x%10=2 THEN x-1 ELSE x END),
      CASE WHEN x%10=2 THEN 'agent' ELSE 'user' END,
      CASE WHEN x%10=2 THEN 1 ELSE 0 END,1000,1000000-x FROM n`
    )
    .bind(count, shape)
    .run();
}
