import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getRequestScmTokenState } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, name } = await params;

  try {
    const { accessToken } = await getRequestScmTokenState(_request);
    const response = await controlPlaneFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`,
      {
        headers: accessToken
          ? {
              "x-scm-token": accessToken,
            }
          : undefined,
      }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch branches:", error);
    return NextResponse.json({ error: "Failed to fetch branches" }, { status: 500 });
  }
}
