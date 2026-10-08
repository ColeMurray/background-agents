// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LinearBotSettings,
  LinearGlobalConfig,
} from "@open-inspect/shared/types/integrations";
import type { ModelCategory } from "@open-inspect/shared/models";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { LinearIntegrationSettings } from "./linear-integration-settings";

expect.extend(matchers);

const { authorization, modelOptions, useSWRMock, mutateMock, toastSuccess, toastError } =
  vi.hoisted(() => ({
    authorization: { canManageGlobal: true },
    modelOptions: [
      {
        category: "Anthropic",
        models: [{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", description: "" }],
      },
      {
        category: "OpenAI",
        models: [{ id: "openai/gpt-6-sol", name: "GPT 6 Sol", description: "" }],
      },
    ] satisfies ModelCategory[],
    useSWRMock: vi.fn(),
    mutateMock: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  }));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      permission !== "integrations.manage" || authorization.canManageGlobal,
  }),
}));
vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({ enabledModelOptions: modelOptions }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("swr", () => ({ default: useSWRMock, mutate: mutateMock }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

const globalKey = "/api/integration-settings/linear";
const repoKey = "/api/integration-settings/linear/repos";

function setupSWR(opts: {
  settings?: LinearGlobalConfig | null;
  overrides?: { repo: string; settings: LinearBotSettings }[];
}) {
  useSWRMock.mockImplementation((key: string) => {
    if (key === globalKey) {
      return {
        data: opts.settings === undefined ? undefined : { settings: opts.settings },
        isLoading: false,
      };
    }
    if (key === repoKey) {
      return { data: { repos: opts.overrides ?? [] }, isLoading: false };
    }
    return { data: { repos: [] }, isLoading: false };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  authorization.canManageGlobal = true;
});
afterEach(cleanup);

describe("LinearIntegrationSettings unbound policy", () => {
  it("closes the open policy menu when permission is revoked without changing the value", async () => {
    const user = userEvent.setup();
    setupSWR({ settings: null });
    const view = render(<LinearIntegrationSettings />);
    const policy = screen.getByRole("combobox", { name: "Unbound Linear teams" });
    await user.click(policy);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Reject requests until bound" })).toBeInTheDocument();

    authorization.canManageGlobal = false;
    view.rerender(<LinearIntegrationSettings />);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(policy).toBeDisabled();
    expect(policy).toHaveAttribute("disabled");
    expect(policy).toHaveTextContent("Create workspace-level sessions");

    authorization.canManageGlobal = true;
    view.rerender(<LinearIntegrationSettings />);
    expect(policy).toBeEnabled();
    expect(policy).toHaveTextContent("Create workspace-level sessions");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it.each([null, { defaults: {} }])("uses the shared default for unset policy: %j", (settings) => {
    setupSWR({ settings });
    render(<LinearIntegrationSettings />);
    expect(screen.getByRole("combobox", { name: "Unbound Linear teams" })).toHaveTextContent(
      "Create workspace-level sessions"
    );
    expect(screen.getByRole("combobox", { name: "Unbound Linear teams" })).toHaveAttribute(
      "aria-describedby",
      "linear-unbound-channels-help"
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("hydrates a saved policy when settings arrive and resyncs clean revalidation", () => {
    setupSWR({});
    const view = render(<LinearIntegrationSettings />);
    setupSWR({ settings: { defaults: { unboundChannels: "reject" } } });
    view.rerender(<LinearIntegrationSettings />);
    expect(screen.getByRole("combobox", { name: "Unbound Linear teams" })).toHaveTextContent(
      "Reject requests until bound"
    );
    setupSWR({ settings: null });
    view.rerender(<LinearIntegrationSettings />);
    expect(screen.getByRole("combobox", { name: "Unbound Linear teams" })).toHaveTextContent(
      "Create workspace-level sessions"
    );
  });

  it("preserves dirty edits during revalidation and saves the policy in global defaults", async () => {
    const user = userEvent.setup();
    setupSWR({ settings: null });
    const view = render(<LinearIntegrationSettings />);
    const policy = screen.getByRole("combobox", { name: "Unbound Linear teams" });
    await user.click(policy);
    await user.click(await screen.findByRole("option", { name: "Reject requests until bound" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    setupSWR({ settings: { defaults: { unboundChannels: "workspace" } } });
    view.rerender(<LinearIntegrationSettings />);
    expect(policy).toHaveTextContent("Reject requests until bound");
    let finish!: (response: Response) => void;
    vi.mocked(browserApiFetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
    );
    mutateMock.mockImplementation((_key: string, data: { settings: LinearGlobalConfig }) => {
      setupSWR({ settings: data.settings });
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(policy).toBeDisabled();
    expect(policy).toHaveAttribute("disabled");
    expect(screen.getByRole("textbox", { name: "Issue Session Instructions" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Allow user model preferences" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /All repositories/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    const saved = {
      settings: {
        defaults: {
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: true,
          emitToolProgressActivities: true,
          unboundChannels: "reject",
        },
      },
    };
    expect(browserApiFetch).toHaveBeenCalledWith(globalKey, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saved),
    });
    await act(async () => finish(Response.json({ ok: true })));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledWith(globalKey, saved));
    view.rerender(<LinearIntegrationSettings />);
    expect(policy).toHaveTextContent("Reject requests until bound");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(toastSuccess).toHaveBeenCalledWith("Settings saved.");
  });

  it("deletes global settings on reset and restores the shared policy default", async () => {
    const user = userEvent.setup();
    setupSWR({ settings: { defaults: { unboundChannels: "reject" } } });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    mutateMock.mockImplementation((_key: string, data: { settings: null }) => {
      setupSWR({ settings: data.settings });
    });
    const view = render(<LinearIntegrationSettings />);
    expect(screen.getByRole("combobox", { name: "Unbound Linear teams" })).toHaveTextContent(
      "Reject requests until bound"
    );
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledWith(globalKey, { settings: null }));
    view.rerender(<LinearIntegrationSettings />);
    expect(browserApiFetch).toHaveBeenCalledWith(globalKey, { method: "DELETE" });
    expect(screen.getByRole("combobox", { name: "Unbound Linear teams" })).toHaveTextContent(
      "Create workspace-level sessions"
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(toastSuccess).toHaveBeenCalledWith("Settings reset to defaults.");
  });

  it.each(["save", "reset"])("retains the policy if %s is refused", async (operation) => {
    const user = userEvent.setup();
    setupSWR({ settings: { defaults: { unboundChannels: "workspace" } } });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    render(<LinearIntegrationSettings />);
    await user.click(screen.getByRole("combobox", { name: "Unbound Linear teams" }));
    await user.click(await screen.findByRole("option", { name: "Reject requests until bound" }));
    if (operation === "reset") {
      await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
      await user.click(screen.getByRole("button", { name: "Reset" }));
    } else {
      await user.click(screen.getByRole("button", { name: "Save" }));
    }
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Forbidden"));
    expect(screen.getByRole("combobox", { name: "Unbound Linear teams" })).toHaveTextContent(
      "Reject requests until bound"
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("disables policy/save/reset without global integration-management permission", async () => {
    const user = userEvent.setup();
    setupSWR({ settings: { defaults: { unboundChannels: "reject" } } });
    const view = render(<LinearIntegrationSettings />);
    await user.click(screen.getByRole("combobox", { name: "Unbound Linear teams" }));
    await user.click(
      await screen.findByRole("option", { name: "Create workspace-level sessions" })
    );
    authorization.canManageGlobal = false;
    view.rerender(<LinearIntegrationSettings />);
    expect(screen.getByRole("combobox", { name: "Unbound Linear teams" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Unbound Linear teams" })).toHaveAttribute(
      "disabled"
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Unbound Linear teams" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("disables an open reset confirmation when global permission is revoked", async () => {
    const user = userEvent.setup();
    setupSWR({ settings: { defaults: { unboundChannels: "reject" } } });
    const view = render(<LinearIntegrationSettings />);
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    authorization.canManageGlobal = false;
    view.rerender(<LinearIntegrationSettings />);
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("does not expose or serialize the global policy in repository overrides", async () => {
    setupSWR({
      settings: { defaults: { unboundChannels: "reject" } },
      overrides: [{ repo: "group/subgroup/web", settings: {} }],
    });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
    render(<LinearIntegrationSettings />);
    const row = screen.getByText("group/subgroup/web").parentElement!;
    expect(within(row).queryByRole("combobox", { name: "Unbound Linear teams" })).toBeNull();
    fireEvent.click(within(row).getByRole("checkbox", { name: "Tool updates" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledWith(repoKey));
    expect(browserApiFetch).toHaveBeenCalledWith(`${repoKey}/group%2Fsubgroup/web`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: true,
          emitToolProgressActivities: false,
        },
      }),
    });
  });
});

describe("LinearIntegrationSettings harness", () => {
  async function optionNames(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
    await user.click(trigger);
    const names = screen.getAllByRole("option").map((option) => option.textContent);
    await user.keyboard("{Escape}");
    return names;
  }

  it("requires a compatible default model when switching the global harness to Claude Agent", async () => {
    const user = userEvent.setup();
    setupSWR({
      settings: { defaults: { model: "openai/gpt-6-sol", reasoningEffort: "high" } },
    });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
    render(<LinearIntegrationSettings />);
    const harness = screen.getByRole("combobox", { name: "Agent harness" });
    const model = screen.getByRole("combobox", { name: "Default model" });
    expect(harness).toHaveTextContent("OpenCode");
    expect(await optionNames(user, model)).toContain("GPT 6 Sol");

    await user.click(harness);
    await user.click(await screen.findByRole("option", { name: "Claude Agent" }));

    expect(model).toHaveTextContent("Choose a model");
    expect(await optionNames(user, model)).toEqual(["Claude Sonnet 4.6"]);
    expect(screen.getByText(/Choose a default model Claude Agent can run/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default reasoning effort" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(browserApiFetch).not.toHaveBeenCalled();

    await user.click(model);
    await user.click(await screen.findByRole("option", { name: "Claude Sonnet 4.6" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(browserApiFetch).toHaveBeenCalled());
    const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
    expect(body.settings.defaults).toMatchObject({
      harness: "claude",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(body.settings.defaults).not.toHaveProperty("reasoningEffort");
  });

  it("filters repository models by the inherited harness and saves an explicit override", async () => {
    const user = userEvent.setup();
    setupSWR({
      settings: { defaults: { harness: "claude", model: "anthropic/claude-sonnet-4-6" } },
      overrides: [{ repo: "acme/web", settings: {} }],
    });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
    render(<LinearIntegrationSettings />);
    const row = screen.getByText("acme/web").parentElement!;
    const [harness, model] = within(row).getAllByRole("combobox");
    expect(harness).toHaveTextContent("Inherit (Claude Agent)");
    expect(await optionNames(user, model)).toEqual(["Use global model", "Claude Sonnet 4.6"]);

    await user.click(harness);
    await user.click(await screen.findByRole("option", { name: "OpenCode" }));
    await user.click(model);
    await user.click(await screen.findByRole("option", { name: "GPT 6 Sol" }));
    await user.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mutateMock).toHaveBeenCalledWith(repoKey));
    const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
    expect(body.settings).toMatchObject({ harness: "opencode", model: "openai/gpt-6-sol" });
  });

  it.each([undefined, "anthropic/claude-sonnet-4-6", "openai/gpt-6-sol"])(
    "requires a repo model with an explicit Claude harness despite global model=%s",
    async (inheritedModel) => {
      const user = userEvent.setup();
      setupSWR({
        settings: { defaults: { model: inheritedModel } },
        overrides: [{ repo: "acme/web", settings: {} }],
      });
      vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
      render(<LinearIntegrationSettings />);
      const row = screen.getByText("acme/web").parentElement!;
      const harness = within(row).getByRole("combobox", { name: "Agent harness" });
      const model = within(row).getByRole("combobox", { name: "Model" });
      await user.click(harness);
      await user.click(await screen.findByRole("option", { name: "Claude Agent" }));

      expect(model).toHaveTextContent("Choose a model");
      expect(await optionNames(user, model)).toEqual(["Claude Sonnet 4.6"]);
      expect(within(row).getByText(/requires a model at the same level/)).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Save" })).toBeDisabled();
      await user.click(within(row).getByRole("button", { name: "Save" }));
      expect(browserApiFetch).not.toHaveBeenCalled();

      await user.click(model);
      await user.click(await screen.findByRole("option", { name: "Claude Sonnet 4.6" }));
      await user.click(within(row).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(mutateMock).toHaveBeenCalledWith(repoKey));
      const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
      expect(body.settings).toMatchObject({
        harness: "claude",
        model: "anthropic/claude-sonnet-4-6",
      });
    }
  );

  it.each([
    { globalModel: "anthropic/claude-sonnet-4-6", repoModel: undefined, warns: false },
    { globalModel: undefined, repoModel: undefined, warns: false },
    { globalModel: "openai/gpt-5", repoModel: undefined, warns: false },
    { globalModel: "openai/gpt-6-sol", repoModel: undefined, warns: true },
    { globalModel: "anthropic/claude-sonnet-4-6", repoModel: "openai/gpt-6-sol", warns: true },
  ])("warns without blocking sparse saves: %j", async (selection) => {
    setupSWR({
      settings: { defaults: { harness: "claude", model: selection.globalModel } },
      overrides: [{ repo: "acme/web", settings: { model: selection.repoModel } }],
    });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
    render(<LinearIntegrationSettings />);
    const row = screen.getByText("acme/web").parentElement!;
    expect(within(row).queryByText(/requires a model at the same level/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/will fall back to OpenCode/)).not.toBeInTheDocument();
    const warning = within(row).queryByText(/Sessions using this default model will be refused/);
    if (selection.warns) {
      expect(warning).toHaveTextContent("cannot run on the Claude Agent harness");
    } else {
      expect(warning).not.toBeInTheDocument();
    }
    fireEvent.click(within(row).getByRole("checkbox", { name: "Tool updates" }));
    expect(within(row).getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledWith(repoKey));
    const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
    expect(body.settings).toEqual({
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: true,
      emitToolProgressActivities: false,
      ...(selection.repoModel ? { model: selection.repoModel } : {}),
    });
  });

  it("updates the non-blocking warning when the global harness changes", async () => {
    setupSWR({
      settings: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
      overrides: [{ repo: "acme/web", settings: { model: "openai/gpt-6-sol" } }],
    });
    const { rerender } = render(<LinearIntegrationSettings />);
    expect(screen.queryByText(/Sessions using this default model will be refused/)).toBeNull();

    setupSWR({
      settings: { defaults: { harness: "claude", model: "anthropic/claude-sonnet-4-6" } },
      overrides: [{ repo: "acme/web", settings: { model: "openai/gpt-6-sol" } }],
    });
    rerender(<LinearIntegrationSettings />);
    const row = screen.getByText("acme/web").parentElement!;
    expect(
      within(row).getByText(/Sessions using this default model will be refused/)
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "OpenCode" }));
    expect(within(row).queryByText(/Sessions using this default model will be refused/)).toBeNull();
    expect(within(row).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("requires a model for saved global Claude settings and describes launch refusal, not fallback", () => {
    setupSWR({
      settings: { defaults: { harness: "claude" } },
      overrides: [{ repo: "acme/web", settings: {} }],
    });
    render(<LinearIntegrationSettings />);
    expect(screen.getAllByText(/Choose a default model Claude Agent can run/)).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Default model" })).toHaveTextContent(
      "Choose a model"
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow user model preferences" }));
    expect(screen.getAllByRole("button", { name: "Save" })[0]).toBeDisabled();
    expect(screen.getByText(/Linear refuses to launch a session/)).toBeInTheDocument();
    expect(screen.queryByText(/will fall back to OpenCode/)).toBeNull();
  });

  it.each([undefined, "openai/gpt-6-sol", "anthropic/unknown-model"])(
    "blocks a missing, incompatible, or impossible stored explicit model at both levels: %s",
    (model) => {
      setupSWR({
        settings: { defaults: { harness: "claude", model } },
        overrides: [{ repo: "acme/web", settings: { harness: "claude", model } }],
      });
      render(<LinearIntegrationSettings />);
      fireEvent.click(screen.getByRole("checkbox", { name: "Allow user model preferences" }));
      const row = screen.getByText("acme/web").parentElement!;
      fireEvent.click(within(row).getByRole("checkbox", { name: "Tool updates" }));
      for (const save of screen.getAllByRole("button", { name: "Save" })) {
        expect(save).toBeDisabled();
        fireEvent.click(save);
      }
      expect(browserApiFetch).not.toHaveBeenCalled();
    }
  );

  it("clears an incompatible repo model and effort when selecting Claude Agent", async () => {
    const user = userEvent.setup();
    setupSWR({
      settings: null,
      overrides: [
        {
          repo: "acme/web",
          settings: { harness: "opencode", model: "openai/gpt-6-sol", reasoningEffort: "high" },
        },
      ],
    });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
    render(<LinearIntegrationSettings />);
    const row = screen.getByText("acme/web").parentElement!;
    await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "Claude Agent" }));
    expect(within(row).getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Choose a model"
    );
    expect(within(row).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(within(row).getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "Claude Sonnet 4.6" }));
    await user.click(within(row).getByRole("button", { name: "Save" }));
    const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
    expect(body.settings).toMatchObject({
      harness: "claude",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(body.settings).not.toHaveProperty("reasoningEffort");
  });

  it("allows a repo to inherit the Claude harness and model after removing explicit selections", async () => {
    const user = userEvent.setup();
    setupSWR({
      settings: { defaults: { harness: "claude", model: "anthropic/claude-sonnet-4-6" } },
      overrides: [
        { repo: "acme/web", settings: { harness: "claude", model: "anthropic/claude-sonnet-4-6" } },
      ],
    });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
    render(<LinearIntegrationSettings />);
    const row = screen.getByText("acme/web").parentElement!;
    await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "Inherit (Claude Agent)" }));
    await user.click(within(row).getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "Use global model" }));
    await user.click(within(row).getByRole("button", { name: "Save" }));
    const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
    expect(body.settings).not.toHaveProperty("harness");
    expect(body.settings).not.toHaveProperty("model");
  });

  it("keeps global system defaults and repo model inheritance available for OpenCode", async () => {
    const user = userEvent.setup();
    setupSWR({
      settings: { defaults: { harness: "claude", model: "anthropic/claude-sonnet-4-6" } },
      overrides: [{ repo: "acme/web", settings: { harness: "opencode" } }],
    });
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ ok: true }));
    render(<LinearIntegrationSettings />);
    await user.click(screen.getAllByRole("combobox", { name: "Agent harness" })[0]);
    await user.click(await screen.findByRole("option", { name: "OpenCode" }));
    const model = screen.getByRole("combobox", { name: "Default model" });
    expect(await optionNames(user, model)).toEqual([
      "Use system default",
      "Claude Sonnet 4.6",
      "GPT 6 Sol",
    ]);
    await user.click(model);
    await user.click(await screen.findByRole("option", { name: "Use system default" }));
    await user.click(screen.getAllByRole("button", { name: "Save" })[0]);
    const globalBody = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
    expect(globalBody.settings.defaults).not.toHaveProperty("harness");
    expect(globalBody.settings.defaults).not.toHaveProperty("model");

    const row = screen.getByText("acme/web").parentElement!;
    expect(await optionNames(user, within(row).getByRole("combobox", { name: "Model" }))).toEqual([
      "Use global model",
      "Claude Sonnet 4.6",
      "GPT 6 Sol",
    ]);
    fireEvent.click(within(row).getByRole("checkbox", { name: "Tool updates" }));
    await user.click(within(row).getByRole("button", { name: "Save" }));
    const repoBody = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[1][1]?.body));
    expect(repoBody.settings).toMatchObject({ harness: "opencode" });
    expect(repoBody.settings).not.toHaveProperty("model");
  });
});
