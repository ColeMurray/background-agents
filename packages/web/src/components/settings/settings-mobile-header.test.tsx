// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import { SettingsMobileHeader } from "./settings-mobile-header";

expect.extend(matchers);
afterEach(cleanup);

it("labels the mobile back link with its destination", () => {
  render(
    <SettingsMobileHeader title="Team" backHref="/settings?tab=teams" backLabel="Back to Teams" />
  );
  expect(screen.getByRole("link", { name: "Back to Teams" })).toHaveAttribute(
    "href",
    "/settings?tab=teams"
  );
});
