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

const mocks = vi.hoisted(() => ({ allowedPermissions: null as Set<string> | null }));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      mocks.allowedPermissions === null || mocks.allowedPermissions.has(permission),
  }),
}));

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
  mocks.allowedPermissions = null;
});

describe("ImagesSettings", () => {
  it("renders ready details from the primary repository provenance entry", () => {
    renderWithFeed({
      units: [{ scopeKind: "repo", scopeId: "acme/web", repositoriesFingerprint: "fp" }],
      enabledRepos: [{ repoOwner: "acme", repoName: "web" }],
      images: [
        {
          id: "build-1",
          scopeKind: "repo",
          scopeId: "acme/web",
          provider: "modal",
          status: "ready",
          repositoriesFingerprint: "fp",
          repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc1234def5678" }],
          runtimeVersion: "60",
          buildDurationSeconds: 42,
          errorMessage: null,
          createdAt: Date.now(),
        },
      ],
    });

    expect(screen.getByText(/^Ready/)).toBeInTheDocument();
    expect(screen.getByText("abc1234 · 42s")).toBeInTheDocument();
  });

  it("renders a failed build with its error message", () => {
    renderWithFeed({
      units: [{ scopeKind: "repo", scopeId: "acme/web", repositoriesFingerprint: "fp" }],
      enabledRepos: [{ repoOwner: "acme", repoName: "web" }],
      images: [
        {
          id: "build-1",
          scopeKind: "repo",
          scopeId: "acme/web",
          provider: "modal",
          status: "failed",
          repositoriesFingerprint: "fp",
          repositoryShas: [],
          runtimeVersion: "60",
          buildDurationSeconds: null,
          errorMessage: "clone exploded",
          createdAt: Date.now(),
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

  it("keeps image state visible but disables mutations for a read-only role", () => {
    mocks.allowedPermissions = new Set(["image_builds.read"]);
    renderWithFeed({
      units: [],
      enabledRepos: [{ repoOwner: "acme", repoName: "web" }],
      images: [],
    });

    expect(
      screen.getByRole("switch", { name: "Toggle pre-built images for acme/web" })
    ).toBeDisabled();
    expect(screen.queryByTitle("Rebuild image")).not.toBeInTheDocument();
  });

  it("shows an error instead of unchecked toggles when the feed fails", async () => {
    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fetcher: () => Promise.reject(new Error("boom")),
          dedupingInterval: 0,
          shouldRetryOnError: false,
          revalidateOnFocus: false,
        }}
      >
        <ImagesSettings />
      </SWRConfig>
    );

    expect(await screen.findByText("Failed to load image build settings.")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
