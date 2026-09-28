import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

const EXPORT_PARAMETERS = new Set([
  "limit",
  "cursor",
  "createdAfter",
  "createdBefore",
  "scope",
  "include",
  "format",
]);

export async function GET(request: Request): Promise<Response> {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const searchParams = new URLSearchParams();
  for (const [key, value] of new URL(request.url).searchParams) {
    if (EXPORT_PARAMETERS.has(key)) searchParams.append(key, value);
  }
  const query = searchParams.size ? `?${searchParams}` : "";
  try {
    const upstream = await controlPlaneUserFetch(
      `/sessions/export${query}`,
      { signal: request.signal },
      { streamResponse: true }
    );
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "private, no-store",
        Vary: "Cookie",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to export sessions" },
      { status: 502, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
