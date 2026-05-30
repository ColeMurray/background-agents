import { isCanonicalUserId } from "@open-inspect/shared";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

type CurrentUserResponse = {
  userId?: unknown;
};

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = session.user;
  if (!user.id) {
    return NextResponse.json({ error: "GitHub user ID is unavailable" }, { status: 409 });
  }

  try {
    const response = await controlPlaneFetch(
      `/provider-identities/github/${encodeURIComponent(user.id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          providerLogin: user.login,
          providerEmail: user.email,
          displayName: user.name || user.login,
          avatarUrl: user.image,
        }),
      }
    );

    const data = (await response.json()) as CurrentUserResponse;
    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    if (!isCanonicalUserId(data.userId)) {
      return NextResponse.json({ error: "Invalid current user response" }, { status: 502 });
    }

    return NextResponse.json({ userId: data.userId });
  } catch (error) {
    console.error("Failed to resolve current user:", error);
    return NextResponse.json({ error: "Failed to resolve current user" }, { status: 500 });
  }
}
