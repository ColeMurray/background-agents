// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SafeMarkdown } from "./safe-markdown";

const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mermaid-renderer", () => {
  load();
  throw new Error("diagram chunk unavailable");
});
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
afterEach(cleanup);

it("loads no renderer for partial fences and keeps source when the lazy chunk fails", async () => {
  const content = "```mermaid\nflowchart LR\n Import --> Failed\n";
  const { container, rerender } = render(<SafeMarkdown content={content} renderMermaid />);
  await act(async () => {});
  expect(load).not.toHaveBeenCalled();
  rerender(<SafeMarkdown content={content + "```\n\nStill readable."} renderMermaid />);
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(container.querySelector("pre")).toHaveTextContent("Import --> Failed");
  expect(screen.getByText("Still readable.")).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
