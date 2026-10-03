import type { MemoryAction } from "@open-inspect/shared/types/memories";
import { settingsProxy } from "@/lib/settings-proxy";

const action: MemoryAction = "restore";

export const { POST } = settingsProxy(
  ({ id }: { id: string }) => `/memories/${encodeURIComponent(id)}/${action}`,
  "memories"
);
