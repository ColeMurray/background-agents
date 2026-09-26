import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!SESSION_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  const searchParams = new URLSearchParams();
  for (const [key, value] of new URL(request.url).searchParams) {
    if (key === "scope" || key === "include" || key === "format") searchParams.append(key, value);
  }
  const query = searchParams.size ? `?${searchParams}` : "";
  try {
    const upstream = await controlPlaneUserFetch(`/sessions/${id}/export${query}`);
    const headers = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });
    if (upstream.ok) {
      headers.set("Content-Disposition", `attachment; filename="session-${id}.ndjson"`);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return NextResponse.json({ error: "Failed to download session trace" }, { status: 502 });
  }
}
