import { NextResponse, type NextRequest } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getServerAuthSession())?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const response = await controlPlaneUserFetch(
    `/sessions/${encodeURIComponent(id)}/retry-snapshot`,
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  );
  return NextResponse.json(await response.json(), { status: response.status });
}
