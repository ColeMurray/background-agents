import {
  SELECT_TARGET_ACTION_ID,
  SELECT_TARGET_QUICK_PICK_ACTION_ID,
  baseActionId,
  isTargetInteractionBlockId,
  parseTargetInteractionRequestId,
} from "../target-clarification";
import type { BackgroundTaskScheduler, SlackInteractionPayload, Env } from "../types";
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
  const userId = payload.user?.id;
  switch (baseActionId(action.action_id)) {
    case SELECT_TARGET_ACTION_ID:
    case SELECT_TARGET_QUICK_PICK_ACTION_ID: {
      if (!channel || !messageTs || !userId) return;
      const selectedValue = action.selected_option?.value ?? action.value;
      if (selectedValue) {
        const selectionSource =
          baseActionId(action.action_id) === SELECT_TARGET_QUICK_PICK_ACTION_ID
            ? "quick_pick"
            : "picker";
        const parsedRequestId = action.block_id
          ? parseTargetInteractionRequestId(action.block_id, selectionSource)
          : undefined;
        // Only refuse a block id this code minted and then failed to parse —
        // a mismatched or malformed one. A clarification control posted by an
        // earlier deployment carries the old `repo_quick_picks` block id (or a
        // Slack-generated one), which never parses; those clicks still resolve
        // through the pending request's channel and thread, so dropping them
        // would silently break every control in flight across a deploy.
        if (action.block_id && !parsedRequestId && isTargetInteractionBlockId(action.block_id)) {
          return;
        }
        const requestId = parsedRequestId ?? undefined;
        await handleTargetSelection(
          {
            requestId,
            selectedValue,
            channel,
            messageTs,
            threadTs,
            selectedBy: userId,
            selectionSource,
          },
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
