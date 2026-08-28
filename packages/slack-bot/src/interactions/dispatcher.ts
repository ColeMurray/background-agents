import {
  SELECT_TARGET_ACTION_ID,
  SELECT_TARGET_QUICK_PICK_ACTION_ID,
  baseActionId,
} from "../target-clarification";
import type { SlackInteractionPayload, Env } from "../types";
import type { BackgroundTaskScheduler } from "../messages/blocks";
import { handleTargetSelection } from "./target-selection";

export async function handleSlackInteraction(
  payload: SlackInteractionPayload,
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  if (payload.type !== "block_actions" || !payload.actions?.length) return;
  const action = payload.actions[0];
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts;
  switch (baseActionId(action.action_id)) {
    case SELECT_TARGET_ACTION_ID:
    case SELECT_TARGET_QUICK_PICK_ACTION_ID: {
      if (!channel || !messageTs) return;
      const selectedValue = action.selected_option?.value ?? action.value;
      if (selectedValue) {
        await handleTargetSelection(
          selectedValue,
          channel,
          messageTs,
          threadTs,
          env,
          traceId,
          scheduleBackground
        );
      }
      break;
    }
    case "view_session":
      break;
  }
}
