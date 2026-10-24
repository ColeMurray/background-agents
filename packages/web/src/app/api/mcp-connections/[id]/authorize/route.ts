import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  try {
    const response = await controlPlaneUserFetch(
      `/mcp-connections/${encodeURIComponent(id)}/authorize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    console.error("Failed to authorize personal MCP connection:", error);
    return NextResponse.json({ error: "Failed to start the MCP authorization" }, { status: 500 });
  }
}
