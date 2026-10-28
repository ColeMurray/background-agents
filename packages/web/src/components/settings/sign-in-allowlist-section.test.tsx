// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdmissionRules,
  type AdmissionPolicySnapshot,
} from "@open-inspect/shared/admission-settings";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { SignInAllowlistSection } from "./sign-in-allowlist-section";

expect.extend(matchers);
const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate }) }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({
    data: { user: { id: "11111111111111111111111111111111" } },
    status: "authenticated",
  }),
  clearAuthSessionCache: vi.fn(),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  currentUserAuthorizationKey: (id: string) => ["/api/me/authorization", id],
  useCurrentUserAuthorization: () => ({
    authorization: {
      userId: "11111111111111111111111111111111",
      suspendedAt: null,
      role: { id: "role_builtin_owner", key: "owner", name: "Owner" },
    },
    hasPermission: () => true,
  }),
}));

const initial: AdmissionPolicySnapshot = {
  deployment: { ...emptyAdmissionRules(), allowedEmails: ["recovery@example.com"] },
  managed: emptyAdmissionRules(),
  effective: { ...emptyAdmissionRules(), allowedEmails: ["recovery@example.com"] },
  revision: 0,
  etag: '"policy-0"',
  updatedAt: null,
  updatedByUserId: null,
  enabledProviders: ["google"],
  unsafeAllowAllUsers: false,
  unsafeAllowAllEffective: false,
  editingDisabledReason: null,
};
function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
async function renderPolicy(snapshot = initial) {
  vi.mocked(browserApiFetch).mockResolvedValueOnce(json(snapshot));
  render(<SignInAllowlistSection />);
  await screen.findByText("Configured sign-in providers:");
}
function addEmail(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mutate.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SignInAllowlistSection", () => {
  it("explains OR semantics, verified evidence, providers, and deployment ownership", async () => {
    await renderPolicy();
    expect(screen.getByText(/any rule matches \(OR\)/)).toBeInTheDocument();
    expect(screen.getByText(/Email rules require verified provider evidence/)).toBeInTheDocument();
    expect(screen.getByText(/GitHub sign-in is not configured/)).toBeInTheDocument();
    expect(
      screen.getByText(/No rules added in settings; deployment rules still apply/)
    ).toBeInTheDocument();
    expect(screen.getByText("Deployment", { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Remove settings email address recovery/ })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
  });

  it("validates inline, normalizes draft entries, and keeps duplicates a no-op", async () => {
    await renderPolicy();
    addEmail("not an email");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email address" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
    addEmail(" NEW@Example.com ");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    addEmail("new@example.com");
    expect(screen.getAllByText("new@example.com")).toHaveLength(1);
    expect(screen.getByText(/1 added, 0 removed/)).toBeInTheDocument();
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
  });

  it("removes only the settings copy of a dual-source rule and reviews its continuing deployment grant", async () => {
    await renderPolicy({
      ...initial,
      managed: { ...emptyAdmissionRules(), allowedEmails: ["recovery@example.com"] },
    });
    expect(screen.getByText("Both", { exact: true })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove settings email address recovery@example.com" })
    );
    expect(screen.getByText("recovery@example.com")).toBeInTheDocument();
    expect(screen.getByText("Deployment", { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(/still allow sign-in through deployment configuration/)
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/do not suspend members or revoke existing sessions/)
    ).toBeInTheDocument();
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Email domain", " EXAMPLE.com ", "example.com", true],
    ["GitHub username", " OctoCat ", "octocat", false],
    ["GitHub organization", " MY-ORG ", "my-org", true],
  ] as const)(
    "adds a normalized %s and reviews broad access when applicable",
    async (label, value, normalized, broad) => {
      const user = userEvent.setup();
      await renderPolicy();
      await user.click(screen.getByRole("combobox", { name: "Rule type" }));
      await user.click(await screen.findByRole("option", { name: label }));
      fireEvent.change(screen.getByRole("textbox", { name: label }), {
        target: { value },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
      expect(screen.getByText(normalized, { exact: true })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
      const dialog = screen.getByRole("alertdialog");
      expect(
        within(dialog).queryAllByText(
          /Adding a domain admits all matching verified email identities/
        )
      ).toHaveLength(broad ? 1 : 0);
      expect(browserApiFetch).toHaveBeenCalledTimes(1);
    }
  );

  it("warns about a broader domain that remains after removing an exact email", async () => {
    await renderPolicy({
      ...initial,
      managed: {
        ...emptyAdmissionRules(),
        allowedEmails: ["person@example.com"],
        allowedEmailDomains: ["example.com"],
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove settings email address person@example.com" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    expect(
      within(screen.getByRole("alertdialog")).getByText(/allowed email domain still covers/)
    ).toBeInTheDocument();
  });

  it("requires confirmation before saving and announces no invitation or member creation", async () => {
    await renderPolicy();
    addEmail("new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
    expect(
      within(screen.getByRole("alertdialog")).getByText(/No invitation is sent/)
    ).toBeInTheDocument();
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      json({
        ...initial,
        managed: { ...emptyAdmissionRules(), allowedEmails: ["new@example.com"] },
        revision: 1,
        etag: '"policy-1"',
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
    await screen.findByText(/Sign-in allowlist saved/);
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
    expect(
      screen.getByText(/No invitation was sent and no member was created/)
    ).toBeInTheDocument();
  });

  it("confirms cancel before discarding unsaved changes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderPolicy();
    addEmail("new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved sign-in allowlist changes?");
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("new@example.com")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
  });

  it.each(["maintenance", "unsafe_allow_all"] as const)(
    "explains read-only %s without presenting an add form",
    async (reason) => {
      await renderPolicy({
        ...initial,
        editingDisabledReason: reason,
        unsafeAllowAllUsers: reason === "unsafe_allow_all",
      });
      expect(screen.queryByRole("button", { name: "Add rule" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
      expect(
        screen.getByText(
          reason === "maintenance" ? /operator-managed maintenance/ : /Disable unsafe allow-all/
        )
      ).toBeInTheDocument();
    }
  );

  it("shows initial failures as unavailable, with Retry and no empty editor", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json({}, 503));
    render(<SignInAllowlistSection />);
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
    expect(screen.queryByRole("button", { name: "Add rule" })).not.toBeInTheDocument();
    expect(screen.queryByText(/No rules added in settings/)).not.toBeInTheDocument();
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json(initial));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add rule" })).toBeInTheDocument()
    );
  });

  it("keeps the conflict draft visible and exposes an explicit reload/review action", async () => {
    await renderPolicy();
    addEmail("new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json({}, 412));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
    await screen.findByRole("button", { name: "Reload current rules for review" });
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });
});
