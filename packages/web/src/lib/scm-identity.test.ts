import { describe, expect, it } from "vitest";
import { resolveScmIdentity } from "./scm-identity";

describe("resolveScmIdentity", () => {
  it("keeps explicit email when present", () => {
    const identity = resolveScmIdentity({
      id: "123",
      login: "octocat",
      name: "The Octocat",
      email: "octocat@example.com",
    });

    expect(identity).toEqual({
      scmUserId: "123",
      scmLogin: "octocat",
      scmName: "The Octocat",
      scmEmail: "octocat@example.com",
    });
  });

  it("uses id+login noreply when email is missing", () => {
    const identity = resolveScmIdentity({
      id: "123",
      login: "octocat",
      name: null,
      email: null,
    });

    expect(identity).toEqual({
      scmUserId: "123",
      scmLogin: "octocat",
      scmName: "octocat",
      scmEmail: "123+octocat@users.noreply.github.com",
    });
  });

  it("uses login noreply when id is unavailable", () => {
    const identity = resolveScmIdentity({
      login: "octocat",
      email: null,
    });

    expect(identity).toEqual({
      scmUserId: null,
      scmLogin: "octocat",
      scmName: "octocat",
      scmEmail: "octocat@users.noreply.github.com",
    });
  });
});
