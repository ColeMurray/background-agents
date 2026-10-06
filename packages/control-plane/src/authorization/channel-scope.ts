import { teamChannelBindingProviderSchema } from "@open-inspect/shared/types/team-channel-bindings";

/** The provider prefix prevents one bot from selecting another integration's scope. */
export function parseChannelScope(value: string) {
  const match = /^([^:]+):([^:\s]+)$/.exec(value);
  if (!match) return null;
  const provider = teamChannelBindingProviderSchema.safeParse(match[1]);
  return provider.success ? { provider: provider.data, externalId: match[2] } : null;
}
