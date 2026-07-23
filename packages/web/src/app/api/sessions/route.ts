import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildAuthDisplay, buildScmAttribution } from "@/lib/build-auth-identity";
import { controlPlaneFetch } from "@/lib/control-plane";
import {
  buildControlPlanePath,
  SESSION_CONTROL_PLANE_QUERY_PARAMS,
} from "@/lib/control-plane-query";
import { resolveCurrentUserId } from "@/lib/current-user";
import { CURRENT_USER_CREATED_BY } from "@/lib/session-list";

export async function GET(request: NextRequest) {
  const routeStart = Date.now();

  const session = await getServerSession(authOptions);
  const authMs = Date.now() - routeStart;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const searchParams = new URLSearchParams(request.nextUrl.searchParams);

    const createdByValues = searchParams.getAll("createdBy");
    if (createdByValues.includes(CURRENT_USER_CREATED_BY)) {
      const resolved = await resolveCurrentUserId(session.user);
      if (!resolved.ok) {
        return NextResponse.json(resolved.body, { status: resolved.status });
      }

      searchParams.delete("createdBy");
      for (const value of createdByValues) {
        searchParams.append(
          "createdBy",
          value === CURRENT_USER_CREATED_BY ? resolved.userId : value
        );
      }
    }

    const path = buildControlPlanePath(
      "/sessions",
      searchParams,
      SESSION_CONTROL_PLANE_QUERY_PARAMS
    );

    const fetchStart = Date.now();
    const response = await controlPlaneFetch(path);
    const fetchMs = Date.now() - fetchStart;
    const data = await response.json();
    const totalMs = Date.now() - routeStart;

    console.log(
      `[sessions:GET] total=${totalMs}ms auth=${authMs}ms fetch=${fetchMs}ms status=${response.status}`
    );

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch sessions:", error);
    return NextResponse.json({ error: "Failed to fetch sessions" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Explicitly pick allowed fields from the client body. Identity
    // (userId/spawnSource/authProvider/authUserId/SCM credentials) is derived
    // by the control plane from the authenticated Bearer principal and is
    // rejected in the body under strict enforcement — send only the
    // display/attribution blocks, which stay body-carried by design.
    const user = session.user;

    const sessionBody = {
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      branch: body.branch,
      title: body.title,
      // The picker's other two target modes (mutually exclusive with the
      // scalar fields — enforced by createSessionRequestSchema control-plane
      // side): a named environment or an ad-hoc repository list.
      environmentId: body.environmentId,
      repositories: body.repositories,
      // Display-only auth block (GitHub or Google); GitHub-only scm*
      // attribution is empty for Google.
      ...buildAuthDisplay(user),
      ...buildScmAttribution(user),
    };

    const response = await controlPlaneFetch("/sessions", {
      method: "POST",
      body: JSON.stringify(sessionBody),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create session:", error);
    return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
  }
}
