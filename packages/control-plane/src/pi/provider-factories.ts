import { createHarnessProviderFactories } from "../harness/provider-factory";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Provider } from "@earendil-works/pi-ai/models";

/**
 * The providers a Pi Durable Object may run a model on.
 *
 * The registry is the seam's, and the factories are the deployment's. A
 * deployment (or a test) that serves a provider id differently registers its
 * own factory *before* the harness opens, so the provider the harness wraps is
 * the provider that answers.
 */
export const piProviderFactories = createHarnessProviderFactories<Provider>();

/**
 * The provider that serves Pi's model ids.
 *
 * Pi runs on OpenAI's Codex, and the runtime asks for it by the provider id
 * `openai-codex`.
 */
export const PI_MODEL_PROVIDER_ID = "openai-codex";

piProviderFactories.register(PI_MODEL_PROVIDER_ID, () => openaiCodexProvider());
