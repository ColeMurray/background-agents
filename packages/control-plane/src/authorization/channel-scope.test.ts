import { describe, expect, it } from "vitest";
import { parseChannelScope } from "./channel-scope";

describe("signed channel scope", () => {
  it.each([
    ["slack:C1", { provider: "slack", externalId: "C1" }],
    ["linear:team-1", { provider: "linear", externalId: "team-1" }],
  ])("parses %s without confusing Slack workspace identity with team ownership", (value, scope) => {
    expect(parseChannelScope(value)).toEqual(scope);
  });

  it.each(["", "C1", "slack:", "unknown:C1", "slack: C1", "slack:C1:other"])(
    "rejects malformed or unsupported scope %s",
    (value) => expect(parseChannelScope(value)).toBeNull()
  );
});
