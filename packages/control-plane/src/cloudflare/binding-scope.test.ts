import { describe, expect, it } from "vitest";
import { scopeBindings, scopedBindingNames } from "./binding-scope";

describe("scopeBindings", () => {
  it("holds only the named keys", () => {
    const bindings = {
      SESSION: { id: "session" },
      CODEMODE_SANDBOX: { id: "sandbox" },
      TOKEN_ENCRYPTION_KEY: "secret",
      DB: { id: "db" },
    };

    const scoped = scopeBindings(bindings, ["SESSION", "CODEMODE_SANDBOX"]);

    expect(scopedBindingNames(scoped)).toEqual(["CODEMODE_SANDBOX", "SESSION"]);
    expect(scoped).not.toHaveProperty("TOKEN_ENCRYPTION_KEY");
    expect(scoped).not.toHaveProperty("DB");
  });

  it("does not remove a binding from the caller's own object", () => {
    const bindings = { SESSION: { id: "session" }, DB: { id: "db" } };

    scopeBindings(bindings, ["SESSION"]);

    expect(Object.keys(bindings).sort()).toEqual(["DB", "SESSION"]);
  });

  it("omits a key the bindings do not carry rather than inventing one", () => {
    const scoped = scopeBindings({ SESSION: { id: "session" } }, [
      "SESSION",
      "MISSING",
    ] as unknown as readonly (keyof { SESSION: unknown })[]);

    expect(scopedBindingNames(scoped)).toEqual(["SESSION"]);
  });
});
