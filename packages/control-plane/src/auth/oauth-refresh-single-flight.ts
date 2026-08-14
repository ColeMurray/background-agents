import type { OAuthSecretScope } from "../db/scoped-oauth-secrets";

type InFlightRefresh<TResult> = {
  refreshToken: string;
  promise: Promise<TResult>;
};

/** Coalesces refresh-token rotation for one provider within a Worker isolate. */
export class OAuthRefreshSingleFlight<TResult> {
  private readonly inFlight = new Map<string, InFlightRefresh<TResult>>();

  run(
    scope: OAuthSecretScope,
    refreshToken: string,
    refresh: () => Promise<TResult>
  ): Promise<TResult> {
    const key = this.scopeKey(scope);
    const existing = this.inFlight.get(key);
    if (existing?.refreshToken === refreshToken) return existing.promise;

    const promise = refresh().finally(() => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { refreshToken, promise });
    return promise;
  }

  private scopeKey(scope: OAuthSecretScope): string {
    switch (scope.kind) {
      case "environment":
        return `environment:${scope.environmentId}`;
      case "repo":
        return `repo:${scope.repoId}`;
      case "global":
        return "global";
    }
  }
}
