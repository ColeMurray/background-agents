// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdmissionRules,
  type AdmissionPolicySnapshot,
} from "@open-inspect/shared/admission-settings";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { SignInAllowlistSection } from "./sign-in-allowlist-section";
import {
  SettingsNavigationGuardProvider,
  useConfirmSettingsNavigation,
} from "./settings-navigation-guard";

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
const ADD_LABEL = "Add an email, domain, or GitHub name";

async function renderPolicy(snapshot = initial) {
  vi.mocked(browserApiFetch).mockResolvedValueOnce(json(snapshot));
  render(<SignInAllowlistSection />);
  await screen.findByText(/Set in your deployment config/);
}
function NavigationProbe({ onLeave }: { onLeave: () => void }) {
  const confirmNavigation = useConfirmSettingsNavigation();
  return <button onClick={() => confirmNavigation() && onLeave()}>Leave settings</button>;
}
async function renderGuardedPolicy() {
  const onLeave = vi.fn();
  vi.mocked(browserApiFetch).mockResolvedValueOnce(json(initial));
  render(
    <SettingsNavigationGuardProvider>
      <NavigationProbe onLeave={onLeave} />
      <SignInAllowlistSection />
    </SettingsNavigationGuardProvider>
  );
  await screen.findByRole("combobox", { name: ADD_LABEL });
  return onLeave;
}
function typeRule(value: string) {
  const input = screen.getByRole("combobox", { name: ADD_LABEL });
  act(() => input.focus());
  fireEvent.change(input, { target: { value } });
  return input;
}
/** Types a value and accepts the first suggestion with Enter. */
function addRule(value: string) {
  fireEvent.keyDown(typeRule(value), { key: "Enter" });
}
function openReview() {
  fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
  return screen.getByRole("alertdialog");
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
  it("protects typed values before Add and stops warning when they are cleared", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onLeave = await renderGuardedPolicy();
    const input = typeRule("unfinished");
    fireEvent.click(screen.getByRole("button", { name: "Leave settings" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(onLeave).not.toHaveBeenCalled();
    expect(input).toHaveValue("unfinished");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    fireEvent.change(input, { target: { value: "" } });
    confirm.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Leave settings" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it.each([412, 503])(
    "keeps the draft and reload requirement after a %s save when navigation is cancelled",
    async (status) => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      const onLeave = await renderGuardedPolicy();
      addRule("new@example.com");
      openReview();
      vi.mocked(browserApiFetch).mockResolvedValueOnce(json({}, status));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await screen.findByRole("button", { name: "Reload rules" });
      fireEvent.click(screen.getByRole("button", { name: "Leave settings" }));
      expect(onLeave).not.toHaveBeenCalled();
      expect(screen.getByText("new@example.com")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
      expect(browserApiFetch).toHaveBeenCalledTimes(2);
      expect(vi.mocked(browserApiFetch).mock.calls[1][1]?.headers).toMatchObject({
        "If-Match": initial.etag,
      });
    }
  );

  it("shows one quiet list with read-only deployment rules and no save controls", async () => {
    await renderPolicy();
    expect(screen.getByText(/Only people who match something on this list/)).toBeInTheDocument();
    expect(screen.getByText("recovery@example.com")).toBeInTheDocument();
    const lock = screen.getByRole("img", {
      name: "Set by deployment: ALLOWED_EMAILS / allowed_emails",
    });
    expect(lock).toHaveAttribute("tabindex", "0");
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review and save" })).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub sign-in is off/)).not.toBeInTheDocument();
    expect(document.body.textContent!.split(/\s+/).length).toBeLessThan(60);
  });

  it("warns when GitHub rules exist but GitHub sign-in is off", async () => {
    await renderPolicy({
      ...initial,
      deployment: { ...initial.deployment, allowedGitHubUsers: ["octocat"] },
    });
    expect(screen.getByText(/GitHub sign-in is off/)).toBeInTheDocument();
  });

  it("validates inline, normalizes draft entries, and keeps duplicates a no-op", async () => {
    await renderPolicy();
    addRule("person@bad_domain");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: ADD_LABEL })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
    addRule(" NEW@Example.com ");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
    addRule("new@example.com");
    expect(screen.getAllByText("new@example.com")).toHaveLength(1);
    expect(screen.getByText(/1 unsaved change/)).toHaveTextContent("1 added");
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
  });

  it("ignores Enter that confirms an IME composition", async () => {
    await renderPolicy();
    const input = typeRule("new@example.com");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(input).toHaveValue("new@example.com");
    expect(screen.queryByRole("button", { name: "Review and save" })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Review and save" })).toBeInTheDocument();
  });

  it("clears typed input with Escape", async () => {
    await renderPolicy();
    const input = typeRule("octocat");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("removes only the settings copy of a dual-source rule and reviews its continuing deployment grant", async () => {
    await renderPolicy({
      ...initial,
      managed: { ...emptyAdmissionRules(), allowedEmails: ["recovery@example.com"] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove settings copy of recovery@example.com" })
    );
    expect(screen.getByText("recovery@example.com")).not.toHaveClass("line-through");
    expect(
      screen.getByRole("button", { name: "Undo removing recovery@example.com" })
    ).toBeInTheDocument();
    const dialog = openReview();
    expect(within(dialog).getByText(/Deployment still allows this entry/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Existing sessions stay active/)).toBeInTheDocument();
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
  });

  it("strikes through a pending removal and restores it with Undo", async () => {
    await renderPolicy({
      ...initial,
      managed: { ...emptyAdmissionRules(), allowedGitHubUsers: ["octocat"] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove octocat on GitHub" }));
    expect(screen.getByText("octocat on GitHub")).toHaveClass("line-through");
    expect(screen.getByText(/1 unsaved change/)).toHaveTextContent("1 removed");
    fireEvent.click(screen.getByRole("button", { name: "Undo removing octocat on GitHub" }));
    expect(screen.getByText("octocat on GitHub")).not.toHaveClass("line-through");
    expect(screen.queryByRole("button", { name: "Review and save" })).not.toBeInTheDocument();
  });

  it.each([
    ["an email domain", " @EXAMPLE.com ", null, "Anyone with an @example.com email", true],
    ["a GitHub user", " OctoCat ", /GitHub user OctoCat/, "octocat on GitHub", false],
    ["a GitHub organization", " MY-ORG ", /MY-ORG GitHub org/, "Members of my-org on GitHub", true],
  ] as const)(
    "adds %s from free-form input and reviews broad access when applicable",
    async (_kind, value, option, description, broad) => {
      await renderPolicy();
      if (option) {
        typeRule(value);
        fireEvent.click(screen.getByRole("option", { name: option }));
      } else {
        addRule(value);
      }
      expect(screen.getByText(description, { exact: true })).toBeInTheDocument();
      const dialog = openReview();
      expect(within(dialog).queryAllByText(/(?:Domain|Organization) rules allow all/)).toHaveLength(
        broad ? 1 : 0
      );
      expect(browserApiFetch).toHaveBeenCalledTimes(1);
    }
  );

  it("offers GitHub user or organization for a bare name and supports keyboard choice", async () => {
    await renderPolicy();
    const input = typeRule("my-org");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Allow GitHub user my-org",
      "Allow everyone in the my-org GitHub orgMembers need a verified email",
    ]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Members of my-org on GitHub")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("warns about a broader domain that remains after removing an exact email", async () => {
    await renderPolicy({
      ...initial,
      managed: {
        ...emptyAdmissionRules(),
        allowedEmails: ["person@example.com"],
        allowedEmailDomains: ["example.com"],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove person@example.com" }));
    expect(
      within(openReview()).getByText(/A domain rule still allows this email/)
    ).toBeInTheDocument();
  });

  it("requires confirmation before saving and announces success", async () => {
    await renderPolicy();
    addRule("new@example.com");
    const dialog = openReview();
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByText(/Deployment rules will not change/)).toBeInTheDocument();
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      json({
        ...initial,
        managed: { ...emptyAdmissionRules(), allowedEmails: ["new@example.com"] },
        revision: 1,
        etag: '"policy-1"',
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Rules saved.");
    expect(screen.queryByRole("button", { name: "Review and save" })).not.toBeInTheDocument();
    expect(screen.queryByText("New")).not.toBeInTheDocument();
  });

  it("blocks saving while a typed value is pending", async () => {
    await renderPolicy();
    addRule("new@example.com");
    typeRule("other@example.com");
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
    expect(screen.getByText(/Add or clear the typed value/)).toBeInTheDocument();
  });

  it("treats whitespace-only typed input as unsaved", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onLeave = await renderGuardedPolicy();
    addRule("new@example.com");
    typeRule("   ");
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Leave settings" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("confirms before discarding unsaved changes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderPolicy();
    addRule("new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("new@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review and save" })).not.toBeInTheDocument();
  });

  it("does not claim no one can sign in when unsafe allow-all admits everyone", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      json({
        ...initial,
        deployment: emptyAdmissionRules(),
        effective: emptyAdmissionRules(),
        editingDisabledReason: "unsafe_allow_all",
        unsafeAllowAllUsers: true,
        unsafeAllowAllEffective: true,
      })
    );
    render(<SignInAllowlistSection />);
    await screen.findByText("All authenticated users can sign in.");
    expect(screen.queryByText("No one can sign in yet.")).not.toBeInTheDocument();
    expect(screen.getByText(/Unsafe allow-all lets every authenticated user/)).toBeInTheDocument();
  });

  it("explains read-only unsafe allow-all without presenting an add input", async () => {
    await renderPolicy({
      ...initial,
      editingDisabledReason: "unsafe_allow_all",
      unsafeAllowAllUsers: true,
    });
    expect(screen.queryByRole("combobox", { name: ADD_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review and save" })).not.toBeInTheDocument();
    expect(screen.getByText(/disable unsafe allow-all/)).toBeInTheDocument();
  });

  it("shows initial failures as unavailable, with Retry and no empty editor", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json({}, 503));
    render(<SignInAllowlistSection />);
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
    expect(screen.queryByRole("combobox", { name: ADD_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByText("No one can sign in yet.")).not.toBeInTheDocument();
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json(initial));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: ADD_LABEL })).toBeInTheDocument()
    );
  });

  it("keeps the conflict draft visible and exposes an explicit reload/review action", async () => {
    await renderPolicy();
    addRule("new@example.com");
    openReview();
    vi.mocked(browserApiFetch).mockResolvedValueOnce(json({}, 412));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Reload rules" });
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });
});
