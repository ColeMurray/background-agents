import {
  CLI_EXTERNAL_API_V1_PATH,
  approveCliDeviceAuthorizationRequestSchema,
} from "@open-inspect/shared/types/cli-auth";
import type { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";

const APPROVAL_PATH = `${CLI_EXTERNAL_API_V1_PATH}/device-authorizations/approve`;

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getServerAuthSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  let input;
  try {
    input = approveCliDeviceAuthorizationRequestSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const response = await controlPlaneUserFetch(APPROVAL_PATH, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (response.status === 204) return new Response(null, { status: 204 });

    const error =
      response.status === 404
        ? "invalid"
        : response.status === 409
          ? "already_used"
          : response.status === 410
            ? "expired"
            : response.status === 429
              ? "rate_limited"
              : "approval_failed";
    return Response.json({ error }, { status: response.status });
  } catch {
    return Response.json({ error: "approval_unavailable" }, { status: 503 });
  }
}
