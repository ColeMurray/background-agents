import { describe, expect, it } from "vitest";
import { checkAccess, denialMessage, parseIdList } from "./access";
import { createInteraction } from "./test-helpers";

const config = { allowedRoleIds: ["role-dev"], allowedChannelIds: ["chan-tasks"] };

describe("parseIdList", () => {
  it("splits, trims, and drops empty entries", () => {
    expect(parseIdList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(parseIdList(undefined)).toEqual([]);
  });
});

describe("checkAccess", () => {
  it("allows a dev in the task channel", () => {
    expect(checkAccess(createInteraction(), config)).toEqual({ allowed: true });
  });

  it("allows a dev in a thread under the task channel", () => {
    const interaction = createInteraction({
      channel_id: "thread-1",
      channel: { id: "thread-1", type: 11, parent_id: "chan-tasks" },
    });
    expect(checkAccess(interaction, config)).toEqual({ allowed: true });
  });

  it("rejects other channels", () => {
    const interaction = createInteraction({ channel_id: "chan-general" });
    expect(checkAccess(interaction, config)).toEqual({ allowed: false, reason: "wrong_channel" });
  });

  it("accepts any channel when no channel is configured", () => {
    const interaction = createInteraction({ channel_id: "chan-general" });
    expect(checkAccess(interaction, { ...config, allowedChannelIds: [] })).toEqual({
      allowed: true,
    });
  });

  it("rejects members without an allowed role", () => {
    const base = createInteraction();
    const interaction = createInteraction({ member: { ...base.member!, roles: ["role-other"] } });
    expect(checkAccess(interaction, config)).toEqual({ allowed: false, reason: "missing_role" });
  });

  it("fails closed when no role is configured", () => {
    expect(checkAccess(createInteraction(), { ...config, allowedRoleIds: [] })).toEqual({
      allowed: false,
      reason: "missing_role",
    });
  });

  it("rejects DMs", () => {
    const interaction = createInteraction({ guild_id: undefined, member: undefined });
    expect(checkAccess(interaction, config)).toEqual({ allowed: false, reason: "not_in_guild" });
  });
});

describe("denialMessage", () => {
  it("links the allowed channels", () => {
    expect(denialMessage({ allowed: false, reason: "wrong_channel" }, ["c1", "c2"])).toBe(
      "Tasks can only be submitted in <#c1>, <#c2>."
    );
  });
});
