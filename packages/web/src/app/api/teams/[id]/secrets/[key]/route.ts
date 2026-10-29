import { settingsProxy } from "@/lib/settings-proxy";

export const { DELETE } = settingsProxy(
  ({ id, key }: { id: string; key: string }) =>
    `/teams/${encodeURIComponent(id)}/secrets/${encodeURIComponent(key)}`,
  "team secret"
);
