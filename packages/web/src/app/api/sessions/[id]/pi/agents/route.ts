import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PRIVATE_NO_STORE_HEADERS, relayJsonResponse } from "@/lib/control-plane-json-proxy";
import { piAgentsEnvelopeSchema } from "@/lib/pi-agents";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const upstream = await controlPlaneUserFetch(
      `/sessions/${encodeURIComponent(id)}/pi/agents?requestId=${encodeURIComponent(crypto.randomUUID())}`
    );
    if (!upstream.ok) return relayJsonResponse(upstream);
    const parsed = piAgentsEnvelopeSchema.safeParse(await upstream.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid Pi agents response" },
        { status: 502, headers: PRIVATE_NO_STORE_HEADERS }
      );
    }
    return NextResponse.json(parsed.data, { headers: PRIVATE_NO_STORE_HEADERS });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch Pi agents" },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
}
