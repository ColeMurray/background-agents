import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import type { SlackChannelListing } from "@open-inspect/shared";

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
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneFetch("/integration-settings/slack/channels");
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
