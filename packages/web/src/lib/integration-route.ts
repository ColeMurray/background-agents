import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { getServerScmProvider } from "@/lib/scm-provider";

export async function requireIntegrationAccess(id: string): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (id === "github" && getServerScmProvider() !== "github") {
    return NextResponse.json({ error: "Integration not available" }, { status: 404 });
  }

  return null;
}

export async function proxyIntegrationRequest(
  id: string,
  path: string,
  failureMessage: string,
  init?: RequestInit
): Promise<NextResponse> {
  const accessError = await requireIntegrationAccess(id);
  if (accessError) {
    return accessError;
  }

  try {
    const response = await controlPlaneFetch(path, init);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error(`${failureMessage}:`, error);
    return NextResponse.json({ error: failureMessage }, { status: 500 });
  }
}
