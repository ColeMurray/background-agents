import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, name } = await params;

  try {
    const body = await request.json();
    const response = await controlPlaneFetch(
      `/scm-settings/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update SCM repo settings:", error);
    return NextResponse.json({ error: "Failed to update SCM repo settings" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, name } = await params;

  try {
    const response = await controlPlaneFetch(
      `/scm-settings/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
      }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to delete SCM repo settings:", error);
    return NextResponse.json({ error: "Failed to delete SCM repo settings" }, { status: 500 });
  }
}
