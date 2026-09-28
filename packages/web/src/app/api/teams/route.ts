import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, POST } = settingsProxy(
  (_, request) =>
    request.method === "GET" ? "/teams?membership=all&includeArchived=true" : "/teams",
  "teams"
);
