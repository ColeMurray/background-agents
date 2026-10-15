// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { OpencodePluginReport } from "@open-inspect/shared/types/sandbox-events";
import { OpencodePluginsSection } from "./opencode-plugins-section";
expect.extend(matchers);
afterEach(cleanup);
it("shows the latest boot's loaded and skipped plugins", async () => {
  const report: OpencodePluginReport = {
    type: "opencode_plugins",
    sandboxId: "new",
    timestamp: 2,
    plugins: [
      { spec: "audit@1.0.0", status: "loaded" },
      { spec: "broken@1.0.0", status: "skipped" },
    ],
  };
  render(<OpencodePluginsSection report={report} />);
  await userEvent.setup().click(screen.getByText("OpenCode plugins (1 loaded)"));
  expect(screen.getByText("audit@1.0.0")).toBeInTheDocument();
  expect(screen.getByText("Skipped — see session warnings")).toBeInTheDocument();
});
it("clears a previous boot's plugin list when none are configured", () => {
  const { container } = render(
    <OpencodePluginsSection
      report={{ type: "opencode_plugins", sandboxId: "new", timestamp: 2, plugins: [] }}
    />
  );
  expect(container).toBeEmptyDOMElement();
});
it("renders nothing before the current sandbox has reported", () => {
  const { container } = render(<OpencodePluginsSection report={null} />);
  expect(container).toBeEmptyDOMElement();
});
