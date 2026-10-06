import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, SlackInteractionPayload } from "../types";
import {
  quickPickActionId,
  targetPickerBlockId,
  targetQuickPickBlockId,
} from "../target-clarification";
import { handleSlackInteraction } from "./dispatcher";
import { handleTargetSelection } from "./target-selection";

vi.mock("./target-selection", () => ({ handleTargetSelection: vi.fn() }));

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
type SlackAction = NonNullable<SlackInteractionPayload["actions"]>[number];

function payload(action: SlackAction) {
  return {
    type: "block_actions",
    user: { id: "U123" },
    channel: { id: "C123" },
    message: { ts: "111.222" },
    actions: [action],
  } satisfies SlackInteractionPayload;
}

describe("handleSlackInteraction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the picker request id to target selection", async () => {
    await handleSlackInteraction(
      payload({
        action_id: "select_repo",
        block_id: targetPickerBlockId(REQUEST_ID),
        selected_option: { value: "acme/app" },
      }),
      {} as Env,
      "trace-1",
      vi.fn()
    );

    expect(handleTargetSelection).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: REQUEST_ID, selectionSource: "picker" }),
      expect.anything(),
      "trace-1",
      expect.any(Function)
    );
  });

  it("passes the quick-pick request id to target selection", async () => {
    await handleSlackInteraction(
      payload({
        action_id: quickPickActionId(0),
        block_id: targetQuickPickBlockId(REQUEST_ID),
        value: "acme/app",
      }),
      {} as Env,
      undefined,
      vi.fn()
    );

    expect(handleTargetSelection).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: REQUEST_ID, selectionSource: "quick_pick" }),
      expect.anything(),
      undefined,
      expect.any(Function)
    );
  });

  it("rejects a malformed or mismatched request block id", async () => {
    await handleSlackInteraction(
      payload({
        action_id: "select_repo",
        block_id: targetQuickPickBlockId(REQUEST_ID),
        selected_option: { value: "acme/app" },
      }),
      {} as Env,
      undefined,
      vi.fn()
    );

    expect(handleTargetSelection).not.toHaveBeenCalled();
  });

  it("routes a click on a control posted before request ids existed", async () => {
    await handleSlackInteraction(
      payload({
        action_id: quickPickActionId(0),
        block_id: "repo_quick_picks",
        value: "acme/app",
      }),
      {} as Env,
      undefined,
      vi.fn()
    );

    expect(handleTargetSelection).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: undefined, selectionSource: "quick_pick" }),
      expect.anything(),
      undefined,
      expect.any(Function)
    );
  });

  it("routes a click carrying a Slack-generated block id", async () => {
    await handleSlackInteraction(
      payload({
        action_id: "select_repo",
        block_id: "Xq2n",
        selected_option: { value: "acme/app" },
      }),
      {} as Env,
      undefined,
      vi.fn()
    );

    expect(handleTargetSelection).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: undefined, selectionSource: "picker" }),
      expect.anything(),
      undefined,
      expect.any(Function)
    );
  });
});
