/**
 * Neutral Slack Block Kit primitives.
 *
 * Plain shapes for the subset of Slack's Block Kit the bot emits — text
 * objects, interactive elements, and layout blocks. Kept free of any
 * feature-specific (App Home, repo clarification, …) concerns so every Slack
 * message builder can share them without depending on a feature module.
 */

export type SlackPlainText = { type: "plain_text"; text: string };
export type SlackMrkdwnText = { type: "mrkdwn"; text: string };
export type SlackText = SlackPlainText | SlackMrkdwnText;

export type SlackSelectOption = {
  text: SlackPlainText;
  description?: SlackPlainText;
  value: string;
};

export type SlackSelectOptionGroup = {
  label: SlackPlainText;
  options: SlackSelectOption[];
};

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

// Slack accepts exactly one of options / option_groups on a static_select.
export type SlackStaticSelectElement = {
  type: "static_select";
  action_id: string;
  initial_option?: SlackSelectOption;
  placeholder?: SlackPlainText;
} & ({ options: SlackSelectOption[] } | { option_groups: SlackSelectOptionGroup[] });

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
  // A section accessory may be a button or a select (the repo clarification
  // picker uses an external_select), not only a button.
  accessory?: SlackBlockElement;
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
