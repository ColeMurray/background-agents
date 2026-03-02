import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

function getUserId(session: { user?: { id?: string; email?: string | null } }): string {
  const user = session.user;
  return user?.id ?? user?.email ?? "anonymous";
}

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = getUserId(session);

  const { searchParams } = new URL(request.url);
  const repoOwner = searchParams.get("repoOwner");
  const repoName = searchParams.get("repoName");

  try {
    const params = new URLSearchParams({ userId });
    if (repoOwner != null) params.set("repoOwner", repoOwner);
    if (repoName != null) params.set("repoName", repoName);
    const response = await controlPlaneFetch(`/agent-defaults?${params.toString()}`);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch agent defaults:", error);
    return NextResponse.json({ error: "Failed to fetch agent defaults" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = getUserId(session);

  try {
    const body = await request.json();
    const payload = { ...body, userId };
    const response = await controlPlaneFetch("/agent-defaults", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update agent defaults:", error);
    return NextResponse.json({ error: "Failed to update agent defaults" }, { status: 500 });
  }
}
