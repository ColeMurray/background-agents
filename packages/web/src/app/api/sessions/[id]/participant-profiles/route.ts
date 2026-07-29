import { SESSION_DIFF_ID_PATTERN } from "@open-inspect/shared";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!SESSION_DIFF_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  try {
    const upstream = await controlPlaneUserFetch(`/sessions/${id}/participant-profiles`);
    const headers = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    console.error("Failed to fetch participant profiles:", error);
    return NextResponse.json({ error: "Failed to fetch participant profiles" }, { status: 500 });
  }
}
