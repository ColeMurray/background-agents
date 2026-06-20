import type { SlackInteractionPayload } from "../types";
import type {
  SlackActionsBlock,
  SlackContextBlock,
  SlackDividerBlock,
  SlackHeaderBlock,
  SlackInputBlock,
  SlackSectionBlock,
  SlackSelectOption,
} from "../slack-blocks";

export interface ModelOption {
  label: string;
  value: string;
}

export type AppHomeBlock =
  | SlackHeaderBlock
  | SlackSectionBlock
  | SlackActionsBlock
  | SlackContextBlock
  | SlackDividerBlock;
export type AppHomeModalBlock = SlackSectionBlock | SlackInputBlock;
export type AppHomeView = { type: "home"; blocks: AppHomeBlock[] };

export type SlackBlockAction = NonNullable<SlackInteractionPayload["actions"]>[number];
export type BackgroundTaskScheduler = (promise: Promise<void>) => void;

export type AppHomeInteractionResponseBody =
  | { options: SlackSelectOption[] }
  | { response_action: "errors"; errors: Record<string, string> }
  | { response_action: "clear" }
  | { ok: true };

export type AppHomeInteractionLogContext = {
  interaction_type: string;
  action_id?: string;
  callback_id?: string;
  option_count?: number;
  outcome?: string;
};
