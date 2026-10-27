import { controlPlaneUserFetch } from "@/lib/control-plane";

function hasSandboxUnavailableError(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "error" in value &&
    value.error === "Sandbox access is unavailable"
  );
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Only an explicit connect may cost the session owner their personal memory.
  const connect = new URL(request.url).searchParams.get("connect") === "1";
  const response = await controlPlaneUserFetch(
    `/sessions/${encodeURIComponent(id)}/sandbox-access${connect ? "?connect=1" : ""}`,
    { cache: "no-store" }
  );
  const conflict =
    response.status === 409
      ? await response
          .clone()
          .json()
          .catch(() => null)
      : null;
  if (hasSandboxUnavailableError(conflict)) {
    await response.body?.cancel();
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
    });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    },
  });
}
