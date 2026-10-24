import { describe, expect, it } from "vitest";
import { parseActor } from "./principal";

describe("parseActor", () => {
  it.each([
    ["github", "1001"],
    ["slack", "U123ABC"],
    ["linear", "abc-def"],
    ["discord", "123456789"],
  ])("parses a %s author", (provider, providerUserId) => {
    expect(parseActor(`${provider}:${providerUserId}`)).toEqual({ provider, providerUserId });
  });

  it.each(["user-id-123", "anonymous", "unknown:12345", "", "discord:"])(
    "rejects an unqualified or invalid author: %s",
    (authorId) => {
      expect(parseActor(authorId)).toBeNull();
    }
  );
});
