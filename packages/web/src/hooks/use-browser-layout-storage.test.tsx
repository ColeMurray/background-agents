import { renderToString } from "react-dom/server";
import { useDefaultLayout } from "react-resizable-panels";
import { describe, expect, it } from "vitest";
import { useBrowserLayoutStorage } from "./use-browser-layout-storage";

function LayoutProbe() {
  const storage = useBrowserLayoutStorage();
  useDefaultLayout({ id: "ssr-layout-probe", panelIds: ["main"], storage });
  return null;
}

describe("useBrowserLayoutStorage", () => {
  it("provides explicit storage when a panel layout renders on the server", () => {
    expect(() => renderToString(<LayoutProbe />)).not.toThrow();
  });
});
