import { describe, expect, it } from "vitest";
import { escapeLikePattern, LIKE_ESCAPE_CLAUSE, likeContains, likePrefix } from "./like-pattern";

describe("like-pattern", () => {
  it("escapes every LIKE metacharacter with the declared escape character", () => {
    expect(escapeLikePattern("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(LIKE_ESCAPE_CLAUSE).toBe("ESCAPE '\\'");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLikePattern("owner/repo name")).toBe("owner/repo name");
  });

  it("wraps escaped text as a contains or prefix pattern", () => {
    expect(likeContains("a%b")).toBe("%a\\%b%");
    expect(likePrefix("sess_1")).toBe("sess\\_1%");
  });
});
