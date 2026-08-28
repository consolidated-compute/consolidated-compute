import type { AgentProfilePatch } from "@getpaseo/protocol/messages";

interface AgentProfileCapabilities {
  agentProfiles?: boolean;
  agentConfigApply?: boolean;
  // COMPAT(agentProfileProviderOptions): added in v0.6.2, remove after 2027-02-28.
  agentProfileProviderOptions?: boolean;
}

export function supportsAgentProfiles(features: AgentProfileCapabilities | undefined): boolean {
  return features?.agentProfiles === true && features.agentConfigApply === true;
}

export function supportsAgentProfileProviderOptions(
  features: AgentProfileCapabilities | undefined,
): boolean {
  return features?.agentProfileProviderOptions === true;
}

export function assertAgentProfilePatchesSupported(
  features: AgentProfileCapabilities | undefined,
  profiles: readonly AgentProfilePatch[],
): void {
  if (
    profiles.some((profile) => profile.providerOptions === null) &&
    !supportsAgentProfileProviderOptions(features)
  ) {
    throw new Error("Changing this Agent Profile's provider requires updating this Paseo host.");
  }
}
