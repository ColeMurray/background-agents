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
