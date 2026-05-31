import { describe, expect, it } from "vitest";
import { deriveParticipantUserId, parseAuthorId } from "./identity";

describe("parseAuthorId", () => {
  it("parses github authorId", () => {
    expect(parseAuthorId("github:1001")).toEqual({
      provider: "github",
      providerUserId: "1001",
    });
  });

  it("parses slack authorId", () => {
    expect(parseAuthorId("slack:U123ABC")).toEqual({
      provider: "slack",
      providerUserId: "U123ABC",
    });
  });

  it("parses linear authorId", () => {
    expect(parseAuthorId("linear:abc-def")).toEqual({
      provider: "linear",
      providerUserId: "abc-def",
    });
  });

  it("returns null for plain user ID (web client)", () => {
    expect(parseAuthorId("user-id-123")).toBeNull();
  });

  it("returns null for 'anonymous'", () => {
    expect(parseAuthorId("anonymous")).toBeNull();
  });

  it("returns null for unknown provider prefix", () => {
    expect(parseAuthorId("unknown:12345")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAuthorId("")).toBeNull();
  });
});

describe("deriveParticipantUserId", () => {
  it("returns explicit userId for non-bot spawnSource", () => {
    expect(deriveParticipantUserId({ userId: "user-abc", spawnSource: "user" })).toBe("user-abc");
  });

  it("ignores explicit userId for bot spawnSource and derives from identity fields", () => {
    expect(
      deriveParticipantUserId({
        userId: "user-abc",
        spawnSource: "github-bot",
        scmUserId: "1001",
      })
    ).toBe("github:1001");
  });

  it("derives github-bot userId from scmUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "github-bot", scmUserId: "1001" })).toBe(
      "github:1001"
    );
  });

  it("derives slack-bot userId from actorUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "slack-bot", actorUserId: "U123" })).toBe(
      "slack:U123"
    );
  });

  it("derives linear-bot userId from actorUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "linear-bot", actorUserId: "lin-abc" })).toBe(
      "linear:lin-abc"
    );
  });

  it("falls back to anonymous for github-bot without scmUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "github-bot" })).toBe("anonymous");
  });

  it("falls back to anonymous for slack-bot without actorUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "slack-bot" })).toBe("anonymous");
  });

  it("falls back to anonymous for linear-bot without actorUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "linear-bot" })).toBe("anonymous");
  });

  it("falls back to anonymous for unknown spawnSource", () => {
    expect(deriveParticipantUserId({ spawnSource: "user" })).toBe("anonymous");
  });

  it("falls back to anonymous when no fields provided", () => {
    expect(deriveParticipantUserId({})).toBe("anonymous");
  });
});
