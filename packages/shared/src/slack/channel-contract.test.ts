import { describe, expect, it } from "vitest";
import {
  controlPlaneSlackChannelsResponseSchema,
  slackChannelListingSchema,
} from "./channel-contract";

describe("Slack channel picker contracts", () => {
  it("parses normalized control-plane channel listings", () => {
    const channel = slackChannelListingSchema.safeParse({
      id: "C1",
      name: "general",
      isPrivate: false,
      isMember: true,
      ignored: "field",
    });
    const response = controlPlaneSlackChannelsResponseSchema.safeParse({
      channels: [{ id: "C1", name: "general", isPrivate: false, isMember: true }],
      error: "missing_scope",
    });

    expect(channel.success).toBe(true);
    if (channel.success) {
      expect(channel.data).toEqual({
        id: "C1",
        name: "general",
        isPrivate: false,
        isMember: true,
      });
    }
    expect(response.success).toBe(true);
  });

  it("rejects malformed control-plane channel listings", () => {
    expect(
      controlPlaneSlackChannelsResponseSchema.safeParse({
        channels: [{ id: "C1", name: "general", isPrivate: null, isMember: true }],
      }).success
    ).toBe(false);
    expect(
      controlPlaneSlackChannelsResponseSchema.safeParse({ error: "missing_scope" }).success
    ).toBe(false);
  });
});
