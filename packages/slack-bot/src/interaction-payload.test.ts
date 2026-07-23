import { describe, expect, it } from "vitest";

import { slackInteractionPayloadSchema } from "./interaction-payload";

describe("slackInteractionPayloadSchema", () => {
  it("parses a valid modal interaction payload", () => {
    const result = slackInteractionPayloadSchema.safeParse({
      type: "view_submission",
      trigger_id: "trigger-1",
      user: { id: "U123" },
      view: {
        callback_id: "configure_repo",
        private_metadata: "{}",
        state: {
          values: {
            block: {
              action: { type: "plain_text_input", value: "open-inspect/background-agents" },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a malformed partial interaction payload", () => {
    const result = slackInteractionPayloadSchema.safeParse({
      actions: [{ action_id: "repo_select" }],
    });

    expect(result.success).toBe(false);
  });
});
