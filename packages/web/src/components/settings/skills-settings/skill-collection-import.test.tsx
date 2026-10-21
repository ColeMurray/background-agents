// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BULK_SKILL_IMPORT_ASSIGNMENTS } from "@open-inspect/shared/types/skills";
import type { BulkSkillImportPreviewResponse } from "@open-inspect/shared/types/skills";
import { BulkSkillImportReview } from "./bulk-skill-import-review";
import { SkillImport } from "./skill-import";

expect.extend(matchers);

const { bulkImportSkillsMock, previewBulkSkillImportMock, useEnvironmentsMock } = vi.hoisted(
  () => ({
    useEnvironmentsMock: vi.fn(),
    bulkImportSkillsMock: vi.fn(),
    previewBulkSkillImportMock: vi.fn(),
  })
);

vi.mock("@/hooks/use-managed-skills", () => ({
  bulkImportSkills: bulkImportSkillsMock,
  importSkill: vi.fn(),
  previewBulkSkillImport: previewBulkSkillImportMock,
  previewSkillImport: vi.fn(),
}));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: [{ owner: "acme", name: "skills", fullName: "acme/skills", defaultBranch: "main" }],
    loading: false,
    error: undefined,
  }),
}));
vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: useEnvironmentsMock,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

function member(
  name: string,
  subdirectory: string,
  nameAvailable: boolean
): BulkSkillImportPreviewResponse["skills"][number] {
  return {
    name,
    source: {
      provider: "github",
      repoOwner: "acme",
      repoName: "skills",
      requestedRef: "release",
      resolvedRef: "release",
      commitSha: "a".repeat(40),
      subdirectory,
      sourceSha256: nameAvailable ? "b".repeat(64) : "d".repeat(64),
    },
    description: `${name} description`,
    body: `${name} instructions`,
    license: null,
    compatibility: null,
    metadata: {},
    revisionSha256: nameAvailable ? "c".repeat(64) : "e".repeat(64),
    totalBytes: 20,
    files: [
      {
        path: "SKILL.md",
        content: `${name} reviewed content`,
        sizeBytes: 20,
        executable: false,
      },
    ],
    warnings: nameAvailable ? [] : [{ code: "name-derived", message: "Name was derived" }],
    nameAvailable,
  };
}

const preview: BulkSkillImportPreviewResponse = {
  skills: [member("deploy", "catalog/deploy", true), member("existing", "catalog/existing", false)],
  totalFiles: 2,
  totalBytes: 40,
};

beforeEach(() => {
  useEnvironmentsMock.mockReset().mockReturnValue({
    environments: [{ id: "env-production", name: "Production" }],
    loading: false,
    error: undefined,
  });
  previewBulkSkillImportMock.mockReset();
  bulkImportSkillsMock.mockReset();
  previewBulkSkillImportMock.mockResolvedValue(preview);
  bulkImportSkillsMock.mockResolvedValue([{ name: "deploy" }]);
});

afterEach(cleanup);

describe("SkillImport collection mode", () => {
  it("exposes the mode selector as a named group", () => {
    render(<SkillImport onImported={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("group", { name: "Import mode" })).toBeInTheDocument();
  });

  it("previews all skills, blocks unavailable names, and invalidates on source edits", async () => {
    const user = userEvent.setup();
    render(<SkillImport onImported={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("button", { name: "One skill" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "Skill collection" }));
    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.type(screen.getByLabelText("Branch, tag, or commit (optional)"), "release");
    await user.type(screen.getByLabelText("Prefix (optional)"), "catalog");
    await user.click(screen.getByRole("button", { name: "Preview collection" }));

    expect(previewBulkSkillImportMock).toHaveBeenCalledWith({
      source: {
        repository: { repoOwner: "acme", repoName: "skills" },
        ref: "release",
        subdirectory: "catalog",
      },
    });
    expect(screen.getByText("2 skills discovered")).toBeInTheDocument();
    expect(screen.getByText("2 files · 40 bytes")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select deploy" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select existing" })).toBeDisabled();
    expect(screen.getByText("Unavailable name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 1 skills" })).toBeEnabled();

    await user.click(screen.getByRole("checkbox", { name: "Select deploy" }));
    expect(screen.getByRole("button", { name: "Import 0 skills" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Select all available skills" }));
    expect(screen.getByRole("checkbox", { name: "Select deploy" })).toBeChecked();

    await user.click(screen.getAllByText("Review full details")[0]);
    expect(screen.getByText("deploy reviewed content")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Prefix (optional)"), "/next");
    expect(screen.queryByText("2 skills discovered")).not.toBeInTheDocument();
  });

  it("confirms exactly the selected reviewed skill with shared global assignment", async () => {
    const onImported = vi.fn();
    const user = userEvent.setup();
    render(<SkillImport onImported={onImported} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Skill collection" }));
    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.type(screen.getByLabelText("Branch, tag, or commit (optional)"), "release");
    await user.type(screen.getByLabelText("Prefix (optional)"), "catalog");
    await user.click(screen.getByRole("button", { name: "Preview collection" }));
    await user.click(screen.getByRole("button", { name: "Import 1 skills" }));

    expect(bulkImportSkillsMock).toHaveBeenCalledWith({
      source: {
        repository: { repoOwner: "acme", repoName: "skills" },
        ref: "release",
        subdirectory: "catalog",
      },
      expectedCommitSha: "a".repeat(40),
      skills: [
        {
          subdirectory: "catalog/deploy",
          name: "deploy",
          expectedSourceSha256: "b".repeat(64),
          expectedRevisionSha256: "c".repeat(64),
        },
      ],
      assignments: [{ type: "global" }],
    });
    expect(onImported).toHaveBeenCalledWith(null);
  });

  it("counts submitted assignments when a selected target disappears", async () => {
    const environments = Array.from({ length: MAX_BULK_SKILL_IMPORT_ASSIGNMENTS }, (_, index) => ({
      id: `env-${index}`,
      name: `Environment ${index}`,
    }));
    useEnvironmentsMock.mockReturnValue({ environments, loading: false, error: undefined });
    const user = userEvent.setup();
    const onImported = vi.fn();
    const onCancel = vi.fn();
    const view = render(<SkillImport onImported={onImported} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Skill collection" }));
    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.click(screen.getByRole("button", { name: "Preview collection" }));
    for (const environment of environments) {
      fireEvent.click(screen.getByLabelText(environment.name));
    }
    expect(screen.getByRole("button", { name: "Import 1 skills" })).toBeDisabled();

    useEnvironmentsMock.mockReturnValue({
      environments: environments.slice(1),
      loading: false,
      error: undefined,
    });
    view.rerender(<SkillImport onImported={onImported} onCancel={onCancel} />);
    expect(screen.getByRole("button", { name: "Import 1 skills" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Import 1 skills" }));
    expect(bulkImportSkillsMock.mock.calls[0][0].assignments).toEqual([
      { type: "global" },
      ...environments
        .slice(1)
        .map((environment) => ({ type: "environment", environmentId: environment.id })),
    ]);
  });

  it.each([false, true])("preserves exclusions on refresh (new member: %s)", async (addMember) => {
    const user = userEvent.setup();
    const initial = {
      ...preview,
      skills: [member("deploy", "catalog/deploy", true), member("review", "catalog/review", true)],
    };
    const refreshed = {
      ...initial,
      skills: [
        ...initial.skills,
        ...(addMember ? [member("diagnose", "catalog/diagnose", true)] : []),
      ],
    };
    previewBulkSkillImportMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    render(<SkillImport onImported={vi.fn()} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Skill collection" }));
    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.click(screen.getByRole("button", { name: "Preview collection" }));
    await user.click(screen.getByRole("checkbox", { name: "Select review" }));
    await user.click(screen.getByRole("button", { name: "Refresh preview" }));
    expect(screen.getByRole("checkbox", { name: "Select deploy" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select review" })).not.toBeChecked();
    if (addMember)
      expect(screen.getByRole("checkbox", { name: "Select diagnose" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Import 1 skills" }));
    expect(
      bulkImportSkillsMock.mock.calls[0][0].skills.map((skill: { name: string }) => skill.name)
    ).toEqual(["deploy"]);
  });

  it("locks membership and assignments until a pending confirmation finishes", async () => {
    let reject!: (error: Error) => void;
    bulkImportSkillsMock.mockReturnValueOnce(
      new Promise((_resolve, rejectImport) => {
        reject = rejectImport;
      })
    );
    const user = userEvent.setup();
    render(<SkillImport onImported={vi.fn()} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Skill collection" }));
    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.click(screen.getByRole("button", { name: "Preview collection" }));
    await user.click(screen.getByRole("button", { name: "Import 1 skills" }));
    const controls = [
      "Select deploy",
      "Select all available skills",
      "All sessions (global)",
      "acme/skills",
      "Production",
    ].map((name) => screen.getByRole("checkbox", { name }));
    for (const control of controls) expect(control).toBeDisabled();
    await user.click(controls[0]);
    await user.click(controls[2]);
    expect(controls[0]).toBeChecked();
    expect(controls[2]).toBeChecked();
    expect(bulkImportSkillsMock.mock.calls[0][0].assignments).toEqual([{ type: "global" }]);
    await act(async () => reject(new Error("Retry import")));
    for (const control of controls) expect(control).toBeEnabled();
  });

  it("renders a 64-skill selection list without mounting closed file details", async () => {
    const user = userEvent.setup();
    const skills = Array.from({ length: 64 }, (_, index) =>
      member(`skill-${index}`, `catalog/skill-${index}`, true)
    );

    render(
      <BulkSkillImportReview
        preview={{ skills, totalFiles: 64, totalBytes: 1280 }}
        selectedRoots={new Set(skills.map((skill) => skill.source.subdirectory ?? ""))}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />
    );

    expect(screen.getByText("64 skills discovered")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: /^Select skill-/ })).toHaveLength(64);
    expect(screen.queryByText("skill-0 reviewed content")).not.toBeInTheDocument();
    expect(screen.queryByText("skill-63 reviewed content")).not.toBeInTheDocument();

    await user.click(screen.getAllByText("Review full details")[32]);

    expect(screen.getByText("skill-32 reviewed content")).toBeInTheDocument();
    expect(screen.queryByText("skill-31 reviewed content")).not.toBeInTheDocument();
    expect(screen.queryByText("skill-33 reviewed content")).not.toBeInTheDocument();

    await user.click(screen.getAllByText("Review full details")[32]);
    expect(screen.queryByText("skill-32 reviewed content")).not.toBeInTheDocument();
  });
});
