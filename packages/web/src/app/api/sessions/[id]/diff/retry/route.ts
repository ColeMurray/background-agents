import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!SESSION_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }
  try {
    const upstream = await controlPlaneFetch(`/sessions/${id}/diff/retry`, { method: "POST" });
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
