import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET() {
  if (!(await getServerAuthSession())?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const response = await controlPlaneUserFetch("/session-capabilities");
  return NextResponse.json(await response.json(), { status: response.status });
}
