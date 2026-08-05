// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { focusSessionDetailsTrigger } from "./session-details-focus";

expect.extend(matchers);

afterEach(() => {
  document.body.replaceChildren();
});

describe("focusSessionDetailsTrigger", () => {
  it("follows the visible trigger across a phone-to-tablet breakpoint change", () => {
    const actionsWrapper = document.createElement("div");
    const detailsWrapper = document.createElement("div");
    const actionsButton = document.createElement("button");
    const detailsButton = document.createElement("button");
    actionsWrapper.append(actionsButton);
    detailsWrapper.append(detailsButton);
    document.body.append(actionsWrapper, detailsWrapper);
    Object.defineProperty(actionsButton, "offsetParent", {
      get: () => (actionsWrapper.style.display === "none" ? null : actionsWrapper),
    });
    Object.defineProperty(detailsButton, "offsetParent", {
      get: () => (detailsWrapper.style.display === "none" ? null : detailsWrapper),
    });
    detailsWrapper.style.display = "none";

    focusSessionDetailsTrigger(true, actionsButton, detailsButton);
    expect(actionsButton).toHaveFocus();

    actionsWrapper.style.display = "none";
    detailsWrapper.style.display = "block";
    focusSessionDetailsTrigger(true, actionsButton, detailsButton);
    expect(detailsButton).toHaveFocus();

    actionsWrapper.style.display = "block";
    detailsWrapper.style.display = "none";
    focusSessionDetailsTrigger(false, actionsButton, detailsButton);
    expect(actionsButton).toHaveFocus();
  });
});
