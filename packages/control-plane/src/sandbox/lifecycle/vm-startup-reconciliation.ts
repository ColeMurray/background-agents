import type { Logger } from "../../logger";
import type { BackgroundTasks } from "../../platform-ports";
import type { SandboxRow, SessionRow } from "../../session/types";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResolveSandboxResult,
  type SandboxLifetime,
  type SandboxProvider,
} from "../provider";
import { modalVmAllocationDetail } from "../providers/modal-provider";
import { parsePendingVmReference } from "../providers/pending-vm-reference";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "./decisions";
import type { SandboxLaunchContext } from "./launch-context";
import type { SandboxGeneration } from "./ports";
import type { SandboxAccess } from "./sandbox-access";
import { SandboxLaunchExpiredError, SpawnSupersededError } from "./startup-errors";

const VM_RESOLVE_RETRY_MS = 10_000;

type PendingStartupConfig = Pick<
  CreateSandboxConfig,
  "sessionId" | "sandboxId" | "generationCreatedAtMs" | "timeoutSeconds"
>;

export interface VmStartupReconciliationStorage {
  getSandbox(): SandboxRow | null;
  updateSandboxModalObjectId(modalObjectId: string | null): void;
  /** Repository rechecks generation, fence, status and expected reference after encryption. */
  completeProviderResume(
    generation: SandboxGeneration,
    access: {
      providerObjectId: string;
      codeServer: { url: string; password: string } | null;
      vnc: { url: string; password: string } | null;
      ttyd: { url: string | null; token: string } | null;
      tunnelUrls: Record<string, string> | null;
    },
    expectedProviderObjectId?: string
  ): Promise<boolean>;
}

export interface VmStartupReconciliationShutdown {
  /** Records a generation-scoped pending handle and its conservative expiry. */
  recordPendingProviderHandle(
    generation: SandboxGeneration,
    reference: string,
    lifetime: Extract<SandboxLifetime, { kind: "finite" }>
  ): Promise<"registered" | "expired" | "superseded">;
  /** Swaps a recovered handle without changing shutdown policy or lifetime. */
  recordResolvedProviderHandle?(
    generation: SandboxGeneration,
    expectedReference: string,
    providerObjectId: string
  ): void;
}

export interface VmStartupReconciliationDependencies {
  provider: Pick<
    SandboxProvider,
    | "name"
    | "createSandbox"
    | "pendingSandboxAllocation"
    | "isUnknownStartupError"
    | "resolveSandbox"
  >;
  storage: VmStartupReconciliationStorage;
  shutdown: VmStartupReconciliationShutdown;
  sessionContext: { getSession(): SessionRow | null };
  launchContext: Pick<SandboxLaunchContext, "resolveSandboxSettings">;
  access: Pick<SandboxAccess, "mintTtydToken" | "broadcastProviderAccessIfConnected">;
  /** Manager-owned generic acceptance, cleanup, lifetime recording and announcements. */
  acceptResolvedStartup(
    generation: SandboxGeneration,
    providerObjectId: string | undefined,
    lifetime: SandboxLifetime
  ): Promise<boolean>;
  getLogger: () => Pick<Logger, "warn">;
  backgroundTasks?: BackgroundTasks;
}

/** Reconciles an already-authorized startup; owns no admission or preservation policy. */
export class VmStartupReconciliation {
  private bridgeResolution: SandboxGeneration | null = null;
  private bridgeRetryGeneration: SandboxGeneration | null = null;
  private bridgeStartupClaim: SandboxGeneration | null = null;
  private bridgeResolvedStartup: {
    generation: SandboxGeneration;
    result: ResolveSandboxResult;
  } | null = null;
  private vmStartupAuth: {
    generation: SandboxGeneration;
    sessionId: string;
    token: string;
  } | null = null;

  constructor(private readonly deps: VmStartupReconciliationDependencies) {}

  registerForegroundAuth(generation: SandboxGeneration, sessionId: string, token: string): void {
    if (this.deps.provider.name === "modal-vm")
      this.vmStartupAuth = { generation, sessionId, token };
  }

  /** The base-image retry drops old auth before reservation/hash publication can yield. */
  beginForegroundRetry(): void {
    this.vmStartupAuth = null;
  }

  finalizeForeground(generation: SandboxGeneration | null): void {
    // Foreground ownership is object identity; bridges authenticate equal-valued generations.
    if (this.vmStartupAuth?.generation === generation && this.bridgeStartupClaim !== generation)
      this.vmStartupAuth = null;
  }

  async recordPendingProviderReference(
    generation: SandboxGeneration,
    config: PendingStartupConfig
  ): Promise<void> {
    const { provider, storage, shutdown } = this.deps;
    if (!generation.sandboxId || config.sandboxId !== generation.sandboxId)
      throw new SpawnSupersededError();
    const pending = provider.pendingSandboxAllocation?.(config);
    if (!pending) return;
    const row = storage.getSandbox();
    if (
      row?.modal_sandbox_id !== generation.sandboxId ||
      row.created_at !== generation.createdAt ||
      row.fenced
    ) {
      throw new SpawnSupersededError();
    }
    const previousProviderObjectId = row.modal_object_id;
    storage.updateSandboxModalObjectId(pending.reference);
    const registered = await shutdown.recordPendingProviderHandle(
      generation,
      pending.reference,
      pending.lifetime
    );
    if (registered === "superseded") throw new SpawnSupersededError();
    if (registered === "expired") {
      const current = storage.getSandbox();
      if (
        current?.modal_sandbox_id === generation.sandboxId &&
        current.created_at === generation.createdAt &&
        current.modal_object_id === pending.reference &&
        !current.fenced
      ) {
        storage.updateSandboxModalObjectId(previousProviderObjectId);
      }
      throw new SandboxLaunchExpiredError();
    }
  }

  async createWithVmRecovery(
    config: CreateSandboxConfig,
    generation: SandboxGeneration
  ): Promise<CreateSandboxResult | null> {
    const { provider } = this.deps;
    try {
      return await provider.createSandbox(config);
    } catch (error) {
      if (!provider.isUnknownStartupError?.(error)) throw error;
      const recovered = await this.resolveUnknownVmStartup(generation, config);
      return recovered ? { ...recovered, createdAt: generation.createdAt } : null;
    }
  }

  private knownBridgeStartup(
    generation: SandboxGeneration,
    row: SandboxRow | null
  ): ResolveSandboxResult | null {
    const known = this.bridgeResolvedStartup;
    if (
      !known ||
      row?.modal_sandbox_id !== generation.sandboxId ||
      row.created_at !== generation.createdAt ||
      row.fenced ||
      !["spawning", "connecting", "ready"].includes(row.status) ||
      row.modal_object_id !== known.result.providerObjectId ||
      known.generation.sandboxId !== generation.sandboxId ||
      known.generation.createdAt !== generation.createdAt
    )
      return null;
    return known.result;
  }

  async resolveUnknownVmStartup(
    generation: SandboxGeneration,
    config: PendingStartupConfig
  ): Promise<ResolveSandboxResult | null> {
    const { provider, storage } = this.deps;
    if (!provider.resolveSandbox) return null;
    const reference = provider.pendingSandboxAllocation?.(config)?.reference;
    while (true) {
      const row = storage.getSandbox();
      const bridged = this.knownBridgeStartup(generation, row);
      if (bridged) return bridged;
      const resolvedByBridge =
        !!row?.modal_object_id &&
        row.modal_object_id !== reference &&
        parsePendingVmReference(row.modal_object_id) === null;
      if (
        row?.modal_sandbox_id !== generation.sandboxId ||
        row.created_at !== generation.createdAt ||
        row.fenced ||
        !["spawning", "connecting", "ready"].includes(row.status) ||
        (row.modal_object_id !== reference && !resolvedByBridge)
      )
        return null;
      try {
        return await provider.resolveSandbox({
          ...config,
          generationCreatedAtMs: generation.createdAt,
        });
      } catch (error) {
        const detail = modalVmAllocationDetail(error);
        if (detail === "other_generation") throw error;
        if (detail !== "not_visible" && !provider.isUnknownStartupError?.(error)) throw error;
        if (Date.now() - generation.createdAt >= PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS) {
          const current = storage.getSandbox();
          const bridgedAfterLookup = this.knownBridgeStartup(generation, current);
          if (bridgedAfterLookup) return bridgedAfterLookup;
          if (
            current?.modal_sandbox_id === generation.sandboxId &&
            current.created_at === generation.createdAt &&
            !current.fenced &&
            current.modal_object_id &&
            parsePendingVmReference(current.modal_object_id) === null
          ) {
            const lifetime = provider.pendingSandboxAllocation?.(config)?.lifetime;
            if (lifetime)
              return {
                sandboxId: config.sandboxId,
                providerObjectId: current.modal_object_id,
                lifetime,
              };
          }
          if (detail === "not_visible")
            throw new SandboxProviderError(
              "The VM allocation did not appear for this attempt. Please retry.",
              "transient",
              error instanceof Error ? error : undefined
            );
          if (
            current?.modal_sandbox_id === generation.sandboxId &&
            current.created_at === generation.createdAt &&
            !current.fenced &&
            current.modal_object_id === reference
          )
            this.bridgeStartupClaim = generation;
          return null;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, VM_RESOLVE_RETRY_MS));
    }
  }

  /** Synchronous bridge entry submits lookup-only work without holding readiness. */
  resolvePendingBridge(generation: SandboxGeneration): void {
    if (this.bridgeResolution) {
      if (
        this.bridgeResolution.sandboxId !== generation.sandboxId ||
        this.bridgeResolution.createdAt !== generation.createdAt
      )
        this.bridgeRetryGeneration = generation;
      return;
    }
    const { provider, storage, sessionContext, launchContext, access, shutdown, backgroundTasks } =
      this.deps;
    if (!provider.resolveSandbox) return;
    const row = storage.getSandbox();
    const reference = row?.modal_object_id;
    const pending = reference ? parsePendingVmReference(reference) : null;
    const session = sessionContext.getSession();
    if (
      !row ||
      row.fenced ||
      !["spawning", "connecting", "ready"].includes(row.status) ||
      row.created_at !== generation.createdAt ||
      row.modal_sandbox_id !== generation.sandboxId ||
      !reference ||
      !pending ||
      !session ||
      pending.sandboxId !== row.modal_sandbox_id ||
      pending.sessionId !== (session.session_name || session.id)
    )
      return;
    const config = {
      sessionId: pending.sessionId,
      sandboxId: pending.sandboxId,
      generationCreatedAtMs: generation.createdAt,
      timeoutSeconds: launchContext.resolveSandboxSettings(session).timeoutSeconds,
    };
    const retryDeadlineAtMs = Date.now() + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS;
    this.bridgeResolution = generation;
    const work = () =>
      (async () => {
        let result: ResolveSandboxResult;
        while (true) {
          const current = storage.getSandbox();
          if (
            current?.modal_sandbox_id !== generation.sandboxId ||
            current.created_at !== generation.createdAt ||
            current.fenced ||
            !["spawning", "connecting", "ready"].includes(current.status) ||
            current.modal_object_id !== reference
          )
            return;
          try {
            result = await provider.resolveSandbox!(config);
            break;
          } catch (error) {
            const detail = modalVmAllocationDetail(error);
            if (detail !== "not_visible" && !provider.isUnknownStartupError?.(error)) throw error;
            if (
              Date.now() >= retryDeadlineAtMs ||
              (detail === "not_visible" &&
                Date.now() - generation.createdAt >= PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS) ||
              this.bridgeRetryGeneration
            )
              return;
            await new Promise<void>((resolve) => setTimeout(resolve, VM_RESOLVE_RETRY_MS));
          }
        }
        if (!result.providerObjectId) return;
        const auth = this.vmStartupAuth;
        const terminalToken =
          result.ttydUrl &&
          auth &&
          auth.generation.sandboxId === generation.sandboxId &&
          auth.generation.createdAt === generation.createdAt
            ? await access.mintTtydToken(auth.token, auth.sessionId, generation.sandboxId!)
            : null;
        const committed = await storage.completeProviderResume(
          generation,
          {
            providerObjectId: result.providerObjectId,
            codeServer:
              result.codeServerUrl && result.codeServerPassword
                ? { url: result.codeServerUrl, password: result.codeServerPassword }
                : null,
            vnc: result.vncAccess ?? null,
            ttyd:
              result.ttydUrl && terminalToken
                ? { url: result.ttydUrl, token: terminalToken }
                : null,
            tunnelUrls: result.tunnelUrls ?? null,
          },
          reference
        );
        if (!committed) return;
        this.bridgeResolvedStartup = {
          generation,
          result: {
            sandboxId: result.sandboxId,
            providerObjectId: result.providerObjectId,
            lifetime: result.lifetime,
          },
        };
        if (
          this.bridgeStartupClaim?.sandboxId === generation.sandboxId &&
          this.bridgeStartupClaim.createdAt === generation.createdAt
        ) {
          this.bridgeStartupClaim = null;
          try {
            await this.deps.acceptResolvedStartup(
              generation,
              result.providerObjectId,
              result.lifetime
            );
          } finally {
            if (
              this.vmStartupAuth?.generation.sandboxId === generation.sandboxId &&
              this.vmStartupAuth.generation.createdAt === generation.createdAt
            )
              this.vmStartupAuth = null;
          }
        } else {
          shutdown.recordResolvedProviderHandle?.(generation, reference, result.providerObjectId);
        }
        access.broadcastProviderAccessIfConnected();
      })()
        .catch((error) => {
          this.deps.getLogger().warn("Bridge VM resolution failed", {
            event: "sandbox.vm_resolve_failed",
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.bridgeResolution = null;
          const queued = this.bridgeRetryGeneration;
          this.bridgeRetryGeneration = null;
          if (queued) this.resolvePendingBridge(queued);
        });
    if (backgroundTasks) backgroundTasks.submit(work, { name: "sandbox.vm_resolve" });
    else void work();
  }
}
