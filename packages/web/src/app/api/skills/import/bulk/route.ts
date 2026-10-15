import { settingsProxy } from "@/lib/settings-proxy";
import { BULK_SKILL_IMPORT_TIMEOUT_MS } from "./request-timeout";

export const { POST } = settingsProxy(
  () => "/skills/import/bulk",
  "bulk import skills",
  {},
  {
    timeoutMs: BULK_SKILL_IMPORT_TIMEOUT_MS,
  }
);
