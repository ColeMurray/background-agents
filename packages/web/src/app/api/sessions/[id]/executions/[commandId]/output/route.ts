import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; commandId: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, commandId } = await params;
  const response = await controlPlaneUserFetch(
    `/sessions/${encodeURIComponent(id)}/executions/${encodeURIComponent(commandId)}/output${request.nextUrl.search}`
  );
  return NextResponse.json(await response.json(), {
    status: response.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
