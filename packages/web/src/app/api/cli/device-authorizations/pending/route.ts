import {
  CLI_EXTERNAL_API_V1_PATH,
  approveCliDeviceAuthorizationRequestSchema,
  pendingCliDeviceAuthorizationResponseSchema,
} from "@open-inspect/shared/types/cli-auth";
import type { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";

const PENDING_PATH = `${CLI_EXTERNAL_API_V1_PATH}/device-authorizations/pending`;

export async function GET(request: NextRequest): Promise<Response> {
  const session = await getServerAuthSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = approveCliDeviceAuthorizationRequestSchema.safeParse({
    userCode: request.nextUrl.searchParams.get("user_code") ?? "",
  });
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  try {
    const response = await controlPlaneUserFetch(
      `${PENDING_PATH}?user_code=${encodeURIComponent(parsed.data.userCode)}`
    );
    if (!response.ok) {
      const error =
        response.status === 404
          ? "invalid"
          : response.status === 409
            ? "already_used"
            : response.status === 410
              ? "expired"
              : response.status === 429
                ? "rate_limited"
                : "lookup_failed";
      return Response.json({ error }, { status: response.status });
    }
    const pending = pendingCliDeviceAuthorizationResponseSchema.parse(await response.json());
    return Response.json(pending, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "lookup_unavailable" }, { status: 503 });
  }
}
