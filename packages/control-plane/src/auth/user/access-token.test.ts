import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_PREFIX } from "@open-inspect/shared/types/access-tokens";
import { authenticateAccessToken, readAccessTokenHeader } from "./access-token";
import type { SqlDatabase } from "../../db/sql-database";

const VALID = `${ACCESS_TOKEN_PREFIX}${"a".repeat(64)}`;

function headers(value?: string): Headers {
  return new Headers(value === undefined ? {} : { Authorization: value });
}

/** A database whose single lookup returns `row`, and that records its binds. */
function stubDb(row: Record<string, unknown> | null): {
  db: SqlDatabase;
  first: ReturnType<typeof vi.fn>;
} {
  const first = vi.fn(async () => row);
  const statement = { bind: vi.fn(() => statement), first, run: vi.fn(), all: vi.fn() };
  return { db: { prepare: vi.fn(() => statement) } as unknown as SqlDatabase, first };
}

describe("readAccessTokenHeader", () => {
  it("reads a well-formed token", () => {
    expect(readAccessTokenHeader(headers(`Bearer ${VALID}`))).toBe(VALID);
  });

  it("ignores an absent or non-Bearer header", () => {
    expect(readAccessTokenHeader(headers())).toBeNull();
    expect(readAccessTokenHeader(headers(`Basic ${VALID}`))).toBeNull();
  });

  it("ignores a bearer credential that is not one of ours", () => {
    // Sandbox tokens arrive on this same header (router.ts). Rejecting them on
    // shape, before any lookup, is what lets them fall through to sandbox auth
    // instead of being consumed here as a failed access token.
    expect(readAccessTokenHeader(headers("Bearer deadbeefcafe"))).toBeNull();
    expect(readAccessTokenHeader(headers(`Bearer ${"a".repeat(64)}`))).toBeNull();
  });

  it("ignores a token of the right prefix but the wrong length or alphabet", () => {
    expect(
      readAccessTokenHeader(headers(`Bearer ${ACCESS_TOKEN_PREFIX}${"a".repeat(63)}`))
    ).toBeNull();
    expect(
      readAccessTokenHeader(headers(`Bearer ${ACCESS_TOKEN_PREFIX}${"z".repeat(64)}`))
    ).toBeNull();
  });
});

describe("authenticateAccessToken", () => {
  it("resolves a live token to its owner", async () => {
    const { db } = stubDb({ id: "token-1", user_id: "user-1", expires_at: null });
    await expect(authenticateAccessToken(db, VALID)).resolves.toEqual({
      userId: "user-1",
      tokenId: "token-1",
    });
  });

  it("looks the token up by hash, never by its plaintext", async () => {
    const { db, first } = stubDb(null);
    const statement = (db.prepare as ReturnType<typeof vi.fn>).mock.results;
    await authenticateAccessToken(db, VALID);

    expect(first).toHaveBeenCalled();
    const bound = (statement[0].value.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bound[0]).not.toBe(VALID);
    expect(bound[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an unknown token", async () => {
    const { db } = stubDb(null);
    await expect(authenticateAccessToken(db, VALID)).resolves.toBeNull();
  });

  it("rejects an expired token, and accepts one that expires later", async () => {
    const now = 1_000_000;
    const expired = stubDb({ id: "t", user_id: "u", expires_at: now - 1 });
    await expect(authenticateAccessToken(expired.db, VALID, now)).resolves.toBeNull();

    const live = stubDb({ id: "t", user_id: "u", expires_at: now + 1 });
    await expect(authenticateAccessToken(live.db, VALID, now)).resolves.toMatchObject({
      userId: "u",
    });
  });

  it("treats expiry exactly at now as expired", async () => {
    const now = 1_000_000;
    const { db } = stubDb({ id: "t", user_id: "u", expires_at: now });
    await expect(authenticateAccessToken(db, VALID, now)).resolves.toBeNull();
  });
});
