// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillProfile, SkillSummary } from "@open-inspect/shared/types/skills";
import { ProfileForm, Profiles } from "./profiles";

expect.extend(matchers);

const { updateSkillProfileMock, useSkillProfilesMock, useSkillsMock, mutateMock } = vi.hoisted(
  () => ({
    updateSkillProfileMock: vi.fn(),
    useSkillProfilesMock: vi.fn(),
    useSkillsMock: vi.fn(),
    mutateMock: vi.fn(),
  })
);

vi.mock("@/hooks/use-managed-skills", () => ({
  createSkillProfile: vi.fn(),
  deleteSkillProfile: vi.fn(),
  updateSkillProfile: updateSkillProfileMock,
  useSkillProfiles: useSkillProfilesMock,
  useSkills: useSkillsMock,
}));

const profile = {
  id: "profile-1",
  name: "Frontend work",
  skillIds: ["skill-1"],
  createdAt: 1,
  updatedAt: 1,
} satisfies SkillProfile;
const skill = {
  id: "skill-1",
  name: "review-ui",
  description: "Reviews UI changes",
  enabled: true,
  currentRevisionId: "revision-1",
  revisionNumber: 1,
  revisionSha256: "a".repeat(64),
  revisionCreatedBy: "user-1",
  creatorDisplayName: "User One",
  lastEditorDisplayName: "User One",
  revisionAuthorDisplayName: "User One",
  assignments: [],
  source: null,
  createdBy: "user-1",
  updatedBy: "user-1",
  createdAt: 1,
  updatedAt: 1,
} satisfies SkillSummary;

beforeEach(() => {
  updateSkillProfileMock.mockReset();
  mutateMock.mockReset();
  useSkillProfilesMock.mockReturnValue({
    profiles: [],
    loading: false,
    error: undefined,
    mutate: mutateMock,
  });
  useSkillsMock.mockReturnValue({ skills: [], loading: false, error: undefined, mutate: vi.fn() });
});

describe("Profiles", () => {
  it.each([
    ["loading", true, undefined, "Loading skill names..."],
    ["failed", false, new Error("request failed"), "Skill names could not be loaded"],
  ])("does not mark skills unavailable while names are %s", (_state, loading, error, message) => {
    useSkillProfilesMock.mockReturnValue({
      profiles: [profile],
      loading: false,
      error: undefined,
      mutate: mutateMock,
    });
    useSkillsMock.mockReturnValue({ skills: [], loading, error, mutate: vi.fn() });

    render(<Profiles canManage />);

    expect(screen.getByRole("button", { name: /Frontend work/ })).toHaveTextContent(message);
    expect(screen.queryByText(/Unavailable/)).not.toBeInTheDocument();
  });
});

afterEach(cleanup);

describe("ProfileForm", () => {
  it.each([
    ["loading", { skills: [], loading: true, error: undefined }],
    ["failed", { skills: [], loading: false, error: new Error("request failed") }],
  ])("gates profile saving while skills are %s", async (_state, skillsResult) => {
    const user = userEvent.setup();

    render(
      <ProfileForm
        profile={profile}
        skills={skillsResult.skills}
        skillsLoading={skillsResult.loading}
        skillsError={skillsResult.error}
        onDone={vi.fn()}
      />
    );

    const save = screen.getByRole("button", { name: "Save profile" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(updateSkillProfileMock).not.toHaveBeenCalled();
  });

  it("preserves selected IDs once the authoritative skills list loads", async () => {
    updateSkillProfileMock.mockResolvedValue(profile);
    const user = userEvent.setup();

    render(
      <ProfileForm
        profile={profile}
        skills={[skill]}
        skillsLoading={false}
        skillsError={undefined}
        onDone={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(updateSkillProfileMock).toHaveBeenCalledWith("profile-1", {
      name: "Frontend work",
      skillIds: ["skill-1"],
    });
  });
});
