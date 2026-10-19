import type { PiSlackControlAction } from "./sessions/control-plane-client";
import { sha256Hex } from "@open-inspect/shared/service-auth";

export interface SlackPiExplicitControl {
  action: PiSlackControlAction;
  content: string;
}

/** Only these unambiguous prefixes bypass the ordinary queued-turn path. */
export function parseSlackPiExplicitControl(text: string): SlackPiExplicitControl | null {
  const match = /^(follow up now|steer)\s*:\s*(\S[\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  return {
    action: match[1]!.toLowerCase() === "steer" ? "steer" : "follow_up",
    content: match[2]!.trim(),
  };
}

export async function slackPiControlRequestId(eventIdentity: string): Promise<string> {
  return `slack-control:${await sha256Hex(eventIdentity)}`;
}
