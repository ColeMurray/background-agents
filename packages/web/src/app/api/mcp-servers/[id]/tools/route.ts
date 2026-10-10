import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { relayJsonResponse } from "@/lib/control-plane-json-proxy";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(`/mcp-servers/${encodeURIComponent(id)}/tools`, {
      method: "POST",
    });
    return relayJsonResponse(response);
  } catch (error) {
    console.error("Failed to load MCP server tools:", error);
    return NextResponse.json({ error: "Failed to load MCP server tools" }, { status: 500 });
  }
}
