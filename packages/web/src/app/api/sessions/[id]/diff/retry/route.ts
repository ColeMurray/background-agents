import { SESSION_DIFF_ID_PATTERN } from "@open-inspect/shared/types/session-diffs";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

/** Request a best-effort diff refresh after verifying the browser session. */
export async function POST(
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
    const upstream = await controlPlaneUserFetch(`/sessions/${id}/diff/retry`, { method: "POST" });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "private, no-store",
        Vary: "Cookie",
      },
    });
  } catch (error) {
    console.error("Failed to retry session changes:", error);
    return NextResponse.json({ error: "Failed to retry session changes" }, { status: 500 });
  }
}
