// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { permissionsForBuiltInRole } from "@open-inspect/shared/rbac";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { CollaboratorsSection } from "./collaborators-section";

expect.extend(matchers);
vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const OWNER = "11111111111111111111111111111111";
const ADA = "22222222222222222222222222222222";
const GRACE = "33333333333333333333333333333333";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuthSession).mockReturnValue({
    status: "authenticated",
    data: { user: { id: OWNER, name: "Owner" } },
  });
});
afterEach(cleanup);

describe("collaborator directory authorization boundary", () => {
  it.each(["member", "administrator"] as const)(
    "offers scoped candidates to a built-in %s session owner regardless of directory permission",
    async (role) => {
      const permissions = permissionsForBuiltInRole(role);
      expect(permissions.includes("workspace.members.read")).toBe(role === "administrator");
      vi.mocked(browserApiFetch).mockImplementation(async (path) => {
        if (path === "/api/sessions/private_session/collaborator-candidates") {
          return Response.json(
            [
              { userId: ADA, displayName: "Ada" },
              { userId: GRACE, displayName: "Grace" },
            ].map((user) => ({
              ...user,
              email: null,
              avatarUrl: null,
            }))
          );
        }
        return Response.json({ status: "updated" });
      });
      const onUpdated = vi.fn().mockResolvedValue(undefined);
      render(
        <CollaboratorsSection
          sessionId="private_session"
          ownerUserId={OWNER}
          collaborators={[ADA]}
          canManageCollaborators
          onUpdated={onUpdated}
        />,
        { wrapper }
      );
      expect(await screen.findByText("Ada")).toBeInTheDocument();
      expect(browserApiFetch).toHaveBeenCalledWith(
        "/api/sessions/private_session/collaborator-candidates"
      );
      fireEvent.change(screen.getByRole("combobox", { name: "Add collaborator" }), {
        target: { value: GRACE },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
      expect(browserApiFetch).toHaveBeenCalledWith(
        `/api/sessions/private_session/collaborators/${GRACE}`,
        { method: "PUT" }
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
      await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2));
      expect(browserApiFetch).toHaveBeenCalledWith(
        `/api/sessions/private_session/collaborators/${ADA}`,
        { method: "DELETE" }
      );
      expect(browserApiFetch).not.toHaveBeenCalledWith("/api/members");
      expect(browserApiFetch).not.toHaveBeenCalledWith("/api/me/authorization");
      expect(screen.queryByText(/directory is not available/i)).toBeNull();
    }
  );

  it("does not request picker identities without the session capability", () => {
    render(
      <CollaboratorsSection
        sessionId="private_session"
        ownerUserId={OWNER}
        collaborators={[ADA]}
        canManageCollaborators={false}
        onUpdated={vi.fn()}
      />,
      { wrapper }
    );
    expect(screen.queryByText("Collaborators")).toBeNull();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it.each([403, 404])("disables adding when the scoped endpoint returns %s", async (status) => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ error: "Denied" }, { status }));
    render(
      <CollaboratorsSection
        sessionId="private_session"
        ownerUserId={OWNER}
        collaborators={[ADA]}
        canManageCollaborators
        onUpdated={vi.fn()}
      />,
      { wrapper }
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load workspace members");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Remove ${ADA}` })).toBeEnabled();
    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/sessions/private_session/collaborator-candidates"
    );
    expect(browserApiFetch).not.toHaveBeenCalledWith("/api/members");
  });

  it("keys picker reads by the encoded session identity", async () => {
    vi.mocked(browserApiFetch).mockImplementation(async () => Response.json([]));
    const props = {
      ownerUserId: OWNER,
      collaborators: [],
      canManageCollaborators: true,
      onUpdated: vi.fn(),
    };
    const { rerender } = render(<CollaboratorsSection {...props} sessionId="private/session" />, {
      wrapper,
    });
    await waitFor(() =>
      expect(browserApiFetch).toHaveBeenCalledWith(
        "/api/sessions/private%2Fsession/collaborator-candidates"
      )
    );
    rerender(<CollaboratorsSection {...props} sessionId="another/session" />);
    await waitFor(() =>
      expect(browserApiFetch).toHaveBeenCalledWith(
        "/api/sessions/another%2Fsession/collaborator-candidates"
      )
    );
  });

  it("disables adding if picker identities fail the shared response contract", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json([{ userId: GRACE }]));
    render(
      <CollaboratorsSection
        sessionId="private_session"
        ownerUserId={OWNER}
        collaborators={[ADA]}
        canManageCollaborators
        onUpdated={vi.fn()}
      />,
      { wrapper }
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load workspace members");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Remove ${ADA}` })).toBeEnabled();
  });
});
