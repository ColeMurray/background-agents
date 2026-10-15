import { z } from "zod";
import type { CacheStore } from "@open-inspect/shared/cache-store";
import {
  PROVIDER_ACCOUNT_USAGE_CACHE_MS,
  providerAccountUsageSchema,
  type ProviderAccountUsage,
} from "@open-inspect/shared/types/provider-account-usage";
import { withinProviderAccessDeadline } from "../auth/provider-access-deadline";
import {
  ModelProviderAccountBrokerError,
  type ModelProviderAccountBroker,
} from "../auth/model-provider-account-broker";
import { readBoundedProviderBody } from "../auth/provider-response";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import type { BackgroundTasks, FetchClient } from "../platform-ports";
import { providerAccountIneligibility } from "./account-lifecycle-policy";
import { OPENAI_USAGE_URL, parseOpenAIUsage } from "./openai-usage";

export const PROVIDER_ACCOUNT_USAGE_TIMEOUT_MS = 8_000;
const cachedUsageSchema = z.object({ expiresAt: z.number(), usage: providerAccountUsageSchema });

/** Quota reads use the same account-specific lifecycle and rotating-grant broker as inference. */
export class ProviderAccountUsageService {
  constructor(
    private readonly broker: Pick<ModelProviderAccountBroker, "getAccess">,
    private readonly cache: CacheStore,
    private readonly client: FetchClient,
    private readonly backgroundTasks: BackgroundTasks,
    private readonly now: () => number = Date.now
  ) {}

  async read(
    account: ModelProviderAccount,
    lifecycleVersion: number
  ): Promise<ProviderAccountUsage> {
    // Check before looking at cache: disabling/archiving must take effect immediately.
    if (providerAccountIneligibility(account, "active_use")) {
      return { status: "unavailable", reason: "inactive_account" };
    }
    if (account.provider !== "openai") return { status: "unsupported" };
    const controller = new AbortController();
    const deadlineAt = this.now() + PROVIDER_ACCOUNT_USAGE_TIMEOUT_MS;
    try {
      return await withinProviderAccessDeadline(
        this.readCached(account, lifecycleVersion, controller.signal, deadlineAt),
        deadlineAt
      );
    } catch (cause) {
      return {
        status: "unavailable",
        reason:
          cause instanceof ModelProviderAccountBrokerError && cause.code === "deadline_exceeded"
            ? "timeout"
            : "provider_error",
      };
    } finally {
      controller.abort();
    }
  }

  private async readCached(
    account: ModelProviderAccount,
    lifecycleVersion: number,
    signal: AbortSignal,
    deadlineAt: number
  ): Promise<ProviderAccountUsage> {
    // Usage attribution changes updatedAt, while this revision only changes on lifecycle edits.
    const key = `provider-account-usage:v2:${account.id}:${lifecycleVersion}`;
    const cached = cachedUsageSchema.safeParse(await this.cache.get(key, "json").catch(() => null));
    signal.throwIfAborted();
    if (cached.success && cached.data.expiresAt > this.now()) return cached.data.usage;
    let usage: ProviderAccountUsage;
    try {
      const operation = this.broker.getAccess(account.id, "openai", { deadlineAt });
      // A consumed rotating grant must settle even after the caller stops waiting.
      this.backgroundTasks.submit(
        () =>
          operation.then(
            () => undefined,
            () => undefined
          ),
        { name: "provider-usage-credential-settlement" }
      );
      const access = await operation;
      signal.throwIfAborted();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${access.accessToken}`,
        Accept: "application/json",
        "User-Agent": "Open-Inspect",
      };
      if (access.externalAccountId) headers["ChatGPT-Account-Id"] = access.externalAccountId;
      const response = await this.client.fetch(OPENAI_USAGE_URL, {
        headers,
        signal,
        redirect: "manual",
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        usage = { status: "unavailable", reason: "provider_error" };
      } else {
        try {
          const body = await readBoundedProviderBody(
            response,
            () => new Error("Usage response too large")
          );
          usage = parseOpenAIUsage(JSON.parse(body), this.now());
        } catch {
          usage = { status: "unavailable", reason: "invalid_response" };
        }
      }
    } catch (cause) {
      if (signal.aborted) throw cause;
      if (cause instanceof ModelProviderAccountBrokerError && cause.code === "deadline_exceeded")
        throw cause;
      usage = {
        status: "unavailable",
        reason: cause instanceof ModelProviderAccountBrokerError ? "credentials" : "provider_error",
      };
    }
    signal.throwIfAborted();
    const expiresAt =
      usage.status === "available" ? usage.expiresAt : this.now() + PROVIDER_ACCOUNT_USAGE_CACHE_MS;
    // Only normalized, credential-free observations enter the cache. Cache outages remain readable.
    this.backgroundTasks.submit(
      () =>
        this.cache.put(key, JSON.stringify({ usage, expiresAt }), {
          ttlMs: PROVIDER_ACCOUNT_USAGE_CACHE_MS,
        }),
      { name: "provider-account-usage-cache-write" }
    );
    return usage;
  }
}
