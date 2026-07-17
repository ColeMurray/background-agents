// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDiffRepository } from "@open-inspect/shared";
import { FilesChangedSection } from "./files-changed-section";

afterEach(cleanup);

const repositories: SessionDiffRepository[] = [
  {
    position: 0,
    repoOwner: "acme",
    repoName: "web",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    capturedAt: 100,
    status: "ready",
    sourceCaptureId: "capture-1",
    truncated: false,
    omittedFileCount: 0,
    files: [
      {
        id: "file-1",
        path: "packages/web/index.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        renderState: "renderable",
        patchBytes: 100,
      },
      {
        id: "file-2",
        path: "packages/api/index.ts",
        status: "modified",
        additions: null,
        deletions: null,
        renderState: "binary",
      },
    ],
  },
];

describe("FilesChangedSection", () => {
  it("uses canonical files, disambiguates labels, and selects an accessible row", async () => {
    const onSelect = vi.fn();
    render(<FilesChangedSection repositories={repositories} onSelect={onSelect} />);

    expect(
      screen.getByRole("button", { name: /web\/index\.ts.*modified.*\+2.*-1/i })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /api\/index\.ts.*modified.*binary/i })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /web\/index\.ts/i }));
    expect(onSelect).toHaveBeenCalledWith(repositories[0], repositories[0]!.files[0]);
  });

  it("filters the changed-file tree by path", async () => {
    render(<FilesChangedSection repositories={repositories} onSelect={vi.fn()} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter changed files" }), "api/");

    expect(screen.queryByRole("button", { name: /web\/index\.ts/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /api\/index\.ts/i })).toBeVisible();
  });
});
