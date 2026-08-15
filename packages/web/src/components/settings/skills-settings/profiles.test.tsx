// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillProfile, SkillSummary } from "@open-inspect/shared/types/skills";
import { ProfileForm } from "./profiles";

expect.extend(matchers);

const { updateSkillProfileMock, useSkillsMock, mutateMock } = vi.hoisted(() => ({
  updateSkillProfileMock: vi.fn(),
  useSkillsMock: vi.fn(),
  mutateMock: vi.fn(),
}));

vi.mock("@/hooks/use-managed-skills", () => ({
  createSkillProfile: vi.fn(),
  deleteSkillProfile: vi.fn(),
  updateSkillProfile: updateSkillProfileMock,
  useSkillProfiles: () => ({ profiles: [], loading: false, error: undefined, mutate: mutateMock }),
  useSkills: useSkillsMock,
}));

const profile = {
  id: "profile-1",
  name: "Frontend work",
  skillIds: ["skill-1"],
} as SkillProfile;
const skill = { id: "skill-1", name: "review-ui", enabled: true } as SkillSummary;

beforeEach(() => {
  updateSkillProfileMock.mockReset();
  mutateMock.mockReset();
  useSkillsMock.mockReset();
});

afterEach(cleanup);

describe("ProfileForm", () => {
  it.each([
    ["loading", { skills: [], loading: true, error: undefined }],
    ["failed", { skills: [], loading: false, error: new Error("request failed") }],
  ])("gates profile saving while skills are %s", async (_state, skillsResult) => {
    useSkillsMock.mockReturnValue({ ...skillsResult, mutate: vi.fn() });
    const user = userEvent.setup();

    render(<ProfileForm profile={profile} onDone={vi.fn()} />);

    const save = screen.getByRole("button", { name: "Save profile" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(updateSkillProfileMock).not.toHaveBeenCalled();
  });

  it("preserves selected IDs once the authoritative skills list loads", async () => {
    useSkillsMock.mockReturnValue({
      skills: [skill],
      loading: false,
      error: undefined,
      mutate: vi.fn(),
    });
    updateSkillProfileMock.mockResolvedValue(profile);
    const user = userEvent.setup();

    render(<ProfileForm profile={profile} onDone={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(updateSkillProfileMock).toHaveBeenCalledWith("profile-1", {
      name: "Frontend work",
      skillIds: ["skill-1"],
    });
  });
});
