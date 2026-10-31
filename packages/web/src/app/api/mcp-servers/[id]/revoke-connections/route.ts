import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PRIVATE_NO_STORE_HEADERS, relayJsonResponse } from "@/lib/control-plane-json-proxy";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }

  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(
      `/mcp-servers/${encodeURIComponent(id)}/revoke-connections`,
      { method: "POST" }
    );
    return await relayJsonResponse(response);
  } catch (error) {
    console.error("Failed to revoke MCP connections:", error);
    return NextResponse.json(
      { error: "Failed to revoke MCP connections" },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
}
