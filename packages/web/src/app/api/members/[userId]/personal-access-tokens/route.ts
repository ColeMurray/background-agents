import { settingsProxy } from "@/lib/settings-proxy";

export const { DELETE } = settingsProxy(
  ({ userId }: { userId: string }) =>
    `/members/${encodeURIComponent(userId)}/personal-access-tokens`,
  "member personal access tokens",
  { DELETE: "revoke member personal access tokens" }
);
