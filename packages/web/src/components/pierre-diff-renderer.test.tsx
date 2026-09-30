// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { areThemesAttached, isHighlighterLoaded, preloadHighlighter } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import PierreDiffRenderer from "./pierre-diff-renderer";

vi.mock("@pierre/diffs", () => ({
  areThemesAttached: vi.fn(),
  isHighlighterLoaded: vi.fn(),
  preloadHighlighter: vi.fn(),
}));
vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: vi.fn(({ patch }: { patch: string }) => (
    <div data-testid="highlighted-diff">{patch}</div>
  )),
}));

beforeEach(() => {
  vi.mocked(isHighlighterLoaded).mockReturnValue(false);
  vi.mocked(areThemesAttached).mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("PierreDiffRenderer", () => {
  it("renders on the app palette with matching line metrics and the viewer's options", async () => {
    vi.mocked(preloadHighlighter).mockResolvedValue(undefined);
    render(
      <PierreDiffRenderer patch="+review code" diffStyle="split" wrap={false} themeType="dark" />
    );

    expect(await screen.findByTestId("highlighted-diff")).toHaveTextContent("+review code");
    expect(vi.mocked(PatchDiff).mock.calls.at(-1)?.[0]).toMatchObject({
      metrics: { lineHeight: 20 },
      style: {
        "--diffs-font-size": "12px",
        "--diffs-line-height": "20px",
        "--diffs-bg": "var(--background)",
        "--diffs-addition-color-override": "var(--success)",
        "--diffs-deletion-color-override": "var(--destructive)",
      },
      options: {
        diffStyle: "split",
        overflow: "scroll",
        themeType: "dark",
        theme: { light: "github-light", dark: "github-dark" },
        disableFileHeader: true,
        hunkSeparators: "line-info",
      },
    });
  });

  it("keeps the patch readable until the highlighter and review themes load", async () => {
    let resolve!: () => void;
    vi.mocked(preloadHighlighter).mockReturnValue(new Promise<void>((done) => (resolve = done)));
    render(<PierreDiffRenderer patch="+new code" diffStyle="unified" wrap themeType="light" />);

    expect(screen.getByLabelText("Raw diff")).toHaveTextContent("+new code");
    expect(screen.queryByTestId("highlighted-diff")).not.toBeInTheDocument();
    expect(preloadHighlighter).toHaveBeenCalledWith({
      themes: ["github-light", "github-dark"],
      langs: ["text"],
    });

    await act(async () => resolve());
    expect(screen.getByTestId("highlighted-diff")).toHaveTextContent("+new code");
    expect(screen.queryByLabelText("Raw diff")).not.toBeInTheDocument();
  });

  it("keeps a readable, current patch if highlighting cannot load", async () => {
    vi.mocked(preloadHighlighter).mockRejectedValue(new Error("Unavailable"));
    const view = render(
      <PierreDiffRenderer patch="+first patch" diffStyle="unified" wrap themeType="light" />
    );
    await act(async () => {});

    view.rerender(
      <PierreDiffRenderer patch="+second patch" diffStyle="split" wrap={false} themeType="dark" />
    );
    expect(screen.getByLabelText("Raw diff")).toHaveTextContent("+second patch");
    expect(screen.queryByTestId("highlighted-diff")).not.toBeInTheDocument();
  });

  it("mounts highlighted straight away once the review themes are attached", () => {
    vi.mocked(isHighlighterLoaded).mockReturnValue(true);
    vi.mocked(areThemesAttached).mockReturnValue(true);
    render(<PierreDiffRenderer patch="+warm" diffStyle="unified" wrap themeType="light" />);

    expect(screen.getByTestId("highlighted-diff")).toHaveTextContent("+warm");
    expect(areThemesAttached).toHaveBeenCalledWith({ light: "github-light", dark: "github-dark" });
    expect(preloadHighlighter).not.toHaveBeenCalled();
  });

  it("waits for the review themes when the highlighter is loaded without them", async () => {
    vi.mocked(isHighlighterLoaded).mockReturnValue(true);
    let resolve!: () => void;
    vi.mocked(preloadHighlighter).mockReturnValue(new Promise<void>((done) => (resolve = done)));
    render(
      <PierreDiffRenderer patch="+themes loading" diffStyle="unified" wrap themeType="dark" />
    );

    expect(screen.getByLabelText("Raw diff")).toHaveTextContent("+themes loading");
    expect(preloadHighlighter).toHaveBeenCalledOnce();

    await act(async () => resolve());
    expect(screen.getByTestId("highlighted-diff")).toHaveTextContent("+themes loading");
  });
});
