import { describe, expect, it, vi } from "vitest";
import {
  AutomationModelProviderAuthStore,
  toProviderSelections,
} from "./automation-model-provider-auth";

interface FakeStatement {
  sql: string;
  params: unknown[];
}

function createFakeDb() {
  const statements: FakeStatement[] = [];
  const statement = {
    bind(...params: unknown[]) {
      statements[statements.length - 1].params = params;
      return statement;
    },
  };
  const db = {
    prepare(sql: string) {
      statements.push({ sql, params: [] });
      return statement;
    },
    batch: vi.fn(),
  } as unknown as D1Database;
  return { db, statements };
}

describe("AutomationModelProviderAuthStore", () => {
  it("hydrates provider selections from persisted rows", () => {
    expect(
      toProviderSelections([
        {
          automation_id: "auto-1",
          provider: "openai",
          auth_mode: "provider_account",
          provider_account_id: "0123456789abcdef0123456789abcdef",
          created_at: 1,
          updated_at: 1,
        },
        {
          automation_id: "auto-1",
          provider: "xai",
          auth_mode: "api_key",
          provider_account_id: null,
          created_at: 1,
          updated_at: 1,
        },
      ])
    ).toEqual({
      openai: {
        mode: "provider_account",
        accountId: "0123456789abcdef0123456789abcdef",
      },
      xai: { mode: "api_key" },
    });
  });

  it("builds composable insert and replacement statements", () => {
    const { db, statements } = createFakeDb();
    const store = new AutomationModelProviderAuthStore(db);
    const selections = {
      openai: {
        mode: "provider_account" as const,
        accountId: "0123456789abcdef0123456789abcdef",
      },
      xai: { mode: "api_key" as const },
    };

    expect(store.bindInserts("auto-1", selections, 10)).toHaveLength(2);
    expect(statements.map(({ params }) => params.slice(0, 4))).toEqual([
      ["auto-1", "openai", "provider_account", "0123456789abcdef0123456789abcdef"],
      ["auto-1", "xai", "api_key", null],
    ]);

    statements.length = 0;
    expect(store.bindReplace("auto-1", selections, 10)).toHaveLength(3);
    expect(statements[0]).toEqual({
      sql: "DELETE FROM automation_model_provider_auth WHERE automation_id = ?",
      params: ["auto-1"],
    });
  });
});
