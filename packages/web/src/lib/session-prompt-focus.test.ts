// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { restorePromptFocusIfUnclaimed } from "./session-prompt-focus";

expect.extend(matchers);

afterEach(() => {
  document.body.replaceChildren();
});

describe("restorePromptFocusIfUnclaimed", () => {
  it("restores focus when disabling the prompt left focus unclaimed", () => {
    const input = document.createElement("textarea");
    document.body.append(input);

    restorePromptFocusIfUnclaimed(input);

    expect(input).toHaveFocus();
  });

  it("preserves focus claimed by another control", () => {
    const input = document.createElement("textarea");
    const otherControl = document.createElement("button");
    document.body.append(input, otherControl);
    otherControl.focus();

    restorePromptFocusIfUnclaimed(input);

    expect(otherControl).toHaveFocus();
  });
});
