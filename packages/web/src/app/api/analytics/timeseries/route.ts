import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { buildAnalyticsTimeseriesPath } from "@/lib/analytics-query";

export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = buildAnalyticsTimeseriesPath(new URL(request.url).searchParams);

  try {
    const response = await controlPlaneUserFetch(path);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch analytics timeseries:", error);
    return NextResponse.json({ error: "Failed to fetch analytics timeseries" }, { status: 500 });
  }
}
