import type { NextRequest } from "next/server";
import { buildControlPlanePath } from "@/lib/control-plane-query";
import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  (_params: Record<string, never>, request: NextRequest) =>
    buildControlPlanePath("/audit-events", new URL(request.url).searchParams, ["limit", "cursor"]),
  "audit events"
);
