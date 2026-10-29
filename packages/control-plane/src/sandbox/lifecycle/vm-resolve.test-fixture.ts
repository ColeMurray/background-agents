import { vi } from "vitest";
import {
  ModalApiError,
  type ModalClient,
  type CreateSandboxRequest,
  type ResolveVmSandboxResponse,
} from "../client";
import { ModalSandboxProvider } from "../providers/modal-provider";
import { RequestDeadlineError } from "../request-deadline";
import type { ImageBuildLookup } from "./image-selection";
import { SandboxShutdownCoordinator } from "../../session/sandbox-shutdown";
import type { ShutdownRecord } from "../../session/sandbox-shutdown-repository";
import {
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createTestConfig,
  createTestLifecycleManager,
} from "./test-helpers";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";

/** A modal-vm manager whose create or restore response is lost, with the shutdown coordinator. */
export function fixture(
  action: "create" | "restore" = "create",
  imageBuildLookup?: ImageBuildLookup
) {
  const sandbox = createMockSandbox({
    status: action === "create" ? "pending" : "stopped",
    snapshot_image_id: action === "restore" ? "im-saved" : null,
    snapshot_runtime_version: action === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
  });
  const session = createMockSession({
    code_server_enabled: 1,
    vnc_enabled: 1,
    sandbox_settings: JSON.stringify({ sandboxTimeoutMs: 3_600_000 }),
  });
  const storage = createMockStorage(
    session,
    sandbox,
    undefined,
    imageBuildLookup ? [{ repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" }] : []
  );
  const broadcaster = createMockBroadcaster();
  const wsManager = createMockWebSocketManager();
  const providerResponse: ResolveVmSandboxResponse = {
    sandboxId: "unused",
    modalObjectId: "sb-real",
    sandboxBackend: "modal-vm",
    codeServerUrl: "https://editor.example",
    codeServerPassword: "editor-password",
    vncUrl: "https://desktop.example",
    vncPassword: "desktop-password",
    ttydUrl: "https://terminal.example",
    tunnelUrls: { "8080": "https://port.example" },
  };
  const client = {
    createSandbox: vi.fn(
      async (
        _config: CreateSandboxRequest
      ): Promise<{
        sandboxId: string;
        modalObjectId: string;
        sandboxBackend: string;
        createdAt: number;
      }> => {
        throw new RequestDeadlineError("Modal", "createSandbox", 60_000);
      }
    ),
    restoreSandbox: vi.fn(async () => {
      throw new ModalApiError("pending race", 409, "race_pending");
    }),
    resolveVmSandbox: vi.fn(
      async (req: { sandboxId: string }): Promise<ResolveVmSandboxResponse> => ({
        ...providerResponse,
        sandboxId: req.sandboxId,
      })
    ),
    stopSandbox: vi.fn(async () => {}),
  };
  const provider = new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm", "github");
  const backgroundTasks = { submit: vi.fn((task: () => Promise<unknown>) => void task()) };
  let state: ShutdownRecord | null = null;
  const store = {
    read: () => (state ? structuredClone(state) : null),
    write: (next: ShutdownRecord) => {
      state = structuredClone(next);
    },
  };
  if (action === "restore") {
    store.write({
      phase: "saved",
      generation: { sandboxId: sandbox.modal_sandbox_id!, createdAt: sandbox.created_at },
      provider: "modal-vm",
      providerObjectId: null,
      sourceRetired: true,
      lifetimeKind: "none",
      expiresAtMs: null,
      drainAtMs: null,
      generationReady: true,
      lifecyclePolicy: "confirmed",
      receipt: {
        kind: "snapshot",
        artifactId: "im-saved",
        provider: "modal-vm",
        savedAtMs: Date.now(),
        runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
      },
    });
  }
  const alarmScheduler = createMockAlarmScheduler();
  const deps = {
    store,
    provider,
    sandbox: storage,
    session: { getSession: () => session, transaction: <T>(fn: () => T) => fn() },
    messages: { getProcessingMessage: () => null },
    failures: { record: vi.fn(), deliver: vi.fn() },
    messenger: broadcaster,
    sockets: { getSandboxSocket: () => null },
    alarm: alarmScheduler,
    background: { submit: vi.fn() },
    onLifecycleChange: vi.fn(async () => {}),
    reconcileStatusFromMessages: vi.fn(async () => {}),
    retireAccess: vi.fn(),
  };
  const makeManager = () =>
    createTestLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      wsManager,
      alarmScheduler,
      createMockIdGenerator(),
      new SandboxShutdownCoordinator(deps as never),
      createTestConfig(),
      imageBuildLookup,
      backgroundTasks
    );
  return {
    session,
    sandbox,
    storage,
    broadcaster,
    client,
    provider,
    store,
    makeManager,
    wsManager,
    backgroundTasks,
    alarmScheduler,
  };
}
