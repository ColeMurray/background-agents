// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BulkSkillImportPreviewResponse,
  Skill,
  SkillImportPreviewResponse,
} from "@open-inspect/shared/types/skills";
import { SkillImport } from "./skill-import";
import { SkillReimport } from "./skill-reimport";

expect.extend(matchers);

const {
  previewBulkSkillImportMock,
  bulkImportSkillsMock,
  previewSkillImportMock,
  importSkillMock,
  previewSkillReimportMock,
  reimportSkillMock,
} = vi.hoisted(() => ({
  previewBulkSkillImportMock: vi.fn(),
  bulkImportSkillsMock: vi.fn(),
  previewSkillImportMock: vi.fn(),
  importSkillMock: vi.fn(),
  previewSkillReimportMock: vi.fn(),
  reimportSkillMock: vi.fn(),
}));

vi.mock("@/hooks/use-managed-skills", () => ({
  importSkill: importSkillMock,
  bulkImportSkills: bulkImportSkillsMock,
  previewBulkSkillImport: previewBulkSkillImportMock,
  previewSkillImport: previewSkillImportMock,
  previewSkillReimport: previewSkillReimportMock,
  reimportSkill: reimportSkillMock,
}));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: [{ owner: "acme", name: "skills", fullName: "acme/skills", defaultBranch: "main" }],
    loading: false,
    error: undefined,
  }),
}));
vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({ environments: [], loading: false, error: undefined }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("./skill-assignments", () => ({ SkillAssignments: () => null }));
vi.mock("./skill-import-review", () => ({
  SkillImportReview: ({ preview }: { preview: SkillImportPreviewResponse }) => (
    <div>preview:{preview.name}</div>
  ),
  SkillImportSourceSummary: () => null,
}));
vi.mock("./bulk-skill-import-review", () => ({
  BulkSkillImportReview: ({ preview }: { preview: BulkSkillImportPreviewResponse }) => (
    <div>collection:{preview.skills[0].name}</div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const preview: SkillImportPreviewResponse = {
  name: "deploy-service",
  source: {
    provider: "github",
    repoOwner: "acme",
    repoName: "skills",
    requestedRef: "main",
    resolvedRef: "main",
    commitSha: "a".repeat(40),
    subdirectory: null,
    sourceSha256: "b".repeat(64),
  },
  description: "Deploys the service",
  body: "# Deploy\n",
  license: null,
  compatibility: null,
  metadata: {},
  revisionSha256: "c".repeat(64),
  totalBytes: 40,
  files: [
    {
      path: "SKILL.md",
      content: "---\nname: deploy-service\n---\n",
      sizeBytes: 40,
      executable: false,
    },
  ],
  warnings: [],
  nameAvailable: true,
};

const importedSkill: Skill = {
  id: "skill-1",
  name: "deploy-service",
  description: preview.description,
  body: preview.body,
  license: null,
  compatibility: null,
  metadata: {},
  files: [],
  enabled: true,
  currentRevisionId: "revision-1",
  revisionNumber: 1,
  revisionSha256: "d".repeat(64),
  revisionCreatedBy: "user-1",
  creatorDisplayName: "User One",
  lastEditorDisplayName: "User One",
  revisionAuthorDisplayName: "User One",
  assignments: [],
  source: { ...preview.source, importedAt: 1, revisionId: "revision-1" },
  createdBy: "user-1",
  updatedBy: "user-1",
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  previewSkillImportMock.mockReset();
  importSkillMock.mockReset();
  previewBulkSkillImportMock.mockReset();
  bulkImportSkillsMock.mockReset();
  previewSkillReimportMock.mockReset();
  reimportSkillMock.mockReset();
});

afterEach(cleanup);

describe("repository skill preview races", () => {
  it("blocks closing, mode changes, source edits, and duplicate previews while previewing", async () => {
    const pending = deferred<SkillImportPreviewResponse>();
    previewSkillImportMock.mockReturnValueOnce(pending.promise);
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<SkillImport onImported={vi.fn()} onCancel={onCancel} />);

    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skill collection" })).toBeDisabled();
    expect(screen.getByLabelText("Repository")).toBeDisabled();
    expect(screen.getByLabelText("Branch, tag, or commit (optional)")).toBeDisabled();
    expect(screen.getByLabelText("Subdirectory (optional)")).toBeDisabled();
    expect(screen.getByLabelText("Canonical name (optional)")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Skill collection" }));
    fireEvent.click(screen.getByRole("button", { name: "Reading..." }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(previewSkillImportMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Subdirectory (optional)")).toBeInTheDocument();

    await act(async () => pending.resolve(preview));

    expect(screen.getByText("preview:deploy-service")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    expect(screen.getByLabelText("Branch, tag, or commit (optional)")).toBeEnabled();
  });

  it("clears the import preview and disables previewing when the repository is reset", async () => {
    previewSkillImportMock.mockResolvedValueOnce(preview);
    const user = userEvent.setup();
    render(<SkillImport onImported={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Preview import" })).toBeDisabled();
    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    expect(await screen.findByText("preview:deploy-service")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "Select a repository" }));

    expect(screen.getByLabelText("Repository")).toHaveTextContent("Select a repository");
    expect(screen.queryByText("preview:deploy-service")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import deploy-service" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview import" })).toBeDisabled();

    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    expect(screen.getByRole("button", { name: "Preview import" })).toBeEnabled();
  });

  it("does not restore a re-import preview after the ref changes", async () => {
    const pending = deferred<SkillImportPreviewResponse>();
    previewSkillReimportMock.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(
      <SkillReimport
        skill={importedSkill}
        dirty={false}
        onReimported={vi.fn(async () => undefined)}
        onSavingChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await user.type(screen.getByLabelText("Branch, tag, or commit (optional)"), "next");
    await act(async () => pending.resolve(preview));

    expect(screen.queryByText("preview:deploy-service")).not.toBeInTheDocument();
  });

  it("keeps collection source fields and surrounding controls disabled while previewing", async () => {
    const pending = deferred<BulkSkillImportPreviewResponse>();
    previewBulkSkillImportMock.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<SkillImport onImported={vi.fn()} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Skill collection" }));
    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.click(screen.getByRole("button", { name: "Preview collection" }));
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "One skill" })).toBeDisabled();
    expect(screen.getByLabelText("Repository")).toBeDisabled();
    expect(screen.getByLabelText("Branch, tag, or commit (optional)")).toBeDisabled();
    expect(screen.getByLabelText("Prefix (optional)")).toBeDisabled();
    await act(async () => pending.resolve({ skills: [preview], totalFiles: 1, totalBytes: 40 }));

    expect(screen.getByText("collection:deploy-service")).toBeInTheDocument();
  });

  it("does not confirm a stale collection preview while refreshing", async () => {
    previewBulkSkillImportMock.mockResolvedValueOnce({
      skills: [preview],
      totalFiles: 1,
      totalBytes: 40,
    });
    const refresh = deferred<BulkSkillImportPreviewResponse>();
    previewBulkSkillImportMock.mockReturnValueOnce(refresh.promise);
    const user = userEvent.setup();
    render(<SkillImport onImported={vi.fn()} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Skill collection" }));
    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.click(screen.getByRole("button", { name: "Preview collection" }));
    await user.click(screen.getByRole("button", { name: "Refresh preview" }));

    expect(screen.getByRole("button", { name: "Import 1 skills" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Import 1 skills" }));
    expect(bulkImportSkillsMock).not.toHaveBeenCalled();

    await act(async () => refresh.resolve({ skills: [preview], totalFiles: 1, totalBytes: 40 }));
    expect(screen.getByRole("button", { name: "Import 1 skills" })).toBeEnabled();
  });

  it("prevents overlapping confirms and ignores a completion after unmount", async () => {
    previewSkillImportMock.mockResolvedValueOnce(preview);
    const pending = deferred<Skill>();
    importSkillMock.mockReturnValueOnce(pending.promise);
    const onImported = vi.fn();
    const user = userEvent.setup();
    const view = render(<SkillImport onImported={onImported} onCancel={vi.fn()} />);

    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    await user.click(screen.getByRole("button", { name: "Import deploy-service" }));

    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skill collection" })).toBeDisabled();
    expect(screen.getByLabelText("Repository")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Importing..." }));
    expect(importSkillMock).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => pending.resolve(importedSkill));
    expect(onImported).not.toHaveBeenCalled();
  });

  it("keeps the surrounding editor disabled until re-import finishes", async () => {
    previewSkillReimportMock.mockResolvedValueOnce(preview);
    const pending = deferred<{ skill: Skill; revisionCreated: boolean }>();
    const refresh = deferred<void>();
    reimportSkillMock.mockReturnValueOnce(pending.promise);
    const onSavingChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SkillReimport
        skill={importedSkill}
        dirty={false}
        onReimported={vi.fn(() => refresh.promise)}
        onSavingChange={onSavingChange}
      />
    );

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await user.click(screen.getByRole("button", { name: "Save new revision from source" }));

    expect(onSavingChange).toHaveBeenCalledWith(true);
    await act(async () => pending.resolve({ skill: importedSkill, revisionCreated: true }));
    expect(onSavingChange).toHaveBeenLastCalledWith(true);
    await act(async () => refresh.resolve());
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
  });
});
