import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { buildControlPlanePath } from "@/lib/control-plane-query";

const AUTOMATION_LIST_QUERY_PARAMS = [
  "search",
  "limit",
  "cursor",
  "repoOwner",
  "repoName",
] as const;

export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = buildControlPlanePath(
    "/automations",
    request.nextUrl.searchParams,
    AUTOMATION_LIST_QUERY_PARAMS
  );

  try {
    const response = await controlPlaneUserFetch(path);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch automations:", error);
    return NextResponse.json({ error: "Failed to fetch automations" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Explicitly pick allowed fields from the client body. Creator identity
    // and SCM provenance derive from authenticated control-plane state.
    const automationBody = {
      name: body.name,
      instructions: body.instructions,
      triggerType: body.triggerType,
      scheduleCron: body.scheduleCron,
      scheduleTz: body.scheduleTz,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      eventType: body.eventType,
      triggerConfig: body.triggerConfig,
      sentryClientSecret: body.sentryClientSecret,
      repositories: body.repositories,
      environmentIds: body.environmentIds,
    };

    const response = await controlPlaneUserFetch("/automations", {
      method: "POST",
      body: JSON.stringify(automationBody),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create automation:", error);
    return NextResponse.json({ error: "Failed to create automation" }, { status: 500 });
  }
}
