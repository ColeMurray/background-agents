import type { Logger } from "../logger";
import type { ProviderCredentialStore } from "../db/provider-account-credentials";
import type { ModelProviderAccountBroker } from "./model-provider-account-broker";

export const ANTHROPIC_REFRESH_LOOKAHEAD_MS = 6 * 60 * 1000;
export const ANTHROPIC_REFRESH_BATCH_LIMIT = 50;

export interface ModelProviderAccountRefreshStats {
  due: number;
  refreshed: number;
  failed: number;
}

export class ModelProviderAccountRefreshMaintenance {
  constructor(
    private readonly credentials: Pick<ProviderCredentialStore, "listDueRefreshAccountIds">,
    private readonly broker: Pick<ModelProviderAccountBroker, "getAccess">,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now
  ) {}

  async run(): Promise<ModelProviderAccountRefreshStats> {
    const accountIds = await this.credentials.listDueRefreshAccountIds(
      "anthropic",
      this.now() + ANTHROPIC_REFRESH_LOOKAHEAD_MS,
      ANTHROPIC_REFRESH_BATCH_LIMIT
    );
    const stats: ModelProviderAccountRefreshStats = {
      due: accountIds.length,
      refreshed: 0,
      failed: 0,
    };

    for (const accountId of accountIds) {
      try {
        await this.broker.getAccess(accountId, "anthropic");
        stats.refreshed += 1;
      } catch (error) {
        stats.failed += 1;
        this.logger.error("provider_account.proactive_refresh_failed", {
          event: "provider_account.proactive_refresh_failed",
          provider_account_id: accountId,
          provider: "anthropic",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    this.logger.info("provider_account.proactive_refresh_completed", {
      event: "provider_account.proactive_refresh_completed",
      provider: "anthropic",
      ...stats,
    });
    return stats;
  }
}
