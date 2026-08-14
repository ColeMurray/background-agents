import { beforeEach, describe, expect, it } from "vitest";
import type { SqlResult, SqlStorage } from "./sql-storage";
import { WsClientMappingRepository } from "./ws-client-mapping-repository";

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  let rows: unknown[] = [];
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      return { toArray: () => rows, one: () => null, rowsWritten: 0 };
    },
  };
  return { sql, calls, setRows: (value: unknown[]) => (rows = value) };
}

describe("WsClientMappingRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repository: WsClientMappingRepository;

  beforeEach(() => {
    mock = createMockSql();
    repository = new WsClientMappingRepository(mock.sql);
  });

  it("upserts a client mapping", () => {
    repository.upsertWsClientMapping({
      wsId: "ws-1",
      participantId: "p-1",
      clientId: "client-1",
      createdAt: 1000,
    });
    expect(mock.calls[0].query).toContain("INSERT OR REPLACE INTO ws_client_mapping");
    expect(mock.calls[0].params).toEqual(["ws-1", "p-1", "client-1", 1000]);
  });

  it("restores a mapping with joined participant data", () => {
    mock.setRows([{ participant_id: "p-1", client_id: "client-1", user_id: "user-1" }]);
    expect(repository.getWsClientMapping("ws-1")).toMatchObject({
      participant_id: "p-1",
      client_id: "client-1",
      user_id: "user-1",
    });
    expect(mock.calls[0].query).toContain("JOIN participants");
  });

  it("returns null for an unknown mapping", () => {
    expect(repository.getWsClientMapping("unknown")).toBeNull();
  });

  it("checks whether a mapping exists", () => {
    expect(repository.hasWsClientMapping("unknown")).toBe(false);
    mock.setRows([{ participant_id: "p-1" }]);
    expect(repository.hasWsClientMapping("ws-1")).toBe(true);
  });
});
