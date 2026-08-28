import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

/**
 * Relay a control-plane response without assuming it carries JSON.
 *
 * Parsing before checking would turn an empty or non-JSON upstream reply — a
 * transport-level 401, a gateway error — into a 500 here, losing the status
 * the caller needs to act on.
 */
async function forward(response: Response): Promise<NextResponse> {
  const text = await response.text();
  if (!text) return new NextResponse(null, { status: response.status });
  try {
    return NextResponse.json(JSON.parse(text), { status: response.status });
  } catch {
    return NextResponse.json(
      { error: "Unexpected response from control plane" },
      { status: response.status >= 400 ? response.status : 502 }
    );
  }
}

export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return await forward(await controlPlaneUserFetch("/access-tokens"));
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
    const response = await controlPlaneUserFetch("/access-tokens", {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Carries the plaintext token. Relayed without logging, and marked
    // uncacheable so no intermediary or browser cache retains it.
    const relayed = await forward(response);
    relayed.headers.set("Cache-Control", "private, no-store");
    return relayed;
  } catch (error) {
    console.error("Failed to create access token:", error);
    return NextResponse.json({ error: "Failed to create access token" }, { status: 500 });
  }
}
