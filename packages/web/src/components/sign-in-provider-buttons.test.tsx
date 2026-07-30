// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-session", () => ({
  signIn: vi.fn(),
}));

import { SignInProviderButtons } from "./sign-in-provider-buttons";
import { signIn } from "@/lib/auth-session";

expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SignInProviderButtons", () => {
  it("renders only the configured providers", () => {
    render(<SignInProviderButtons providers={["google"]} />);

    expect(screen.getByRole("button", { name: "Sign in with Google" })).toHaveAttribute(
      "data-sign-in-provider",
      "google"
    );
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).not.toBeInTheDocument();
  });

  it("invokes only the selected provider and disables every action while pending", async () => {
    let completeSignIn!: () => void;
    vi.mocked(signIn).mockReturnValue(
      new Promise<void>((resolve) => {
        completeSignIn = resolve;
      })
    );
    const user = userEvent.setup();
    render(<SignInProviderButtons providers={["github", "google"]} />);

    await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));

    expect(signIn).toHaveBeenCalledOnce();
    expect(signIn).toHaveBeenCalledWith("github");
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Starting sign in");

    await act(async () => {
      completeSignIn();
    });

    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Starting sign in");
  });

  it("shows a sanitized retryable error when initiation fails", async () => {
    vi.mocked(signIn).mockRejectedValue(new Error("sensitive upstream detail"));
    const user = userEvent.setup();
    render(<SignInProviderButtons providers={["github"]} />);

    await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not start sign in. Please try again."
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(signIn).toHaveBeenCalledTimes(2);
  });
});
