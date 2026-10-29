import type { MemoryAction } from "@open-inspect/shared/types/memories";
import { settingsProxy } from "@/lib/settings-proxy";

/** The BFF route for one lifecycle action on a memory, e.g. `/api/memories/:id/approve`. */
export function memoryActionProxy(action: MemoryAction) {
  return settingsProxy(
    ({ id }: { id: string }) => `/memories/${encodeURIComponent(id)}/${action}`,
    "memory",
    { POST: `${action} memory` }
  );
}
