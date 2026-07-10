// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import type { ImageBuildsFeed } from "@/lib/image-builds";
import { IMAGE_BUILDS_KEY } from "@/lib/image-builds";
import { ImagesSettings } from "./images-settings";

expect.extend(matchers);

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: [
      {
        id: 1,
        fullName: "acme/web",
        owner: "acme",
        name: "web",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ],
    loading: false,
  }),
}));

vi.mock("@/lib/sandbox-provider", () => ({
  supportsRepoImages: () => true,
}));

function renderWithFeed(feed: ImageBuildsFeed) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: { [IMAGE_BUILDS_KEY]: feed },
        dedupingInterval: Infinity,
        revalidateOnFocus: false,
        revalidateIfStale: false,
        revalidateOnReconnect: false,
      }}
    >
      <ImagesSettings />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ImagesSettings", () => {
  it("renders ready details from the primary repository_shas entry", () => {
    renderWithFeed({
      units: [{ scopeKind: "repo", scopeId: "acme/web" }],
      enabledRepos: [{ repoOwner: "acme", repoName: "web" }],
      images: [
        {
          id: "build-1",
          scope_kind: "repo",
          scope_id: "acme/web",
          provider: "modal",
          status: "ready",
          repository_shas: JSON.stringify([
            { repoOwner: "acme", repoName: "web", baseSha: "abc1234def5678" },
          ]),
          runtime_version: "60",
          build_duration_seconds: 42,
          error_message: null,
          created_at: Date.now(),
        },
      ],
    });

    expect(screen.getByText(/^Ready/)).toBeInTheDocument();
    expect(screen.getByText("abc1234 · 42s")).toBeInTheDocument();
  });

  it("renders a failed build with its error message", () => {
    renderWithFeed({
      units: [{ scopeKind: "repo", scopeId: "acme/web" }],
      enabledRepos: [{ repoOwner: "acme", repoName: "web" }],
      images: [
        {
          id: "build-1",
          scope_kind: "repo",
          scope_id: "acme/web",
          provider: "modal",
          status: "failed",
          repository_shas: "[]",
          runtime_version: "60",
          build_duration_seconds: null,
          error_message: "clone exploded",
          created_at: Date.now(),
        },
      ],
    });

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("clone exploded")).toBeInTheDocument();
  });

  it("keeps the toggle enabled when unit resolution transiently dropped the repo", () => {
    // Enabled per the persisted flag but absent from `units` — toggle state
    // must come from the flag, not the resolution-dependent units feed.
    renderWithFeed({
      units: [],
      enabledRepos: [{ repoOwner: "acme", repoName: "web" }],
      images: [],
    });

    expect(
      screen.getByRole("switch", { name: "Toggle pre-built images for acme/web" })
    ).toBeChecked();
  });

  it("renders a disabled toggle for a repo with no persisted flag", () => {
    renderWithFeed({ units: [], enabledRepos: [], images: [] });

    expect(
      screen.getByRole("switch", { name: "Toggle pre-built images for acme/web" })
    ).not.toBeChecked();
  });
});
