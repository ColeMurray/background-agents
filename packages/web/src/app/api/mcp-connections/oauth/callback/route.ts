import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(request: NextRequest) {
  const destination = new URL("/settings?tab=mcp-connections", request.url);
  const params = request.nextUrl.searchParams;
  let connected = false;
  try {
    const code = params.get("code"),
      state = params.get("state"),
      iss = params.get("iss");
    if (code && state && !params.has("error")) {
      const response = await controlPlaneUserFetch("/mcp-connections/oauth/callback", {
        method: "POST",
        body: JSON.stringify({ code, state, ...(iss ? { iss } : {}) }),
      });
      connected = response.ok;
    }
  } catch {
    /* Never log authorization codes, state, or provider error descriptions. */
  }
  destination.searchParams.set("mcp", connected ? "connected" : "reconnect_required");
  return NextResponse.redirect(destination, {
    status: 303,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
