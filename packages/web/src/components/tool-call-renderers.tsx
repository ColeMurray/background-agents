import type { ComponentType, ReactNode } from "react";
import type { ToolCallItemProps } from "./tool-call-item";
import { SlackNotifyEvent } from "./slack-notify-event";
import { CreatePullRequestEvent } from "./create-pull-request-event";
import { renderChildStatusDetails } from "./child-status-details";

// Most tools share the timeline shell and only customize expanded details.
// Existing renderers that own their entire row can keep doing so.
interface ToolRenderer {
  Item?: ComponentType<ToolCallItemProps>;
  renderDetails?: (event: ToolCallItemProps["event"]) => ReactNode;
}

const toolRenderers = new Map<string, ToolRenderer>([
  ["slack-notify", { Item: SlackNotifyEvent }],
  ["create-pull-request", { Item: CreatePullRequestEvent }],
  ["get-child-status", { renderDetails: renderChildStatusDetails }],
  ["get-task-status", { renderDetails: renderChildStatusDetails }],
]);

export function getToolRenderer(event: ToolCallItemProps["event"]) {
  return event.truncated ? undefined : toolRenderers.get(event.tool?.toLowerCase() ?? "");
}
