import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT } = settingsProxy(
  ({ userId }: { userId: string }) => `/members/${encodeURIComponent(userId)}/role`,
  "member role"
);
