import { describe, expect, it } from "vitest";
import {
  externalArtifactListResponseSchema,
  externalDiffStateResponseSchema,
  externalMessageListResponseSchema,
} from "./external-resources-api";

describe("external resource pagination schemas", () => {
  it("requires an opaque cursor for truncated message pages", () => {
    expect(
      externalMessageListResponseSchema.safeParse({ messages: [], hasMore: true }).success
    ).toBe(false);
    expect(
      externalMessageListResponseSchema.safeParse({
        messages: [],
        hasMore: true,
        cursor: "opaque",
      }).success
    ).toBe(true);
  });

  it("requires continuation state for truncated artifact and diff pages", () => {
    expect(
      externalArtifactListResponseSchema.safeParse({ artifacts: [], hasMore: true }).success
    ).toBe(false);
    expect(
      externalDiffStateResponseSchema.safeParse({
        version: 1,
        current: null,
        lastError: null,
        unavailableReason: null,
        hasMore: true,
        continuationOffset: 1,
      }).success
    ).toBe(false);
  });
});
