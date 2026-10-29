import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, POST } = settingsProxy(
  (_params, request) => `/memories${request.nextUrl.search}`,
  "memories",
  { POST: "create memory" }
);
