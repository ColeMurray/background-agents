import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const response = await controlPlaneUserFetch(
    `/automations/${encodeURIComponent(id)}/external-action-grants`
  );
  return NextResponse.json(await response.json(), {
    status: response.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.text();
  const response = await controlPlaneUserFetch(
    `/automations/${encodeURIComponent(id)}/external-action-grants`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }
  );
  return NextResponse.json(await response.json(), {
    status: response.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
