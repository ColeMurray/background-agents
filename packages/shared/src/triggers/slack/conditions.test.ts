import { describe, it, expect } from "vitest";
import { matchesConditions, validateConditions } from "../conditions";
import type { TriggerCondition } from "../conditions";
import { conditionRegistry } from "../registry";
import { buildMockEvent } from "../testing";
import { SLACK_TEXT_MAX_LENGTH } from "./normalizer";

const slackEvent = (overrides: { text?: string; channelId?: string; actorUserId?: string }) =>
  buildMockEvent("slack", overrides);

const match = (condition: TriggerCondition, event = slackEvent({ text: "please deploy now" })) =>
  matchesConditions([condition], event, conditionRegistry);

describe("text_match condition", () => {
  it("contains: case-sensitive match", () => {
    expect(match({ type: "text_match", operator: "contains", value: { pattern: "deploy" } })).toBe(
      true
    );
  });

  it("contains: case-sensitive miss", () => {
    expect(match({ type: "text_match", operator: "contains", value: { pattern: "Deploy" } })).toBe(
      false
    );
  });

  it("contains: case-insensitive with flags i", () => {
    expect(
      match({ type: "text_match", operator: "contains", value: { pattern: "DEPLOY", flags: "i" } })
    ).toBe(true);
  });

  it("exact: matches the whole text", () => {
    expect(
      match(
        { type: "text_match", operator: "exact", value: { pattern: "deploy" } },
        slackEvent({ text: "deploy" })
      )
    ).toBe(true);
  });

  it("exact: rejects a substring", () => {
    expect(
      match(
        { type: "text_match", operator: "exact", value: { pattern: "deploy" } },
        slackEvent({ text: "please deploy" })
      )
    ).toBe(false);
  });

  it("exact: case-insensitive with flags i", () => {
    expect(
      match(
        { type: "text_match", operator: "exact", value: { pattern: "DEPLOY", flags: "i" } },
        slackEvent({ text: "deploy" })
      )
    ).toBe(true);
  });

  it("regex: matches", () => {
    expect(
      match({ type: "text_match", operator: "regex", value: { pattern: "deploy\\s+\\w+" } })
    ).toBe(true);
  });

  it("regex: no match", () => {
    expect(match({ type: "text_match", operator: "regex", value: { pattern: "^urgent" } })).toBe(
      false
    );
  });

  it("regex: a malformed pattern is a non-match, not a throw", () => {
    expect(match({ type: "text_match", operator: "regex", value: { pattern: "(" } })).toBe(false);
  });

  it("regex: a disallowed flag is a non-match", () => {
    expect(
      match({ type: "text_match", operator: "regex", value: { pattern: "deploy", flags: "g" } })
    ).toBe(false);
  });

  it("does not match input over the length cap", () => {
    const big = "deploy " + "x".repeat(SLACK_TEXT_MAX_LENGTH);
    expect(
      match(
        { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
        slackEvent({ text: big })
      )
    ).toBe(false);
  });

  it("passes through (true) for non-slack events", () => {
    expect(
      matchesConditions(
        [{ type: "text_match", operator: "contains", value: { pattern: "deploy" } }],
        buildMockEvent("github"),
        conditionRegistry
      )
    ).toBe(true);
  });
});

describe("slack_channel condition", () => {
  it("any_of matches when the channel is in the list", () => {
    expect(
      match(
        { type: "slack_channel", operator: "any_of", value: ["C123", "C999"] },
        slackEvent({ channelId: "C123" })
      )
    ).toBe(true);
  });

  it("any_of misses when the channel is not in the list", () => {
    expect(
      match(
        { type: "slack_channel", operator: "any_of", value: ["C999"] },
        slackEvent({ channelId: "C123" })
      )
    ).toBe(false);
  });
});

describe("slack_actor condition", () => {
  it("include matches the poster", () => {
    expect(
      match(
        { type: "slack_actor", operator: "include", value: ["U1"] },
        slackEvent({ actorUserId: "U1" })
      )
    ).toBe(true);
  });

  it("include rejects a non-listed poster", () => {
    expect(
      match(
        { type: "slack_actor", operator: "include", value: ["U2"] },
        slackEvent({ actorUserId: "U1" })
      )
    ).toBe(false);
  });

  it("exclude rejects a listed poster", () => {
    expect(
      match(
        { type: "slack_actor", operator: "exclude", value: ["U1"] },
        slackEvent({ actorUserId: "U1" })
      )
    ).toBe(false);
  });

  it("exclude allows a non-listed poster", () => {
    expect(
      match(
        { type: "slack_actor", operator: "exclude", value: ["U2"] },
        slackEvent({ actorUserId: "U1" })
      )
    ).toBe(true);
  });
});

describe("validateConditions (slack)", () => {
  it("rejects an empty text_match pattern", () => {
    const errors = validateConditions(
      [{ type: "text_match", operator: "contains", value: { pattern: "" } }],
      "slack",
      conditionRegistry
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a disallowed regex flag", () => {
    const errors = validateConditions(
      [{ type: "text_match", operator: "regex", value: { pattern: "x", flags: "g" } }],
      "slack",
      conditionRegistry
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an invalid regex pattern at save time", () => {
    const errors = validateConditions(
      [{ type: "text_match", operator: "regex", value: { pattern: "(" } }],
      "slack",
      conditionRegistry
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a valid regex with an allowed flag", () => {
    const errors = validateConditions(
      [{ type: "text_match", operator: "regex", value: { pattern: "deploy", flags: "i" } }],
      "slack",
      conditionRegistry
    );
    expect(errors).toHaveLength(0);
  });

  it("rejects an empty slack_channel list", () => {
    const errors = validateConditions(
      [{ type: "slack_channel", operator: "any_of", value: [] }],
      "slack",
      conditionRegistry
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("reports a slack condition used on a github trigger", () => {
    const errors = validateConditions(
      [{ type: "slack_channel", operator: "any_of", value: ["C1"] }],
      "github",
      conditionRegistry
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does not apply to github");
  });
});
