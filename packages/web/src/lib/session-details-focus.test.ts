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
    const actionsButton = document.createElement("button");
    const detailsButton = document.createElement("button");
    detailsButton.style.display = "none";
    document.body.append(actionsButton, detailsButton);

    focusSessionDetailsTrigger(true, actionsButton, detailsButton);
    expect(actionsButton).toHaveFocus();

    actionsButton.style.display = "none";
    detailsButton.style.display = "block";
    focusSessionDetailsTrigger(true, actionsButton, detailsButton);
    expect(detailsButton).toHaveFocus();

    actionsButton.style.display = "block";
    detailsButton.style.display = "none";
    focusSessionDetailsTrigger(false, actionsButton, detailsButton);
    expect(actionsButton).toHaveFocus();
  });
});
