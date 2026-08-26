import { buildControlPlanePath } from "@/lib/control-plane-query";
import { settingsProxy } from "@/lib/settings-proxy";

const FILTERS = ["provider", "status", "archived"] as const;

export const { GET, POST } = settingsProxy(
  (_params, request) =>
    buildControlPlanePath("/model-provider-accounts", request.nextUrl.searchParams, FILTERS),
  "provider accounts"
);
