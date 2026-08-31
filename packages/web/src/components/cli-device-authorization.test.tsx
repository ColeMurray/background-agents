// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliDeviceAuthorization } from "./cli-device-authorization";

expect.extend(matchers);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(window, "close").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CliDeviceAuthorization", () => {
  function pendingResponse(overrides?: Partial<{ deviceName: string; expiresAt: number }>) {
    return Response.json({
      deviceName: "Ada's laptop",
      expiresAt: Date.now() + 5 * 60 * 1000,
      ...overrides,
    });
  }

  it("shows verified requesting-device metadata and expiry before enabling approval", async () => {
    vi.mocked(fetch).mockResolvedValue(pendingResponse());
    render(
      <CliDeviceAuthorization
        userCode="ABCD-EFGH"
        user={{ name: "Ada Lovelace", email: "ada@example.com" }}
      />
    );

    expect(screen.getByRole("heading", { name: "Authorize Open-Inspect CLI" })).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Authorization code")).toHaveTextContent("ABCD-EFGH");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(await screen.findByText("Ada's laptop")).toBeInTheDocument();
    expect(screen.getByText("Expires")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(fetch).toHaveBeenCalledWith(
      "/api/cli/device-authorizations/pending?user_code=ABCD-EFGH",
      expect.objectContaining({ credentials: "same-origin", mode: "same-origin" })
    );
  });

  it("posts only the code after approval and focuses the success status", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    render(
      <CliDeviceAuthorization
        userCode="ABCD-EFGH"
        user={{ name: "Ada", email: "ada@example.com" }}
      />
    );

    const approve = screen.getByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve).toBeEnabled());
    await user.click(approve);

    expect(fetch).toHaveBeenLastCalledWith("/api/cli/device-authorizations/approve", {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: "ABCD-EFGH" }),
    });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("CLI authorized");
    await waitFor(() => expect(status).toHaveFocus());
  });

  it.each([
    [404, "This authorization code is invalid."],
    [409, "This authorization code has already been used."],
    [410, "This authorization code has expired."],
  ])("shows and focuses the %i error state", async (statusCode, message) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(Response.json({ error: "safe_code" }, { status: statusCode }));
    const user = userEvent.setup();
    render(
      <CliDeviceAuthorization
        userCode="ABCD-EFGH"
        user={{ name: "Ada", email: "ada@example.com" }}
      />
    );

    const approve = screen.getByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve).toBeEnabled());
    await user.click(approve);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("cancels without approving and provides close guidance", async () => {
    vi.mocked(fetch).mockResolvedValue(pendingResponse());
    const user = userEvent.setup();
    render(
      <CliDeviceAuthorization
        userCode="ABCD-EFGH"
        user={{ name: "Ada", email: "ada@example.com" }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(window.close).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Authorization cancelled. You can close this window."
    );
  });

  it.each([
    [404, "This authorization code is invalid."],
    [409, "This authorization code has already been used."],
    [410, "This authorization code has expired."],
  ])("does not allow consent when pending lookup returns %i", async (status, message) => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
    render(
      <CliDeviceAuthorization
        userCode="ABCD-EFGH"
        user={{ name: "Ada", email: "ada@example.com" }}
      />
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });
});
