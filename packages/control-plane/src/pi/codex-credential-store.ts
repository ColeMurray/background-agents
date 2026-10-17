import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";

const PROVIDER_ID = "openai-codex";
const REFRESH_SENTINEL = "managed-by-open-inspect";
const REFRESH_BUFFER_MS = 60_000;

interface BrokerCredential {
  accessToken: string;
  expiresIn: number;
}

type BrokerCredentialFetcher = (signal?: AbortSignal) => Promise<BrokerCredential>;

/**
 * Pi credential facade over Open-Inspect's session-bound provider broker.
 *
 * The only durable credential remains in the control plane. This store keeps a
 * short-lived access token in memory and deliberately discards every mutation
 * Pi's generic OAuth refresh machinery offers it.
 */
export class CodexBrokerCredentialStore implements CredentialStore {
  private credential: OAuthCredential | undefined;
  private inFlight: Promise<OAuthCredential> | undefined;

  constructor(
    private readonly fetchCredential: BrokerCredentialFetcher,
    private readonly now: () => number = Date.now
  ) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== PROVIDER_ID) return undefined;
    if (this.credential && this.credential.expires - this.now() > REFRESH_BUFFER_MS) {
      return { ...this.credential };
    }
    if (!this.inFlight) {
      this.inFlight = this.load(options?.signal).finally(() => {
        this.inFlight = undefined;
      });
    }
    return { ...(await this.inFlight) };
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return this.credential ? [{ providerId: PROVIDER_ID, type: "oauth" }] : [];
  }

  async modify(
    providerId: string,
    _fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    if (providerId !== PROVIDER_ID) return undefined;
    // Models calls modify when its generic OAuth path wants to refresh. The
    // built-in Codex provider would exchange `refresh`; that value is only a
    // sentinel here, so bypass the callback and ask Open-Inspect's authority.
    this.credential = undefined;
    if (!this.inFlight) {
      this.inFlight = this.load(options?.signal).finally(() => {
        this.inFlight = undefined;
      });
    }
    return { ...(await this.inFlight) };
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    if (providerId !== PROVIDER_ID) return;
    // A session's connected account is control-plane policy. Local logout must
    // not erase it or enable a fallback to ambient/deployment credentials.
  }

  private async load(signal?: AbortSignal): Promise<OAuthCredential> {
    signal?.throwIfAborted();
    const value = await this.fetchCredential(signal);
    if (!value.accessToken.trim() || !Number.isFinite(value.expiresIn) || value.expiresIn <= 0) {
      throw new Error("Invalid OpenAI credential broker response");
    }
    const credential: OAuthCredential = {
      type: "oauth",
      access: value.accessToken,
      refresh: REFRESH_SENTINEL,
      expires: this.now() + value.expiresIn * 1_000,
    };
    this.credential = credential;
    return credential;
  }
}
