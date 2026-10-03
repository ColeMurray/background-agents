// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveTeamProvider, useActiveTeam } from "@/hooks/use-active-team";
import { useMeTeams } from "@/hooks/use-teams";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { TeamsSettings } from "./teams-settings";

const USER_ID = "11111111111111111111111111111111";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: USER_ID } }, status: "authenticated" }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

let requireTeamOnCreate = false;

beforeEach(() => {
  requireTeamOnCreate = false;
  vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
    switch (path) {
      case "/api/me/authorization":
        return Response.json({
          userId: USER_ID,
          suspendedAt: null,
          role: { id: "role_builtin_administrator", key: "administrator", name: "Administrator" },
          permissions: ["sessions.read", "sessions.create", "workspace.members.manage"],
        });
      case "/api/settings/teams":
        if (init?.method === "PATCH") {
          requireTeamOnCreate = JSON.parse(String(init.body)).requireTeamOnCreate;
        }
        return Response.json({ requireTeamOnCreate });
      case "/api/me/teams":
        return Response.json({ teams: [], requireTeamOnCreate });
      case "/api/teams":
        return Response.json({ teams: [] });
      default:
        throw new Error(`Unexpected request: ${String(path)}`);
    }
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The settings shell reads memberships too, so the membership cache is populated while
// the policy is edited, as it is in the app.
function SettingsPage() {
  const memberships = useMeTeams();
  return (
    <>
      <output data-testid="memberships">{memberships.hasData ? "loaded" : "pending"}</output>
      <TeamsSettings />
    </>
  );
}

function ComposerPolicy() {
  const context = useActiveTeam();
  return (
    <output data-testid="composer-policy">
      {context.loading ? "loading" : `requireTeamOnCreate=${context.requireTeamOnCreate}`}
    </output>
  );
}

describe("Teams settings require-team policy", () => {
  it.each([true, false])(
    "applies requireTeamOnCreate=%s to the session composer after navigating away",
    async (next) => {
      requireTeamOnCreate = !next;
      const cache: Cache = new Map();
      function App({ page }: { page: "settings" | "home" }) {
        return (
          <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
            {page === "settings" ? (
              <SettingsPage />
            ) : (
              <ActiveTeamProvider>
                <ComposerPolicy />
              </ActiveTeamProvider>
            )}
          </SWRConfig>
        );
      }

      const view = render(<App page="settings" />);
      const toggle = await screen.findByRole("switch", { name: "Require a team for new sessions" });
      await waitFor(() => expect(screen.getByTestId("memberships").textContent).toBe("loaded"));
      await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
      expect(toggle.getAttribute("aria-checked")).toBe(String(!next));
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe(String(next)));
      await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));

      view.rerender(<App page="home" />);

      // The first ready composer render must use the saved policy, not the pre-save snapshot.
      expect(screen.getByTestId("composer-policy").textContent).toBe(`requireTeamOnCreate=${next}`);
    }
  );
});
