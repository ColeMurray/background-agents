import { describe, expect, it } from "vitest";
import {
  channelBindingResponseSchema,
  putTeamChannelBindingRequestSchema,
  teamChannelBindingSchema,
  teamChannelBindingsResponseSchema,
} from "../index";

const binding = {
  provider: "slack",
  externalId: "C123",
  teamId: "team_engineering",
  kind: "primary",
} as const;

describe("team channel binding contracts", () => {
  it.each(["slack", "linear"])("supports provider-keyed %s bindings", (provider) => {
    expect(teamChannelBindingSchema.parse({ ...binding, provider })).toEqual({
      ...binding,
      provider,
    });
  });

  it.each(["primary", "source"])("accepts a %s binding mutation", (kind) => {
    expect(putTeamChannelBindingRequestSchema.parse({ kind })).toEqual({ kind });
  });

  it.each([{}, { kind: "other" }, { kind: "source", teamId: "another-team" }])(
    "rejects invalid mutation bodies %j",
    (body) => {
      expect(putTeamChannelBindingRequestSchema.safeParse(body).success).toBe(false);
    }
  );

  it("validates lists and minimal service lookup responses", () => {
    expect(teamChannelBindingsResponseSchema.parse({ bindings: [binding] })).toEqual({
      bindings: [binding],
    });
    expect(channelBindingResponseSchema.parse({ teamId: null })).toEqual({ teamId: null });
    expect(channelBindingResponseSchema.parse({ teamId: binding.teamId, kind: "source" })).toEqual({
      teamId: binding.teamId,
      kind: "source",
    });
    expect(channelBindingResponseSchema.safeParse({ teamId: binding.teamId }).success).toBe(false);
    expect(channelBindingResponseSchema.safeParse({ teamId: null, kind: "source" }).success).toBe(
      false
    );
  });
});
