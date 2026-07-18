import { SESSION_DIFF_ID_PATTERN } from "@open-inspect/shared";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

/**
 * Stream one revision-pinned patch to an authenticated browser.
 * Route identities are validated before the server authenticates to the control plane.
 */
export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ id: string; revisionId: string; fileId: string }>;
  }
): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, revisionId, fileId } = await params;
  if (![id, revisionId, fileId].every((value) => SESSION_DIFF_ID_PATTERN.test(value))) {
    return NextResponse.json({ error: "Invalid diff file identity" }, { status: 400 });
  }
  try {
    const upstream = await controlPlaneFetch(`/sessions/${id}/diff/${revisionId}/files/${fileId}`);
    const headers = new Headers({
      "Content-Type":
        upstream.headers.get("Content-Type") ??
        (upstream.ok ? "text/x-diff; charset=utf-8" : "application/json"),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    });
    for (const name of ["Content-Length", "ETag"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    console.error("Failed to fetch session diff file:", error);
    return NextResponse.json({ error: "Failed to fetch diff file" }, { status: 500 });
  }
}
