import { type NextRequest, NextResponse } from "next/server";
import { hasBrowserSessionCookie } from "@/lib/browser-session-cookie";

/** Reject missing credentials before buffering a body; supplied cookies are validated upstream. */
export function rejectMissingBrowserSessionCookie(
  request: NextRequest,
  headers?: HeadersInit
): NextResponse | null {
  if (hasBrowserSessionCookie(request.cookies.getAll())) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
}
