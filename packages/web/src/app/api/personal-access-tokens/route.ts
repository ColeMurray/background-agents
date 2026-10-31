import { settingsProxy } from "@/lib/settings-proxy";

// Relayed `private, no-store`: the issue response carries the plaintext token, once.
export const { GET, POST } = settingsProxy(
  () => "/personal-access-tokens",
  "personal access tokens",
  { POST: "issue personal access token" }
);
