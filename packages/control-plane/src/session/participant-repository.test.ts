import { beforeEach, describe, expect, it } from "vitest";
import { ParticipantRepository } from "./participant-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const rowsByQuery = new Map<string, unknown[]>();
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      return { toArray: () => rowsByQuery.get(query) ?? [], one: () => null, rowsWritten: 0 };
    },
  };
  return {
    sql,
    calls,
    setRows(query: string, rows: unknown[]) {
      rowsByQuery.set(query, rows);
    },
  };
}

describe("ParticipantRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repository: ParticipantRepository;

  beforeEach(() => {
    mock = createMockSql();
    repository = new ParticipantRepository(mock.sql);
  });

  it("looks up participants by user id, token hash, and id", () => {
    const participant = { id: "p-1", user_id: "user-1" };
    mock.setRows(`SELECT * FROM participants WHERE user_id = ?`, [participant]);
    mock.setRows(`SELECT * FROM participants WHERE ws_auth_token = ?`, [participant]);
    mock.setRows(`SELECT * FROM participants WHERE id = ?`, [participant]);

    expect(repository.getParticipantByUserId("user-1")).toEqual(participant);
    expect(repository.getParticipantByWsTokenHash("hash-1")).toEqual(participant);
    expect(repository.getParticipantById("p-1")).toEqual(participant);
  });

  it("returns null when a participant is missing", () => {
    expect(repository.getParticipantByUserId("unknown")).toBeNull();
    expect(repository.getParticipantByWsTokenHash("unknown")).toBeNull();
    expect(repository.getParticipantById("unknown")).toBeNull();
  });

  it("creates a participant with all fields", () => {
    repository.createParticipant({
      id: "p-1",
      userId: "user-1",
      canonicalUserId: "canonical-user-1",
      scmUserId: "gh-123",
      scmLogin: "testuser",
      scmName: "Test User",
      scmEmail: "test@example.com",
      scmAccessTokenEncrypted: "encrypted-token",
      scmTokenExpiresAt: 9000,
      role: "owner",
      joinedAt: 1000,
    });

    expect(mock.calls[0].query).toContain("INSERT INTO participants");
    expect(mock.calls[0].params).toEqual([
      "p-1",
      "user-1",
      "canonical-user-1",
      "gh-123",
      "testuser",
      "Test User",
      "test@example.com",
      "encrypted-token",
      null,
      9000,
      "owner",
      1000,
    ]);
  });

  it("uses null for omitted participant fields", () => {
    repository.createParticipant({ id: "p-1", userId: "user-1", role: "member", joinedAt: 1000 });
    expect(mock.calls[0].params).toEqual([
      "p-1",
      "user-1",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "member",
      1000,
    ]);
  });

  it("updates participant fields with COALESCE", () => {
    repository.updateParticipantCoalesce("p-1", {
      scmLogin: "newlogin",
      scmName: null,
      scmEmail: "new@example.com",
    });
    expect(mock.calls[0].query).toContain("COALESCE");
    expect(mock.calls[0].params).toEqual([
      null,
      null,
      "newlogin",
      null,
      "new@example.com",
      null,
      null,
      null,
      "p-1",
    ]);
  });

  it("updates participant tokens", () => {
    repository.updateParticipantTokens("p-1", {
      scmAccessTokenEncrypted: "access",
      scmRefreshTokenEncrypted: "refresh",
      scmTokenExpiresAt: 9000,
    });
    expect(mock.calls[0].params).toEqual(["access", "refresh", 9000, "p-1"]);
  });

  it("updates the WebSocket token", () => {
    repository.updateParticipantWsToken("p-1", "new-hash", 8000);
    expect(mock.calls[0].params).toEqual(["new-hash", 8000, "p-1"]);
  });

  it("lists participants by join time", () => {
    const participants = [{ id: "p-1", joined_at: 1000 }];
    mock.setRows(`SELECT * FROM participants ORDER BY joined_at`, participants);
    expect(repository.listParticipants()).toEqual(participants);
  });
});
