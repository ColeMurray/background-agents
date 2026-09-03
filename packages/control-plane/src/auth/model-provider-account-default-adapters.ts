import { ModelProviderAccountAdapterRegistry } from "./model-provider-account-adapters";
import { AnthropicModelProviderAccountAdapter } from "./model-provider-account-anthropic-adapter";
import { OpenAIModelProviderAccountAdapter } from "./model-provider-account-openai-adapter";
import { XaiModelProviderAccountAdapter } from "./model-provider-account-xai-adapter";

export const modelProviderAccountAdapterRegistry = new ModelProviderAccountAdapterRegistry([
  new AnthropicModelProviderAccountAdapter(),
  new OpenAIModelProviderAccountAdapter(),
  new XaiModelProviderAccountAdapter(),
]);
