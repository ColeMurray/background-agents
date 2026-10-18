import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const response = await controlPlaneUserFetch("/mcp-connections");
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    console.error("Failed to fetch personal MCP connections:", error);
    return NextResponse.json(
      { error: "Failed to fetch personal MCP connections" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const response = await controlPlaneUserFetch("/mcp-connections", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    console.error("Failed to stage personal MCP connection:", error);
    return NextResponse.json({ error: "Failed to stage personal MCP connection" }, { status: 500 });
  }
}
