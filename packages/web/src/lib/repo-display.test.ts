import { describe, expect, it } from "vitest";
import {
  getRepoSelectorDescription,
  getRepoSelectorLabel,
  getRepoSelectorOption,
  getSelectedRepoDisplayName,
} from "./repo-display";

describe("repo-display", () => {
  it("uses the full repo name for selector labels", () => {
    expect(getRepoSelectorLabel({ fullName: "octo-org/demo" })).toBe("octo-org/demo");
  });

  it("shows private status without repeating the owner", () => {
    expect(getRepoSelectorDescription({ private: true })).toBe("Private repository");
    expect(getRepoSelectorDescription({ private: false })).toBeUndefined();
  });

  it("builds unambiguous combobox options", () => {
    expect(getRepoSelectorOption({ fullName: "octo-org/demo", private: true })).toEqual({
      value: "octo-org/demo",
      label: "octo-org/demo",
      description: "Private repository",
    });
  });

  it("falls back when no repository is selected", () => {
    expect(getSelectedRepoDisplayName(undefined, "Select repository")).toBe("Select repository");
    expect(getSelectedRepoDisplayName({ fullName: "octo-org/demo" }, "Select repository")).toBe(
      "octo-org/demo"
    );
  });
});
