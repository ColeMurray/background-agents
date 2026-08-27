import { describe, expect, it } from "vitest";
import { isAutofixQueue } from "./queue-routing";

describe("queue routing", () => {
  it("does not route image finalization queues with Autofix in the deployment name", () => {
    expect(isAutofixQueue("open-inspect-image-build-finalization-github-autofix-test")).toBe(false);
    expect(isAutofixQueue("open-inspect-github-autofix-test")).toBe(true);
  });
});
