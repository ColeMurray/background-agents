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
import userEvent from "@testing-library/user-event";
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
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});

async function chooseOption(combobox: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: combobox }));
  await user.click(await screen.findByRole("option", { name: option }));
}

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
      expect(screen.getByRole("combobox", { name: "Provider" })).toBeDisabled();
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
    await chooseOption("Binding kind", "Primary");
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
    expect(rows.getByRole("button", { name: "Unbind Linear team linear_team" })).toBeEnabled();
    expect(browserApiFetch).toHaveBeenCalledWith(key);
    listedBindings = [];
    vi.mocked(browserApiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    fireEvent.click(unbind);
    await screen.findByText("No channel bindings yet.");
    expect(browserApiFetch).toHaveBeenCalledWith(`${key}/slack/C_HOME`, { method: "DELETE" });
    expect(screen.queryByText("#home")).not.toBeInTheDocument();
  });

  it.each([200, 401, 403, 503])(
    "binds a manual Linear team without Slack discovery after a %s channel-list failure",
    async (status) => {
      vi.mocked(browserApiFetch).mockImplementation(async (url) =>
        url === channelsKey
          ? Response.json({ channels: [], error: "not_configured" }, { status })
          : Response.json({ bindings: listedBindings })
      );
      render(<TeamChannels team={team} />, { wrapper });
      await screen.findByRole("alert");
      await screen.findByText("No channel bindings yet.");
      expect(screen.getByRole("combobox", { name: "Provider" })).toBeEnabled();
      vi.mocked(browserApiFetch).mockClear();
      await chooseOption("Provider", "Linear");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Search channels...")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Enter a channel ID instead" })).toBeNull();
      expect(screen.getByRole("button", { name: "Bind team" })).toBeDisabled();
      fireEvent.change(screen.getByRole("textbox", { name: "Linear team ID" }), {
        target: { value: " linear/team " },
      });
      await chooseOption("Binding kind", "Primary");
      listedBindings = [{ ...bindings[2], externalId: "linear/team", kind: "primary" }];
      vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
      fireEvent.click(screen.getByRole("button", { name: "Bind team" }));
      await screen.findByRole("button", { name: "Unbind Linear team linear/team" });
      expect(screen.getByRole("textbox", { name: "Linear team ID" })).toHaveValue("");
      expect(browserApiFetch).toHaveBeenCalledWith(`${key}/linear/linear%2Fteam`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "primary" }),
      });
      expect(browserApiFetch).toHaveBeenCalledWith(key);
      expect(browserApiFetch).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Provider" })).toBeEnabled());
      await chooseOption("Provider", "Slack");
      expect(screen.getByRole("button", { name: /^Slack channel/ })).toBeDisabled();
    }
  );

  it("unbinds Linear teams while Slack discovery is denied", async () => {
    listedBindings = bindings;
    vi.mocked(browserApiFetch).mockImplementation(async (url) =>
      url === channelsKey
        ? Response.json({ error: "Forbidden" }, { status: 403 })
        : Response.json({ bindings: listedBindings })
    );
    render(<TeamChannels team={team} />, { wrapper });
    await screen.findByRole("alert");
    const unbind = await screen.findByRole("button", { name: "Unbind Linear team linear_team" });
    expect(unbind).toBeEnabled();
    await chooseOption("Provider", "Linear");
    expect(screen.getByRole("button", { name: "Unbind Slack channel C_HOME" })).toBeDisabled();
    vi.mocked(browserApiFetch).mockClear();
    listedBindings = [];
    vi.mocked(browserApiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    fireEvent.click(unbind);
    await screen.findByText("No channel bindings yet.");
    expect(browserApiFetch).toHaveBeenCalledWith(`${key}/linear/linear_team`, { method: "DELETE" });
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it("does not wait for Slack discovery to create or unbind a Linear team", async () => {
    let finishDiscovery!: (response: Response) => void;
    const discovery = new Promise<Response>((resolve) => {
      finishDiscovery = resolve;
    });
    vi.mocked(browserApiFetch).mockImplementation(async (url) =>
      url === channelsKey ? discovery : Response.json({ bindings: listedBindings })
    );
    render(<TeamChannels team={team} />, { wrapper });
    await screen.findByText("No channel bindings yet.");
    await chooseOption("Provider", "Linear");
    fireEvent.change(screen.getByRole("textbox", { name: "Linear team ID" }), {
      target: { value: "linear_team" },
    });
    listedBindings = [bindings[2]];
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
    fireEvent.click(screen.getByRole("button", { name: "Bind team" }));
    const unbind = await screen.findByRole("button", { name: "Unbind Linear team linear_team" });
    await waitFor(() => expect(unbind).toBeEnabled());
    listedBindings = [];
    vi.mocked(browserApiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    fireEvent.click(unbind);
    await screen.findByText("No channel bindings yet.");
    expect(browserApiFetch).toHaveBeenCalledWith(`${key}/linear/linear_team`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "source" }),
    });
    expect(browserApiFetch).toHaveBeenCalledWith(`${key}/linear/linear_team`, { method: "DELETE" });
    await act(async () => finishDiscovery(Response.json({ channels })));
  });

  it("preserves a refused Linear draft and withholds controls when capabilities are revoked", async () => {
    const view = render(<TeamChannels team={team} />, { wrapper });
    await screen.findByText("No channel bindings yet.");
    await chooseOption("Provider", "Linear");
    fireEvent.change(screen.getByRole("textbox", { name: "Linear team ID" }), {
      target: { value: "linear_team" },
    });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Already bound", code: "channel_already_bound" }, { status: 409 })
    );
    fireEvent.click(screen.getByRole("button", { name: "Bind team" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("channel_already_bound");
    expect(screen.getByRole("textbox", { name: "Linear team ID" })).toHaveValue("linear_team");
    vi.mocked(browserApiFetch).mockClear();
    view.rerender(<TeamChannels team={{ ...team, capabilities: undefined }} />);
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Linear team ID" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bind team" })).toBeDisabled();
    expect(browserApiFetch).not.toHaveBeenCalled();
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
