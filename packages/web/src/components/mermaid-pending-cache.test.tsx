// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SafeMarkdown } from "./safe-markdown";
import { renderMermaid } from "@/lib/mermaid-renderer";

vi.mock("@/lib/mermaid-renderer", () => ({ renderMermaid: vi.fn() }));
const renderer = vi.mocked(renderMermaid);
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
afterEach(cleanup);

it("deduplicates remounts when pending work exceeds the completed-cache limit", async () => {
  const pending = new Map<string, (image: null) => void>();
  renderer.mockImplementation(
    (source: string) =>
      new Promise<null>((resolve) => {
        pending.set(source, resolve);
      })
  );
  const content = (i: number) => `\`\`\`mermaid\nflowchart LR\n A --> N${i}\n\`\`\``;
  const first = render(<SafeMarkdown content={content(0)} renderMermaid />);
  await waitFor(() => expect(renderer).toHaveBeenCalledTimes(1));
  first.unmount();
  for (let i = 1; i <= 33; i++) {
    const row = render(<SafeMarkdown content={content(i)} renderMermaid />);
    await waitFor(() => expect(renderer).toHaveBeenCalledTimes(i + 1));
    row.unmount();
  }
  // All requests remain deferred, as when the serialized renderer queue has not drained.
  render(<SafeMarkdown content={content(0)} renderMermaid />);
  await act(async () => {});
  expect(renderer).toHaveBeenCalledTimes(34);
  await act(async () => {
    for (const resolve of pending.values()) resolve(null);
  });
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
