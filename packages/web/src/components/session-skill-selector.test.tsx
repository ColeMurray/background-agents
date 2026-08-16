// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSkillSelector } from "./session-skill-selector";

expect.extend(matchers);

const { resolveSkillPreviewMock } = vi.hoisted(() => ({ resolveSkillPreviewMock: vi.fn() }));

vi.mock("@/hooks/use-managed-skills", () => ({
  resolveSkillPreview: resolveSkillPreviewMock,
  useSkillProfiles: () => ({ profiles: [], loading: false }),
}));

vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
  resolveSkillPreviewMock.mockReset();
});

describe("SessionSkillSelector", () => {
  it("clears preview state when the target becomes unavailable", async () => {
    resolveSkillPreviewMock.mockResolvedValue({
      skills: [{ id: "skill-1" }],
      totalBytes: 1,
      ignoredProfileSkillIds: ["skill-2", "skill-3"],
    });
    const { rerender } = render(
      <SessionSkillSelector
        value={{ mode: "all" }}
        onChange={vi.fn()}
        target={{ repositories: [] }}
      />
    );
    await screen.findByText("2 ignored");

    rerender(<SessionSkillSelector value={{ mode: "all" }} onChange={vi.fn()} target={null} />);

    await waitFor(() => expect(screen.queryByText("2 ignored")).not.toBeInTheDocument());
    expect(screen.queryByText("...")).not.toBeInTheDocument();
  });
});
