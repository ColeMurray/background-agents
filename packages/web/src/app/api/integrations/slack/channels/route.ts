import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { controlPlaneSlackChannelsResponseSchema } from "@open-inspect/shared/slack";

/**
 * List Slack channels for the automation channel picker. Proxies to the control
 * plane (which holds the bot token). Authentication failures stay 401; other
 * failures return a `channels` array so the picker degrades to manual ID entry.
 */
export async function GET() {
  try {
    const response = await controlPlaneUserFetch("/integration-settings/slack/channels");
    if (response.status === 401) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!response.ok) {
      const error = await response.text();
      console.error("Control plane slack channels error:", error);
      return NextResponse.json({ channels: [], error: "fetch_failed" });
    }
    const parsed = controlPlaneSlackChannelsResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid control plane Slack channels response");
    return NextResponse.json({ channels: parsed.data.channels, error: parsed.data.error });
  } catch (error) {
    console.error("Error fetching slack channels:", error);
    return NextResponse.json({ channels: [], error: "fetch_failed" });
  }
}
