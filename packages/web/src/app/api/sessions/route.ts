import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import {
  buildControlPlanePath,
  SESSION_CONTROL_PLANE_QUERY_PARAMS,
} from "@/lib/control-plane-query";
import { resolveCurrentUserId } from "@/lib/current-user";

const SESSION_SCOPES = new Set(["all", "mine"]);

export async function GET(request: NextRequest) {
  const routeStart = Date.now();

  const session = await getServerSession(authOptions);
  const authMs = Date.now() - routeStart;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const searchParams = new URLSearchParams(request.nextUrl.searchParams);
    const scopes = searchParams.getAll("scope");
    const scope = scopes[0] ?? null;

    if (scopes.length > 1 || (scope !== null && !SESSION_SCOPES.has(scope))) {
      return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
    }

    if (scope === "mine") {
      if (searchParams.has("createdBy")) {
        return NextResponse.json(
          { error: "scope=mine cannot be combined with createdBy" },
          { status: 400 }
        );
      }

      const resolved = await resolveCurrentUserId(session.user);
      if (!resolved.ok) {
        return NextResponse.json(resolved.body, { status: resolved.status });
      }

      searchParams.append("createdBy", resolved.userId);
    }

    searchParams.delete("scope");
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

    const jwt = await getToken({ req: request });
    const accessToken = jwt?.accessToken as string | undefined;

    // Explicitly pick allowed fields from client body and derive identity
    // from the server-side NextAuth session (not client-supplied data)
    const user = session.user;
    const userId = user.id || user.email || "anonymous";

    const sessionBody = {
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      branch: body.branch,
      title: body.title,
      spawnSource: "user" as const,
      scmToken: accessToken,
      scmRefreshToken: jwt?.refreshToken as string | undefined,
      scmTokenExpiresAt: jwt?.accessTokenExpiresAt as number | undefined,
      scmUserId: user.id,
      userId,
      scmLogin: user.login,
      scmName: user.name,
      scmEmail: user.email,
      scmAvatarUrl: user.image,
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
