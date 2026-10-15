import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { relayJsonResponse } from "@/lib/control-plane-json-proxy";
import {
  sessionInboxMarkReadRequestSchema,
  type SessionInboxMarkReadRequest,
} from "@open-inspect/shared/types/session-inbox";

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
