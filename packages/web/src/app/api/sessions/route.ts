import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { buildAuthDisplay } from "@/lib/build-auth-identity";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import {
  buildControlPlanePath,
  SESSION_CONTROL_PLANE_QUERY_PARAMS,
} from "@/lib/control-plane-query";
import { CURRENT_USER_CREATED_BY } from "@/lib/session-list";

export async function GET(request: NextRequest) {
  const routeStart = Date.now();

  const session = await getServerAuthSession();
  const authMs = Date.now() - routeStart;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const searchParams = new URLSearchParams(request.nextUrl.searchParams);

    const createdByValues = searchParams.getAll("createdBy");
    if (createdByValues.includes(CURRENT_USER_CREATED_BY)) {
      searchParams.delete("createdBy");
      for (const value of createdByValues) {
        searchParams.append(
          "createdBy",
          value === CURRENT_USER_CREATED_BY ? session.user.id : value
        );
      }
    }

    const path = buildControlPlanePath(
      "/sessions",
      searchParams,
      SESSION_CONTROL_PLANE_QUERY_PARAMS
    );

    const fetchStart = Date.now();
    const response = await controlPlaneUserFetch(path);
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
  const session = await getServerAuthSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Explicitly pick allowed fields from the client body. Identity and SCM
    // provenance derive from authenticated control-plane state.
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
      ...buildAuthDisplay(user),
    };

    const response = await controlPlaneUserFetch("/sessions", {
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
