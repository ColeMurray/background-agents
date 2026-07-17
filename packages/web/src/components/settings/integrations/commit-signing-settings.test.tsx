// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";

import { CommitSigningSettings } from "./commit-signing-settings";

expect.extend(matchers);

const { useSWRMock, mutateMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn(),
  mutateMock: vi.fn(),
}));

vi.mock("swr", () => ({
  default: useSWRMock,
  mutate: mutateMock,
}));

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  useSWRMock.mockReturnValue({ data: { enabled: false }, isLoading: false, mutate: mutateMock });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommitSigningSettings", () => {
  it("renders not configured from disabled metadata", () => {
    render(<CommitSigningSettings />);

    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/OPENSSH PRIVATE KEY/)).not.toBeInTheDocument();
  });

  it("renders loading separately and disables configuration controls", () => {
    useSWRMock.mockReturnValue({ data: undefined, isLoading: true, mutate: mutateMock });

    render(<CommitSigningSettings />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub signing account")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save signing configuration" })).toBeDisabled();
  });

  it("renders fetch failures separately and disables configuration controls", () => {
    useSWRMock.mockReturnValue({
      data: undefined,
      error: new Error("unavailable"),
      isLoading: false,
      mutate: mutateMock,
    });

    render(<CommitSigningSettings />);

    expect(screen.getByText("Unable to load configuration")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub signing account")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save signing configuration" })).toBeDisabled();
  });

  it("submits the transient key, clears it, and caches only returned metadata", async () => {
    const user = userEvent.setup();
    const metadata = {
      enabled: true as const,
      keyFormat: "ssh-ed25519" as const,
      githubLogin: "open-inspect-bot",
      committerName: "Open Inspect",
      committerEmail: "open-inspect@example.com",
      publicKey: "ssh-ed25519 AAAA public",
      fingerprint: "SHA256:fingerprint",
      validationStatus: "valid" as const,
      validatedAt: "2026-07-16T12:00:00.000Z",
      updatedAt: "2026-07-16T12:00:00.000Z",
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => metadata });
    render(<CommitSigningSettings />);

    await user.type(screen.getByLabelText("GitHub signing account"), "open-inspect-bot");
    await user.type(screen.getByLabelText("Committer name"), "Open Inspect");
    await user.type(screen.getByLabelText("Committer email"), "open-inspect@example.com");
    const keyInput = screen.getByLabelText("OpenSSH Ed25519 private key");
    await user.type(keyInput, "PRIVATE-KEY-BYTES");
    await user.click(screen.getByRole("button", { name: "Save signing configuration" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/commit-signing",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          privateKey: "PRIVATE-KEY-BYTES",
          githubLogin: "open-inspect-bot",
          committerName: "Open Inspect",
          committerEmail: "open-inspect@example.com",
        }),
      })
    );
    expect(keyInput).toHaveValue("");
    expect(mutateMock).toHaveBeenCalledWith(metadata, false);
  });

  it("clears a failed key submission while retaining active public metadata", async () => {
    const user = userEvent.setup();
    useSWRMock.mockReturnValue({
      data: {
        enabled: true,
        keyFormat: "ssh-ed25519",
        githubLogin: "open-inspect-bot",
        committerName: "Open Inspect",
        committerEmail: "open-inspect@example.com",
        publicKey: "ssh-ed25519 AAAA existing",
        fingerprint: "SHA256:existing",
        validationStatus: "valid",
        validatedAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:00:00.000Z",
      },
      isLoading: false,
      mutate: mutateMock,
    });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid PRIVATE-KEY-BYTES" }),
    });
    render(<CommitSigningSettings />);
    const keyInput = screen.getByLabelText("OpenSSH Ed25519 private key");
    await user.type(keyInput, "PRIVATE-KEY-BYTES");

    await user.click(screen.getByRole("button", { name: "Save signing configuration" }));

    expect(keyInput).toHaveValue("");
    expect(screen.getByText("SHA256:existing")).toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledOnce();
    expect(JSON.stringify(toastError.mock.calls)).not.toContain("PRIVATE-KEY-BYTES");
  });

  it("confirms disable and removes the cached active metadata", async () => {
    const user = userEvent.setup();
    useSWRMock.mockReturnValue({
      data: {
        enabled: true,
        keyFormat: "ssh-ed25519",
        githubLogin: "open-inspect-bot",
        committerName: "Open Inspect",
        committerEmail: "open-inspect@example.com",
        publicKey: "ssh-ed25519 AAAA existing",
        fingerprint: "SHA256:existing",
        validationStatus: "valid",
        validatedAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:00:00.000Z",
      },
      isLoading: false,
      mutate: mutateMock,
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) });
    render(<CommitSigningSettings />);

    await user.click(screen.getByRole("button", { name: "Disable commit signing" }));
    await user.click(screen.getByRole("button", { name: "Disable signing" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/commit-signing", { method: "DELETE" });
    expect(mutateMock).toHaveBeenCalledWith({ enabled: false }, false);
  });

  it("does not cache a malformed successful response", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, privateKey: "PRIVATE-KEY-BYTES" }),
    });
    render(<CommitSigningSettings />);

    await user.type(screen.getByLabelText("GitHub signing account"), "open-inspect-bot");
    await user.type(screen.getByLabelText("Committer name"), "Open Inspect");
    await user.type(screen.getByLabelText("Committer email"), "open-inspect@example.com");
    await user.type(screen.getByLabelText("OpenSSH Ed25519 private key"), "PRIVATE-KEY-BYTES");
    await user.click(screen.getByRole("button", { name: "Save signing configuration" }));

    expect(mutateMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Invalid response from commit signing service");
  });

  it("does not render unvalidated SWR data as configured metadata", () => {
    useSWRMock.mockReturnValue({
      data: { enabled: true, privateKey: "secret" },
      isLoading: false,
      mutate: mutateMock,
    });

    render(<CommitSigningSettings />);

    expect(screen.getByText("Invalid service response")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub signing account")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save signing configuration" })).toBeDisabled();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });
});
