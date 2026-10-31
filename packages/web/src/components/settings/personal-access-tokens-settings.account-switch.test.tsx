// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "@/app/(app)/settings/page";
import { AppAuthBoundary } from "@/components/app-auth-boundary";
import { useAuthSession } from "@/lib/auth-session";
import { SettingsShell } from "./settings-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams("tab=access-tokens"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

expect.extend(matchers);

const A = "11111111111111111111111111111111";
const B = "22222222222222222222222222222222";
const SECRET = `oi_pat_${"a1".repeat(32)}`;
const TOKEN = {
  id: "token-a",
  name: "Account A laptop",
  displayPrefix: "oi_pat_a1b2c3",
  permissions: ["sessions.read"],
  createdAt: Date.now(),
  lastUsedAt: null,
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function authorization(userId: string) {
  return {
    userId,
    suspendedAt: null,
    role: { id: "role_builtin_member", key: "member", name: "Member" },
    permissions: ["sessions.read"],
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
});

async function setup(cachedB: boolean, action: "issue" | "revoke" = "issue") {
  let account = cachedB ? B : A;
  let holdAuthorization = false;
  const pendingAuthorization = deferred<Response>();
  const pendingIssue = deferred<Response>();
  const pendingRevoke = deferred<Response>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/auth/get-session") {
      return Response.json({
        user: { id: account, name: account === A ? "Alice" : "Bob" },
        session: { id: `session-${account}`, userId: account, expiresAt: "2030-01-01" },
      });
    }
    if (path === "/api/me/authorization") {
      return holdAuthorization
        ? pendingAuthorization.promise
        : Response.json(authorization(account));
    }
    if (path === "/api/me/teams") return Response.json({ teams: [] });
    if (path === "/api/personal-access-tokens/policy") {
      return Response.json({ enabled: true, maxLifetimeDays: null, allowedPermissions: null });
    }
    if (path === "/api/personal-access-tokens") {
      if (init?.method === "POST") return pendingIssue.promise;
      return Response.json({ tokens: account === A ? [TOKEN] : [] });
    }
    if (path === `/api/personal-access-tokens/${TOKEN.id}` && init?.method === "DELETE") {
      return pendingRevoke.promise;
    }
    throw new Error(`Unexpected fetch: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  let mutate!: ReturnType<typeof useSWRConfig>["mutate"];
  let mounts = 0;
  function Harness() {
    mutate = useSWRConfig().mutate;
    const { data } = useAuthSession();
    return (
      <>
        <output data-testid="account">{data?.user.id}</output>
        <AppAuthBoundary>
          <SettingsShell>
            <MountProbe />
            <SettingsPage />
          </SettingsShell>
        </AppAuthBoundary>
      </>
    );
  }
  function MountProbe() {
    useEffect(() => {
      mounts++;
    }, []);
    return null;
  }
  render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
      }}
    >
      <Harness />
    </SWRConfig>
  );
  await screen.findByRole("button", { name: /New token/ });

  async function switchAccount(userId: string) {
    account = userId;
    await act(async () => {
      await mutate("/api/auth/get-session");
    });
    expect(screen.getByTestId("account")).toHaveTextContent(userId);
  }
  if (cachedB) {
    // Seed B through a real visit, not by fabricating a cached authorization grant.
    await switchAccount(A);
    await screen.findByRole("button", { name: /New token/ });
  }
  const user = userEvent.setup();
  if (action === "issue") {
    await user.click(screen.getByRole("button", { name: /New token/ }));
    await user.type(screen.getByLabelText("Name"), TOKEN.name);
    await user.click(screen.getByLabelText("Read sessions"));
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  } else {
    await user.click(await screen.findByRole("button", { name: `Revoke ${TOKEN.name}` }));
  }

  return {
    async finishIssue(status = 200) {
      await act(async () => {
        pendingIssue.resolve(
          Response.json(
            status === 200 ? { ...TOKEN, token: SECRET } : { error: "Account A issuance error" },
            { status }
          )
        );
      });
    },
    async finishRevoke(status: number) {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/personal-access-tokens/${TOKEN.id}`,
        expect.objectContaining({ method: "DELETE" })
      );
      await act(async () => {
        pendingRevoke.resolve(Response.json({ error: "Account A revoke error" }, { status }));
      });
    },
    async switchToB() {
      const previousMounts = mounts;
      holdAuthorization = true;
      await switchAccount(B);
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([path]) => path === "/api/me/authorization").length
        ).toBeGreaterThan(cachedB ? 2 : 1)
      );
      if (cachedB) {
        // Cached authorization keeps the actual settings tree mounted throughout the switch.
        expect(
          screen.getByRole("heading", { name: "Access tokens", hidden: true })
        ).toBeInTheDocument();
        expect(mounts).toBe(previousMounts);
      } else {
        expect(screen.getByRole("status", { name: "Checking authorization" })).toBeInTheDocument();
      }
    },
    async finishAuthorization() {
      await act(async () => {
        pendingAuthorization.resolve(Response.json(authorization(B)));
      });
      await screen.findByRole("button", { name: /New token/ });
    },
  };
}

describe.each([true, false])("account switch with cached B authorization: %s", (cachedB) => {
  it.each(["before", "after"])(
    "discards A's secret when issuance resolves %s the switch",
    async (timing) => {
      const harness = await setup(cachedB);
      if (timing === "before") {
        await harness.finishIssue();
        expect(await screen.findByTestId("issued-access-token")).toHaveTextContent(SECRET);
      }
      await harness.switchToB();
      if (timing === "after") await harness.finishIssue();

      expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await harness.finishAuthorization();
      expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(false);
    }
  );
});

describe("account-scoped token actions", () => {
  it("does not restore A's draft or show its issuance error after switching to cached B", async () => {
    const harness = await setup(true);
    await harness.switchToB();
    await harness.finishIssue(400);

    expect(toast.getToasts()).toEqual([]);
    expect(screen.queryByRole("form", { name: "New access token" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New token/ })).toBeEnabled();
    await harness.finishAuthorization();
  });

  it("discards A's revoke confirmation when switching to cached B", async () => {
    const harness = await setup(true, "revoke");
    expect(screen.getByRole("alertdialog")).toHaveTextContent(TOKEN.name);
    await harness.switchToB();

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await harness.finishAuthorization();
  });

  it.each([200, 400])(
    "ignores A's pending revoke completion (%s) after switching to cached B",
    async (status) => {
      const harness = await setup(true, "revoke");
      await userEvent.setup().click(screen.getByRole("button", { name: "Revoke" }));
      await harness.switchToB();
      await harness.finishRevoke(status);

      expect(toast.getToasts()).toEqual([]);
      await harness.finishAuthorization();
    }
  );
});
