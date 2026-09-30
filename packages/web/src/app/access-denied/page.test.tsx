// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}));

import AccessDeniedPage from "./page";

expect.extend(matchers);

afterEach(cleanup);

function renderWith(query: string) {
  mocks.searchParams = new URLSearchParams(query);
  render(<AccessDeniedPage />);
}

describe("AccessDeniedPage", () => {
  it("explains an admission denial", () => {
    renderWith("error=access_denied&provider=github");

    expect(
      screen.getByText("Your account is not authorized to use this application.")
    ).toBeInTheDocument();
  });

  it("names the GitHub App permission when GitHub rejects the email lookup", () => {
    renderWith("error=provider_rejected&provider=github");

    expect(
      screen.getByText(
        "GitHub did not allow this application to read your verified email addresses. An administrator should check that the GitHub App has the Account permission 'Email addresses: Read-only'."
      )
    ).toBeInTheDocument();
  });

  it("asks the user to retry when a check is temporarily unavailable", () => {
    renderWith("error=provider_unavailable&provider=github");

    expect(
      screen.getByText("Sign-in could not be completed right now. Please try again in a moment.")
    ).toBeInTheDocument();
  });

  it("falls back to a generic message for an unknown error", () => {
    renderWith("error=something_else");

    expect(
      screen.getByText("An error occurred during sign in. Please try again.")
    ).toBeInTheDocument();
  });
});
