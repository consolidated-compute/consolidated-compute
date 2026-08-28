interface AgentProfileCapabilities {
  agentProfiles?: boolean;
  agentConfigApply?: boolean;
  // COMPAT(agentProfileProviderOptions): added in v0.6.2, remove after 2027-02-28.
  agentProfileProviderOptions?: boolean;
}

export function supportsAgentProfiles(features: AgentProfileCapabilities | undefined): boolean {
  return (
    features?.agentProfiles === true &&
    features.agentConfigApply === true &&
    features.agentProfileProviderOptions === true
  );
}
