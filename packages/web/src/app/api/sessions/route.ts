import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const queryString = searchParams.toString();
  const path = queryString ? `/sessions?${queryString}` : "/sessions";

  try {
    const response = await controlPlaneFetch(path);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to fetch sessions:", message, error);
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
    const provider =
      (jwt?.provider as "github" | "bitbucket" | undefined) ?? session.provider ?? "github";
    const user = session.user;
    const userId = user?.id || user?.email || "anonymous";

    const sessionBody: Record<string, unknown> = {
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      title: body.title,
      userId,
      vcsProvider: provider,
    };

    if (provider === "bitbucket") {
      sessionBody.bitbucketToken = accessToken;
      sessionBody.bitbucketUuid = user?.id;
      sessionBody.bitbucketLogin = user?.login;
      sessionBody.bitbucketDisplayName = user?.name;
      sessionBody.bitbucketEmail = user?.email;
    } else {
      sessionBody.githubToken = accessToken;
      sessionBody.githubLogin = user?.login;
      sessionBody.githubName = user?.name;
      sessionBody.githubEmail = user?.email;
    }

    const response = await controlPlaneFetch("/sessions", {
      method: "POST",
      body: JSON.stringify(sessionBody),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Control plane error creating session:", {
        status: response.status,
        data,
        provider,
        repoOwner: body.repoOwner,
        repoName: body.repoName,
      });
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to create session:", message, error);
    return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
  }
}
