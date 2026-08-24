// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill, SkillImportPreviewResponse } from "@open-inspect/shared/types/skills";
import { SkillImport } from "./skill-import";
import { SkillReimport } from "./skill-reimport";

expect.extend(matchers);

const { previewSkillImportMock, previewSkillReimportMock } = vi.hoisted(() => ({
  previewSkillImportMock: vi.fn(),
  previewSkillReimportMock: vi.fn(),
}));

vi.mock("@/hooks/use-managed-skills", () => ({
  importSkill: vi.fn(),
  previewSkillImport: previewSkillImportMock,
  previewSkillReimport: previewSkillReimportMock,
  reimportSkill: vi.fn(),
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
  previewSkillReimportMock.mockReset();
});

afterEach(cleanup);

describe("repository skill preview races", () => {
  it("does not restore an import preview after the source changes", async () => {
    const pending = deferred<SkillImportPreviewResponse>();
    previewSkillImportMock.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<SkillImport onImported={vi.fn()} onCancel={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("Repository"), "acme/skills");
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    await user.type(screen.getByLabelText("Branch, tag, or commit (optional)"), "next");
    await act(async () => pending.resolve(preview));

    expect(screen.queryByText("preview:deploy-service")).not.toBeInTheDocument();
  });

  it("does not restore a re-import preview after the ref changes", async () => {
    const pending = deferred<SkillImportPreviewResponse>();
    previewSkillReimportMock.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<SkillReimport skill={importedSkill} dirty={false} onReimported={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await user.type(screen.getByLabelText("Branch, tag, or commit (optional)"), "next");
    await act(async () => pending.resolve(preview));

    expect(screen.queryByText("preview:deploy-service")).not.toBeInTheDocument();
  });
});
