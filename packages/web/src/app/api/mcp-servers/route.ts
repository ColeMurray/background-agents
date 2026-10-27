import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(request: NextRequest) {
  try {
    const repo = request.nextUrl.searchParams.get("repo");
    const path = repo ? `/mcp-servers?repo=${encodeURIComponent(repo)}` : "/mcp-servers";
    const response = await controlPlaneUserFetch(path);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch MCP servers:", error);
    return NextResponse.json({ error: "Failed to fetch MCP servers" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const rejection = rejectMissingBrowserSessionCookie(request);
  if (rejection) return rejection;

  try {
    const body = await request.json();
    const response = await controlPlaneUserFetch("/mcp-servers", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create MCP server:", error);
    return NextResponse.json({ error: "Failed to create MCP server" }, { status: 500 });
  }
}
