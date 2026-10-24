import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import {
  createFauxCore,
  type FauxModelDefinition,
  type FauxProviderState,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";

const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";

export interface FauxCodexProvider {
  readonly provider: Provider;
  readonly state: FauxProviderState;
}

/**
 * A stand-in for the Codex provider that accepts the session's credential.
 *
 * The session's credential store serves an OAuth credential, and pi-ai hands a
 * stored OAuth credential only to a provider that declares OAuth auth. The
 * faux provider's own auth is an API key, so a plain faux never receives the
 * real credential: the model call is refused before the scripted response can
 * run. This stand-in declares the OAuth shape of the provider it replaces.
 */
export function createFauxCodexProvider(options: {
  models: [FauxModelDefinition, ...FauxModelDefinition[]];
  responses: FauxResponseStep[];
}): FauxCodexProvider {
  const core = createFauxCore({ provider: PROVIDER_ID, api: API_ID, models: options.models });
  core.setResponses(options.responses);
  return {
    provider: createProvider({
      id: PROVIDER_ID,
      models: core.models,
      auth: {
        oauth: {
          name: "Faux OAuth",
          login: async () => {
            throw new Error("The faux Codex provider does not log in");
          },
          refresh: async (credential) => credential,
          toAuth: async () => ({}),
        },
      },
      api: {
        stream: core.stream,
        streamSimple: core.streamSimple,
        fetchDeferred: core.fetchDeferred,
        cancelDeferred: core.cancelDeferred,
      },
    }),
    state: core.state,
  };
}
