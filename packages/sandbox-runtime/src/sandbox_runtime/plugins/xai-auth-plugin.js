/**
 * xAI Auth Proxy Plugin for Open-Inspect.
 *
 * Keeps rotating SuperGrok refresh tokens in the control plane while exposing
 * only short-lived access tokens to the ephemeral sandbox.
 */

import { createProviderTokenBroker } from "./provider-token-broker.js";

const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key";
const tokenBroker = createProviderTokenBroker({ provider: "xai", providerLabel: "xAI" });

export const XaiAuthProxy = async () => ({
  provider: {
    id: "xai",
    async models(provider) {
      if (provider.models["grok-build-0.1"]) return provider.models;
      const api =
        provider.models["grok-code-fast-1"]?.api ??
        Object.values(provider.models).find((model) => model.api?.npm === "@ai-sdk/xai")?.api;
      if (!api) throw new Error("xAI catalog has no API metadata for Grok Build");
      return {
        ...provider.models,
        "grok-build-0.1": {
          id: "grok-build-0.1",
          providerID: "xai",
          api: { ...api, id: "grok-build-0.1" },
          name: "Grok Build 0.1",
          family: "grok-build",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: true },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          status: "active",
          options: {},
          headers: {},
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 256000, output: 256000 },
          release_date: "2026-04-16",
          variants: {},
        },
      };
    },
  },
  auth: {
    provider: "xai",
    methods: [],
    async loader(getAuth) {
      const auth = await getAuth();
      if (auth.type !== "oauth") return {};
      return {
        apiKey: OAUTH_DUMMY_KEY,
        async fetch(requestInput, init) {
          const currentAuth = await getAuth();
          if (currentAuth.type !== "oauth") return fetch(requestInput, init);
          const headers = new Headers(
            requestInput instanceof Request ? requestInput.headers : undefined
          );
          if (init?.headers) {
            const entries =
              init.headers instanceof Headers
                ? init.headers.entries()
                : Array.isArray(init.headers)
                  ? init.headers
                  : Object.entries(init.headers);
            for (const [key, value] of entries) {
              if (value !== undefined) headers.set(key, String(value));
            }
          }
          const { accessToken } = await tokenBroker.getAccessToken();
          headers.set("authorization", `Bearer ${accessToken}`);
          return fetch(requestInput, { ...init, headers });
        },
      };
    },
  },
});
