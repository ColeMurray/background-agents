import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildAuthDisplay, buildScmAttribution } from "@/lib/build-auth-identity";
import { controlPlaneFetch } from "@/lib/control-plane";
import { buildControlPlanePath } from "@/lib/control-plane-query";

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = buildControlPlanePath("/automations", request.nextUrl.searchParams);

  try {
    const response = await controlPlaneFetch(path);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch automations:", error);
    return NextResponse.json({ error: "Failed to fetch automations" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Explicitly pick allowed fields from the client body (the same pattern
    // as the sessions route). Creator identity is derived by the control
    // plane from the Bearer principal and rejected in the body — send only
    // the automation definition plus the display/attribution blocks: auth*
    // display for BOTH GitHub and Google, while the GitHub-only scm*
    // attribution block is empty for Google — so a Google sub never reaches
    // the SCM path (F1/F2).
    const user = session.user;

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
      ...buildAuthDisplay(user),
      ...buildScmAttribution(user),
    };

    const response = await controlPlaneFetch("/automations", {
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
