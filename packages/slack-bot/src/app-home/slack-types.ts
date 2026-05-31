import type { SlackInteractionPayload } from "../types";

export interface ModelOption {
  label: string;
  value: string;
}

export type SlackSelectOption = { text: SlackPlainText; value: string };
export type SlackPlainText = { type: "plain_text"; text: string };
export type SlackMrkdwnText = { type: "mrkdwn"; text: string };
export type SlackText = SlackPlainText | SlackMrkdwnText;

export type SlackConfirmation = {
  title: SlackPlainText;
  text: SlackText;
  confirm: SlackPlainText;
  deny: SlackPlainText;
};

export type SlackButtonElement = {
  type: "button";
  action_id: string;
  text: SlackPlainText;
  value?: string;
  style?: "danger";
  confirm?: SlackConfirmation;
};

export type SlackStaticSelectElement = {
  type: "static_select";
  action_id: string;
  initial_option?: SlackSelectOption;
  placeholder?: SlackPlainText;
  options: SlackSelectOption[];
};

export type SlackExternalSelectElement = {
  type: "external_select";
  action_id: string;
  placeholder: SlackPlainText;
  min_query_length: number;
};

export type SlackPlainTextInputElement = {
  type: "plain_text_input";
  action_id: string;
  initial_value: string;
  placeholder: SlackPlainText;
};

export type SlackBlockElement =
  | SlackButtonElement
  | SlackStaticSelectElement
  | SlackExternalSelectElement;
export type SlackHeaderBlock = { type: "header"; text: SlackPlainText };
export type SlackSectionBlock = {
  type: "section";
  text: SlackText;
  accessory?: SlackButtonElement;
};
export type SlackActionsBlock = {
  type: "actions";
  block_id?: string;
  elements: SlackBlockElement[];
};
export type SlackContextBlock = { type: "context"; elements: SlackText[] };
export type SlackInputBlock = {
  type: "input";
  block_id: string;
  optional?: boolean;
  label: SlackPlainText;
  element: SlackPlainTextInputElement;
  hint?: SlackPlainText;
};
export type SlackDividerBlock = { type: "divider" };

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
