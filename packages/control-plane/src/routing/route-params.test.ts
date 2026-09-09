import { describe, expect, it } from "vitest";
import { rawRouteParams } from "./route-params";

describe("rawRouteParams", () => {
  it("reads parameters back from the pathname by position without decoding", () => {
    const params = rawRouteParams(
      "/repos/:owner/:name/secrets",
      "/repos/group%2Fsubgroup/web%252Fapp/secrets"
    );
    expect({ ...params }).toEqual({ owner: "group%2Fsubgroup", name: "web%252Fapp" });
  });

  it("keeps a parameter named like an Object property as an own entry", () => {
    const params = rawRouteParams("/things/:__proto__", "/things/value");
    expect(Object.hasOwn(params, "__proto__")).toBe(true);
    expect(params.__proto__).toBe("value");
    expect({ ...params }.__proto__).toBe("value");
  });

  it("refuses a pathname whose segments do not line up with the route", () => {
    expect(() => rawRouteParams("/sessions/:id", "/sessions/a/b")).toThrow(
      "does not line up with route"
    );
  });
});
