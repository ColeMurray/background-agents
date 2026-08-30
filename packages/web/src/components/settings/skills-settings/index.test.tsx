// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SkillsSettings } from "./index";

expect.extend(matchers);

const permissions = vi.hoisted(() => new Set<string>());

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => permissions.has(permission),
  }),
}));
vi.mock("./skills-catalog", () => ({
  SkillsCatalog: ({ canManage }: { canManage: boolean }) => (
    <p>Shared skills are {canManage ? "manageable" : "read-only"}</p>
  ),
}));
vi.mock("./profiles", () => ({
  Profiles: ({ canManage }: { canManage: boolean }) => (
    <p>Personal profiles are {canManage ? "manageable" : "read-only"}</p>
  ),
}));

afterEach(() => {
  cleanup();
  permissions.clear();
});

it("keeps Viewer personal profile actions while shared skills remain read-only", async () => {
  permissions.add("skills.read");
  permissions.add("skill_profiles.manage_own");
  const user = userEvent.setup();

  render(<SkillsSettings />);

  expect(screen.getByText("Shared skills are read-only")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "My profiles" }));
  expect(screen.getByText("Personal profiles are manageable")).toBeInTheDocument();
});

it("keeps both mutation surfaces available to a managing role", async () => {
  permissions.add("skills.manage");
  permissions.add("skill_profiles.manage_own");
  const user = userEvent.setup();

  render(<SkillsSettings />);

  expect(screen.getByText("Shared skills are manageable")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "My profiles" }));
  expect(screen.getByText("Personal profiles are manageable")).toBeInTheDocument();
});
