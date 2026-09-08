// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillImportPreviewResponse } from "@open-inspect/shared/types/skills";
import { SkillImportReview } from "./skill-import-review";

expect.extend(matchers);

afterEach(cleanup);

const preview: SkillImportPreviewResponse = {
  name: "deploy-service",
  source: {
    provider: "gitlab",
    repoOwner: "acme",
    repoName: "skills",
    requestedRef: null,
    resolvedRef: "main",
    commitSha: "a".repeat(40),
    subdirectory: "deploy-service",
    sourceSha256: "b".repeat(64),
  },
  description: "Deploys the service",
  body: "# Deploy\n",
  license: null,
  compatibility: null,
  metadata: {},
  revisionSha256: "c".repeat(64),
  totalBytes: 88,
  files: [
    {
      path: "SKILL.md",
      content: "---\nname: deploy-service\n---\n# Deploy\n",
      sizeBytes: 48,
      executable: false,
    },
    {
      path: "scripts/deploy.sh",
      content: "#!/bin/sh\necho deploy-reviewed-content\n",
      sizeBytes: 40,
      executable: true,
    },
  ],
  warnings: [],
  nameAvailable: true,
};

describe("SkillImportReview", () => {
  it("shows the source provider and the content of every supporting file", () => {
    render(<SkillImportReview preview={preview} />);

    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("gitlab")).toBeInTheDocument();
    expect(screen.getByText("scripts/deploy.sh")).toBeInTheDocument();
    expect(screen.getByText(/deploy-reviewed-content/)).toBeInTheDocument();
    expect(screen.getByText("executable")).toBeInTheDocument();
    expect(screen.getByText(/name: deploy-service/)).toBeInTheDocument();
  });
});
