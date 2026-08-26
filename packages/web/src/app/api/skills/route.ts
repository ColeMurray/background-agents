import { settingsProxy } from "@/lib/settings-proxy";
import { buildControlPlanePath } from "@/lib/control-plane-query";

export const { GET, POST } = settingsProxy(
  (_params, request) =>
    buildControlPlanePath("/skills", request.nextUrl.searchParams, ["limit", "cursor"]),
  "skills"
);
