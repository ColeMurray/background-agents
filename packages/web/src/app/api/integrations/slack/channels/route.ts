import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import type { SlackChannelListing } from "@open-inspect/shared/slack";

interface ControlPlaneChannelsResponse {
  channels: SlackChannelListing[];
  error?: string;
}

/**
 * List Slack channels for the automation channel picker. Proxies to the control
 * plane (which holds the bot token) and always responds 200 with a `channels`
 * array so the picker degrades to manual channel-ID entry on any failure.
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneUserFetch("/integration-settings/slack/channels");
    if (!response.ok) {
      const error = await response.text();
      console.error("Control plane slack channels error:", error);
      return NextResponse.json({ channels: [], error: "fetch_failed" });
    }
    const data: ControlPlaneChannelsResponse = await response.json();
    return NextResponse.json({ channels: data.channels ?? [], error: data.error });
  } catch (error) {
    console.error("Error fetching slack channels:", error);
    return NextResponse.json({ channels: [], error: "fetch_failed" });
  }
}
