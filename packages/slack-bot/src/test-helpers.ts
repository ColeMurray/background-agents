import type { ExecutionContext as HonoExecutionContext } from "hono";
import { vi } from "vitest";

export function makeExecutionContext() {
  return {
    props: {},
    waitUntil: vi.fn<HonoExecutionContext["waitUntil"]>(),
    passThroughOnException: vi.fn<HonoExecutionContext["passThroughOnException"]>(),
  } satisfies HonoExecutionContext;
}

interface PendingLaunchStateRow {
  locator_key: string;
  selected_value: string;
  session_id: string | null;
  snapshot_json: string | null;
  attachment_references_json: string | null;
  attachment_drops_json: string | null;
  expires_at: number;
}

interface MockD1Statement {
  query: string;
  values: unknown[];
  bind(...values: unknown[]): MockD1Statement;
  first<T>(): Promise<T | null>;
  run<T>(): Promise<D1Result<T>>;
}

/** Minimal D1 test double for the pending launch-state queries. */
export function createPendingLaunchStateD1(): D1Database {
  const rows = new Map<string, PendingLaunchStateRow>();
  const result = (results: PendingLaunchStateRow[] = [], changes = 0) =>
    ({ success: true, results, meta: { changes } }) as unknown as D1Result<PendingLaunchStateRow>;

  function execute(statement: MockD1Statement): D1Result<PendingLaunchStateRow> {
    const { query, values } = statement;
    if (query.startsWith("DELETE FROM slack_pending_launch_states WHERE expires_at")) {
      let changes = 0;
      for (const [key, row] of rows) {
        if (row.expires_at <= Number(values[0])) {
          rows.delete(key);
          changes += 1;
        }
      }
      return result([], changes);
    }
    if (query.startsWith("DELETE FROM slack_pending_launch_states")) {
      return result([], rows.delete(String(values[0])) ? 1 : 0);
    }
    if (query.startsWith("INSERT INTO slack_pending_launch_states")) {
      const key = String(values[0]);
      if (rows.has(key)) return result();
      rows.set(key, {
        locator_key: key,
        selected_value: String(values[1]),
        session_id: (values[2] as string | null) ?? null,
        snapshot_json: (values[3] as string | null) ?? null,
        attachment_references_json: (values[4] as string | null) ?? null,
        attachment_drops_json: (values[5] as string | null) ?? null,
        expires_at: Number(values[6]),
      });
      return result([], 1);
    }
    if (query.startsWith("UPDATE slack_pending_launch_states")) {
      const row = rows.get(String(values[11]));
      const expectedSessionId = (values[13] as string | null) ?? null;
      if (
        !row ||
        row.selected_value !== values[12] ||
        row.session_id !== expectedSessionId ||
        row.expires_at <= Date.now()
      ) {
        return result();
      }
      const oldSessionId = row.session_id;
      row.session_id = (values[0] as string | null) ?? row.session_id;
      row.snapshot_json ??= (values[1] as string | null) ?? null;
      if (Number(values[2]) === 1) {
        row.attachment_references_json = null;
      } else if (Number(values[3]) === 1 && values[4] === oldSessionId) {
        row.attachment_references_json ??= (values[5] as string | null) ?? null;
      }
      if (Number(values[6]) === 1) {
        row.attachment_drops_json = null;
      } else if (Number(values[7]) === 1 && values[8] === oldSessionId) {
        row.attachment_drops_json ??= (values[9] as string | null) ?? null;
      }
      row.expires_at = Number(values[10]);
      return result([], 1);
    }
    if (query.startsWith("SELECT selected_value")) {
      const row = rows.get(String(values[0]));
      return result(row && (values.length < 2 || row.expires_at > Number(values[1])) ? [row] : []);
    }
    throw new Error(`Unexpected D1 query: ${query}`);
  }

  const prepare = vi.fn((query: string) => {
    const statement: MockD1Statement = {
      query,
      values: [],
      bind(...values: unknown[]) {
        statement.values = values;
        return statement;
      },
      async first<T>() {
        return (execute(statement).results[0] as T | undefined) ?? null;
      },
      async run<T>() {
        return execute(statement) as unknown as D1Result<T>;
      },
    };
    return statement as unknown as D1PreparedStatement;
  });
  const batch = vi.fn(async (statements: D1PreparedStatement[]) =>
    statements.map((statement) => execute(statement as unknown as MockD1Statement))
  );
  return { prepare, batch } as unknown as D1Database;
}
