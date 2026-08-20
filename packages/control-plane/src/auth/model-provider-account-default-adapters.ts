import { ModelProviderAccountAdapterRegistry } from "./model-provider-account-adapters";
import { OpenAIModelProviderAccountAdapter } from "./model-provider-account-openai-adapter";
import { XaiModelProviderAccountAdapter } from "./model-provider-account-xai-adapter";

export const modelProviderAccountAdapterRegistry = new ModelProviderAccountAdapterRegistry([
  new OpenAIModelProviderAccountAdapter(),
  new XaiModelProviderAccountAdapter(),
]);
