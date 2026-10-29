import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { relayJsonResponse } from "@/lib/control-plane-json-proxy";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Allows the maximum selection, including JSON-escaped IDs, with bounded overhead.
const MAX_BATCH_ARCHIVE_BODY_BYTES = 48 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectMissingBrowserSessionCookie(request, {
    "Cache-Control": "private, no-store",
  });
  if (rejection) return rejection;

  let body: unknown;
  try {
    const bytes = await readBodyCapped(request.body, MAX_BATCH_ARCHIVE_BODY_BYTES);
    if (bytes === null) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  try {
    const response = await controlPlaneUserFetch("/sessions/batch-archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await relayJsonResponse(response);
  } catch (error) {
    console.error("Session batch archive error:", error);
    return NextResponse.json({ error: "Failed to archive sessions" }, { status: 500 });
  }
}
