import { describe, expect, it } from "vitest";
import { splitRepoFullName } from "./repo";

describe("splitRepoFullName", () => {
  it("splits a GitHub-style org/repo full name", () => {
    expect(splitRepoFullName("acme/web-app")).toEqual({
      owner: "acme",
      name: "web-app",
    });
  });

  it("splits a GitLab nested-group path on the last slash", () => {
    expect(splitRepoFullName("acme/backend/web-app")).toEqual({
      owner: "acme/backend",
      name: "web-app",
    });
  });

  it("splits deeply nested GitLab subgroup paths", () => {
    expect(splitRepoFullName("acme/infra/tools/elasticsearch/scripts")).toEqual({
      owner: "acme/infra/tools/elasticsearch",
      name: "scripts",
    });
  });

  it("returns an empty owner when there is no slash", () => {
    expect(splitRepoFullName("web-app")).toEqual({
      owner: "",
      name: "web-app",
    });
  });
});
