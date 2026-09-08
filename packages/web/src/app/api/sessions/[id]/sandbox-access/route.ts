import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }
    );
  }

  const { id } = await params;
  const response = await controlPlaneUserFetch(
    `/sessions/${encodeURIComponent(id)}/sandbox-access`,
    { cache: "no-store" }
  );
  const conflict =
    response.status === 409
      ? ((await response
          .clone()
          .json()
          .catch(() => null)) as { error?: unknown } | null)
      : null;
  if (conflict?.error === "Sandbox access is unavailable") {
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
