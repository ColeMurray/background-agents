import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { relayJsonResponse } from "@/lib/control-plane-json-proxy";

export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // The shared relay marks every response `private, no-store`. A listing
    // names a user's credentials and when each was last used, so that is
    // required here rather than merely tidy.
    return await relayJsonResponse(await controlPlaneUserFetch("/access-tokens"));
  } catch (error) {
    console.error("Failed to fetch access tokens:", error);
    return NextResponse.json({ error: "Failed to fetch access tokens" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    // Carries the plaintext token: relayed without logging, and uncacheable
    // by the same relay, so nothing between here and the browser retains it.
    return await relayJsonResponse(
      await controlPlaneUserFetch("/access-tokens", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  } catch (error) {
    console.error("Failed to create access token:", error);
    return NextResponse.json({ error: "Failed to create access token" }, { status: 500 });
  }
}
