import { externalApiErrorResponseSchema } from "@open-inspect/shared/types/external-session-api";

const FAILURE_BY_STATUS: Record<number, { status: number; error: string; code: string }> = {
  400: { status: 400, error: "Invalid session runtime request", code: "runtime_bad_request" },
  404: { status: 404, error: "Session runtime not found", code: "runtime_not_found" },
  409: { status: 409, error: "Session runtime conflict", code: "runtime_conflict" },
  410: {
    status: 410,
    error: "Event checkpoint expired",
    code: "event_checkpoint_expired",
  },
  429: { status: 429, error: "Session runtime is busy", code: "runtime_busy" },
};

/** Maps an internal runtime failure without inspecting or forwarding its body. */
export function adaptExternalRuntimeFailure(response: Response): Response | null {
  if (response.ok) return null;
  const failure =
    FAILURE_BY_STATUS[response.status] ??
    (response.status >= 500
      ? { status: 503, error: "Session runtime unavailable", code: "runtime_unavailable" }
      : { status: 502, error: "Session runtime request failed", code: "runtime_error" });
  return Response.json(
    externalApiErrorResponseSchema.parse({ error: failure.error, code: failure.code }),
    { status: failure.status }
  );
}
