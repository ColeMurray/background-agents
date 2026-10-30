import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  (_params, request) => `/settings/personal-access-tokens${request.nextUrl.search}`,
  "workspace personal access tokens"
);
