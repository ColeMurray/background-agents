// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: mocks.browserApiFetch }));

import { useSkillResolutionPreview } from "./use-managed-skills";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

function previewResponse(name: string) {
  return Response.json({
    skills: [
      {
        skillId: `skill-${name}`,
        revisionId: `revision-${name}`,
        name,
        description: `${name} description`,
        revisionNumber: 1,
        revisionSha256: "abc",
        totalBytes: 10,
        assignmentSources: [],
      },
    ],
    totalBytes: 10,
    ignoredProfileSkillIds: [],
  });
}

describe("useSkillResolutionPreview", () => {
  beforeEach(() => vi.resetAllMocks());

  it("never exposes preview data from the previous target key", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    mocks.browserApiFetch
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveSecond = resolve)));

    const { result, rerender } = renderHook(
      ({ repoName }) =>
        useSkillResolutionPreview({ repoOwner: "open-inspect", repoName }, { mode: "all" }),
      { initialProps: { repoName: "first" }, wrapper }
    );
    await waitFor(() => expect(mocks.browserApiFetch).toHaveBeenCalledTimes(1));

    await act(async () => resolveFirst(previewResponse("first-skill")));
    await waitFor(() => expect(result.current.preview?.skills[0].name).toBe("first-skill"));

    rerender({ repoName: "second" });
    expect(result.current.preview).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(mocks.browserApiFetch).toHaveBeenCalledTimes(2));

    await act(async () => resolveSecond(previewResponse("second-skill")));
    await waitFor(() => expect(result.current.preview?.skills[0].name).toBe("second-skill"));

    const requestBodies = mocks.browserApiFetch.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body))
    );
    expect(requestBodies).toEqual([
      { repoOwner: "open-inspect", repoName: "first", selection: { mode: "all" } },
      { repoOwner: "open-inspect", repoName: "second", selection: { mode: "all" } },
    ]);
  });
});
