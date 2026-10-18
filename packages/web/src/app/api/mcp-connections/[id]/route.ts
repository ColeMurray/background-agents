import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(`/mcp-connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    console.error("Failed to remove dormant personal MCP connection:", error);
    return NextResponse.json(
      { error: "Failed to remove personal MCP connection" },
      { status: 500 }
    );
  }
}
