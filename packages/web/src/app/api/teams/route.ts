import { NextResponse, type NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PRIVATE_NO_STORE_HEADERS, relayJsonResponse } from "@/lib/control-plane-json-proxy";
import { settingsProxy } from "@/lib/settings-proxy";

export async function GET(_request: NextRequest) {
  try {
    const response = await controlPlaneUserFetch("/teams?membership=all&includeArchived=true");
    return relayJsonResponse(
      response.status === 403 ? await controlPlaneUserFetch("/me/teams") : response
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch teams" },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
}

export const { POST } = settingsProxy(() => "/teams", "teams");
