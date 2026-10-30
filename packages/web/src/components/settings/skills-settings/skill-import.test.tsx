// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { SkillImportPreviewResponse } from "@open-inspect/shared/types/skills";
import { SkillImport } from "./skill-import";

expect.extend(matchers);

const { importSkillMock, previewSkillImportMock } = vi.hoisted(() => ({
  importSkillMock: vi.fn(),
  previewSkillImportMock: vi.fn(),
}));

vi.mock("@/hooks/use-managed-skills", () => ({
  bulkImportSkills: vi.fn(),
  importSkill: importSkillMock,
  previewBulkSkillImport: vi.fn(),
  previewSkillImport: previewSkillImportMock,
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

const preview: SkillImportPreviewResponse = {
  name: "deploy",
  source: {
    provider: "github",
    repoOwner: "acme",
    repoName: "skills",
    requestedRef: null,
    resolvedRef: "main",
    commitSha: "a".repeat(40),
    subdirectory: null,
    sourceSha256: "b".repeat(64),
  },
  description: "deploy description",
  body: "deploy instructions",
  license: null,
  compatibility: null,
  metadata: {},
  revisionSha256: "c".repeat(64),
  totalBytes: 20,
  files: [
    { path: "SKILL.md", content: "deploy reviewed content", sizeBytes: 20, executable: false },
  ],
  warnings: [],
  nameAvailable: true,
};

beforeEach(() => {
  vi.mocked(toast.error).mockReset();
  importSkillMock.mockReset();
  previewSkillImportMock.mockReset().mockResolvedValue(preview);
});

afterEach(cleanup);

describe("SkillImport single mode", () => {
  it("asks for a fresh preview when the reviewed source moved", async () => {
    const moved =
      "The source moved to commit ffffffff since it was previewed. Preview the import again.";
    importSkillMock.mockRejectedValueOnce(new Error(moved));
    const onImported = vi.fn();
    const user = userEvent.setup();
    render(<SkillImport onImported={onImported} onCancel={vi.fn()} />);
    await user.click(screen.getByLabelText("Repository"));
    await user.click(await screen.findByRole("option", { name: "acme/skills" }));
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    await user.click(screen.getByRole("button", { name: "Import deploy" }));

    expect(importSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCommitSha: "a".repeat(40),
        expectedSourceSha256: "b".repeat(64),
        expectedRevisionSha256: "c".repeat(64),
      })
    );
    expect(toast.error).toHaveBeenCalledWith(moved);
    expect(onImported).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Refresh preview" }));
    expect(previewSkillImportMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Import deploy" })).toBeEnabled();
  });
});
