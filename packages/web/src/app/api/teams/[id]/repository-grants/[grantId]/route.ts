import { settingsProxy } from "@/lib/settings-proxy";

export const { DELETE } = settingsProxy(
  ({ id, grantId }: { id: string; grantId: string }) =>
    `/teams/${encodeURIComponent(id)}/repository-grants/${encodeURIComponent(grantId)}`,
  "team repository grant"
);
