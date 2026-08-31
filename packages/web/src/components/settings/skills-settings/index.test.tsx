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

it("keeps Viewer skills read-only and hides personal profiles", () => {
  permissions.add("skills.read");

  render(<SkillsSettings />);

  expect(screen.getByText("Shared skills are read-only")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "My profiles" })).not.toBeInTheDocument();
});

it("keeps both mutation surfaces available to a managing role", async () => {
  permissions.add("skills.manage");
  permissions.add("skill_profiles.manage_own");
  const user = userEvent.setup();

  const { rerender } = render(<SkillsSettings />);

  expect(screen.getByText("Shared skills are manageable")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "My profiles" }));
  expect(screen.getByText("Personal profiles are manageable")).toBeInTheDocument();

  permissions.delete("skill_profiles.manage_own");
  rerender(<SkillsSettings />);
  expect(screen.queryByText("Personal profiles are manageable")).not.toBeInTheDocument();
  expect(screen.getByText("Shared skills are manageable")).toBeInTheDocument();
});
