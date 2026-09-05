import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { controlPlaneSlackChannelsResponseSchema } from "@open-inspect/shared/slack";

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
    const parsed = controlPlaneSlackChannelsResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid control plane Slack channels response");
    return NextResponse.json({ channels: parsed.data.channels, error: parsed.data.error });
  } catch (error) {
    console.error("Error fetching slack channels:", error);
    return NextResponse.json({ channels: [], error: "fetch_failed" });
  }
}
