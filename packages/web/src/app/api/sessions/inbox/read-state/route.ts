import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { relayJsonResponse } from "@/lib/control-plane-json-proxy";
import {
  sessionInboxMarkReadRequestSchema,
  type SessionInboxMarkReadRequest,
} from "@open-inspect/shared/types/session-inbox";

/**
 * A cross-origin page can send a credentialed `text/plain` POST without a
 * preflight, and `{}` is a valid body, so require a same-origin JSON request.
 */
function isSameOriginJsonRequest(request: NextRequest): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  // Behind a proxy the request URL may carry an internal host; browsers
  // cannot forge Host or X-Forwarded-Host.
  return [
    new URL(request.url).host,
    request.headers.get("host"),
    request.headers.get("x-forwarded-host"),
  ].includes(originHost);
}

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isSameOriginJsonRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: SessionInboxMarkReadRequest | null;
  try {
    const parsedBody = sessionInboxMarkReadRequestSchema.safeParse(await request.json());
    body = parsedBody.success ? parsedBody.data : null;
  } catch {
    body = null;
  }
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const response = await controlPlaneUserFetch("/sessions/inbox/read-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await relayJsonResponse(response);
  } catch (error) {
    console.error("Mark session inbox read error:", error);
    return NextResponse.json({ error: "Failed to mark sessions as read" }, { status: 500 });
  }
}
