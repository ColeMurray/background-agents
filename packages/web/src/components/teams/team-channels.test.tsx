// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamResponse } from "@/hooks/use-teams";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { TeamChannels } from "./team-channels";
import { useSlackChannels } from "@/hooks/use-slack-channels";

expect.extend(matchers);
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user_one" } } }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        focusThrottleInterval: 0,
        shouldRetryOnError: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}

const team: TeamResponse = {
  id: "team/id",
  slug: "design",
  name: "Design",
  description: null,
  joinPolicy: "invite_only",
  defaultVisibility: "team",
  defaultEnvironmentId: null,
  grantsVersion: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  memberCount: 1,
  capabilities: {
    canJoin: false,
    canLeave: false,
    canEditMetadata: false,
    canManageMembers: false,
    canManageRepositories: false,
    canManageBindings: true,
    canManageAutomations: false,
    canManageEnvironments: false,
    canManageSecrets: false,
    canArchive: false,
  },
};
const key = "/api/teams/team%2Fid/channel-bindings";
const channelsKey = "/api/teams/team%2Fid/slack-channels";
const channels = [
  { id: "C_HOME", name: "home", isMember: true, isPrivate: false },
  { id: "C_SOURCE", name: "source", isMember: true, isPrivate: true },
  { id: "C_NEW/ID", name: "design-announcements", isMember: true, isPrivate: false },
  { id: "C_SHARED", name: "partner-shared", isMember: true, isPrivate: false },
  { id: "C_UNJOINED", name: "unjoined", isMember: false, isPrivate: false },
];
const bindings = [
  { provider: "slack", externalId: "C_HOME", teamId: team.id, kind: "primary" },
  { provider: "slack", externalId: "C_SOURCE", teamId: team.id, kind: "source" },
  { provider: "linear", externalId: "linear_team", teamId: team.id, kind: "source" },
];
let listedBindings = bindings.slice(0, 0);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.resetAllMocks();
  listedBindings = [];
  vi.mocked(browserApiFetch).mockImplementation(async (url) =>
    Response.json(url === channelsKey ? { channels } : { bindings: listedBindings })
  );
});
afterEach(cleanup);

describe("Team channels", () => {
  it.each([
    undefined,
    {},
    { canManageBindings: true },
    { ...team.capabilities, canManageBindings: false },
  ])(
    "does not fetch bindings or enable controls without complete server capabilities: %s",
    (capabilities) => {
      render(<TeamChannels team={{ ...team, capabilities }} />, { wrapper });
      expect(browserApiFetch).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /Slack channel Select a channel/ })).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "Binding kind" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Bind channel" })).toBeDisabled();
      expect(screen.getByText(/do not have permission to view or manage/i)).toBeInTheDocument();
    }
  );

  it("searches channel names, binds the selected ID as primary and refreshes", async () => {
    listedBindings = [bindings[0]];
    render(<TeamChannels team={team} />, { wrapper });
    await screen.findByText("#home");
    expect(screen.getByRole("button", { name: "Bind channel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Slack channel Select a channel/ }));
    expect(screen.queryByRole("option", { name: "#unjoined" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /#source.*Private channel/ })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search channels..."), {
      target: { value: "ANNOUNCE" },
    });
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: "#design-announcements" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Binding kind" }), {
      target: { value: "primary" },
    });
    let finish!: (response: Response) => void;
    const mutation = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    vi.mocked(browserApiFetch).mockReturnValueOnce(mutation);
    fireEvent.click(screen.getByRole("button", { name: "Bind channel" }));
    expect(
      screen.getByRole("button", { name: /Slack channel #design-announcements/ })
    ).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Binding kind" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unbind Slack channel #home" })).toBeDisabled();
    await act(async () => {
      listedBindings = [{ ...bindings[0], externalId: "C_NEW/ID", kind: "primary" }];
      finish(Response.json({ ok: true }));
    });
    expect(await screen.findByText("#design-announcements")).toBeInTheDocument();
    expect(browserApiFetch).toHaveBeenCalledWith(channelsKey);
    expect(browserApiFetch).toHaveBeenCalledWith(`${key}/slack/C_NEW%2FID`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "primary" }),
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Slack channel Select a channel/ })).toBeEnabled()
    );
  });

  it("unbinds Slack channels and reloads the authoritative list", async () => {
    listedBindings = bindings;
    render(<TeamChannels team={team} />, { wrapper });
    const unbind = await screen.findByRole("button", { name: "Unbind Slack channel #home" });
    const rows = within(screen.getByRole("list", { name: "Channel bindings" }));
    expect(rows.getByText("#home")).toBeInTheDocument();
    expect(rows.getByText("Primary")).toBeInTheDocument();
    expect(rows.getAllByText("Source")).toHaveLength(2);
    expect(rows.getByText("linear_team")).toBeInTheDocument();
    expect(rows.queryByRole("button", { name: /Unbind.*linear_team/ })).not.toBeInTheDocument();
    expect(browserApiFetch).toHaveBeenCalledWith(key);
    listedBindings = [];
    vi.mocked(browserApiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    fireEvent.click(unbind);
    await screen.findByText("No channel bindings yet.");
    expect(browserApiFetch).toHaveBeenCalledWith(`${key}/slack/C_HOME`, { method: "DELETE" });
    expect(screen.queryByText("#home")).not.toBeInTheDocument();
  });

  it("shows server refusal codes without clearing the draft or claiming success", async () => {
    render(<TeamChannels team={team} />, { wrapper });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Slack channel Select a channel/ })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /Slack channel Select a channel/ }));
    fireEvent.click(screen.getByRole("option", { name: "#partner-shared" }));
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json(
        { error: "Channel is not joinable", code: "channel_not_joinable" },
        { status: 409 }
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Bind channel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("channel_not_joinable");
    expect(screen.getByRole("button", { name: /Slack channel #partner-shared/ })).toBeEnabled();
    expect(browserApiFetch).toHaveBeenCalledTimes(3);
  });

  it("withholds cached rows immediately when capabilities are revoked", async () => {
    listedBindings = bindings;
    const view = render(<TeamChannels team={team} />, { wrapper });
    await screen.findByText("#home");
    fireEvent.click(screen.getByRole("button", { name: /Slack channel Select a channel/ }));
    vi.mocked(browserApiFetch).mockClear();
    view.rerender(<TeamChannels team={{ ...team, capabilities: undefined }} />);
    expect(screen.queryByText("#home")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /#source.*Private channel/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("linear_team")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bind channel" })).toBeDisabled();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("shows a load error rather than an empty list and supports retry", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    render(<TeamChannels team={team} />, { wrapper });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load channel bindings.");
    expect(screen.queryByText("No channel bindings yet.")).not.toBeInTheDocument();
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ bindings: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No channel bindings yet.")).toBeInTheDocument();
  });

  it.each([
    { payload: { channels: [], error: "not_configured" }, status: 200 },
    { payload: { error: "Unavailable" }, status: 503 },
    { payload: { channels: "invalid" }, status: 200 },
  ])(
    "disables binding on channel-list failure and supports retry: %j",
    async ({ payload, status }) => {
      vi.mocked(browserApiFetch).mockImplementation(async (url) =>
        url === channelsKey
          ? Response.json(payload, { status })
          : Response.json({ bindings: listedBindings })
      );
      render(<TeamChannels team={team} />, { wrapper });
      expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load Slack channels.");
      expect(screen.getByRole("button", { name: /Slack channel Select a channel/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Bind channel" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Enter a channel ID instead" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Slack channel ID" }), {
        target: { value: " C_NEW/ID " },
      });
      vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
      fireEvent.click(screen.getByRole("button", { name: "Bind channel" }));
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Slack channel ID" })).toHaveValue("")
      );
      expect(browserApiFetch).toHaveBeenCalledWith(`${key}/slack/C_NEW%2FID`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "source" }),
      });
      vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ channels }));
      fireEvent.click(screen.getByRole("button", { name: "Retry channels" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose from channels" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Slack channel Select a channel/ })).toBeEnabled()
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  );

  it.each([
    ["Retry channels", { channels: [], error: "not_configured" }],
    ["Refresh channels", { channels: [channels[4]] }],
  ] as const)("%s never submits a manual binding draft", async (label, payload) => {
    vi.mocked(browserApiFetch).mockImplementation(async (url) =>
      Response.json(url === channelsKey ? payload : { bindings: [] })
    );
    render(<TeamChannels team={team} />, { wrapper });
    const reload = await screen.findByRole("button", { name: label });
    expect(screen.getByRole("button", { name: /Slack channel Select a channel/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Enter a channel ID instead" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Slack channel ID" }), {
      target: { value: "C_DRAFT" },
    });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ channels }));
    fireEvent.click(reload);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument()
    );
    expect(screen.getByRole("textbox", { name: "Slack channel ID" })).toHaveValue("C_DRAFT");
    fireEvent.click(screen.getByRole("button", { name: "Choose from channels" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Slack channel Select a channel/ })).toBeEnabled()
    );
    expect(vi.mocked(browserApiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each([401, 403])(
    "withholds cached channel names and all controls after a %s revalidation",
    async (status) => {
      listedBindings = bindings;
      render(<TeamChannels team={team} />, { wrapper });
      await screen.findByText("#home");
      fireEvent.click(screen.getByRole("button", { name: /Slack channel Select a channel/ }));
      expect(screen.getByRole("option", { name: /#source.*Private channel/ })).toBeInTheDocument();
      vi.mocked(browserApiFetch).mockImplementation(async (url) =>
        url === channelsKey
          ? Response.json({ error: "Denied" }, { status })
          : Response.json({ bindings })
      );
      fireEvent.focus(window);
      expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load Slack channels.");
      expect(screen.queryByText("#home")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: /#source.*Private channel/ })
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enter a channel ID instead" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Unbind Slack channel C_HOME" })).toBeDisabled();
    }
  );

  it("keeps the global listing endpoint for existing automation callers", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ channels }));
    const { result } = renderHook(() => useSlackChannels(), { wrapper });
    await waitFor(() => expect(result.current.channels).toEqual(channels));
    expect(browserApiFetch).toHaveBeenCalledWith("/api/integrations/slack/channels");
  });
});
