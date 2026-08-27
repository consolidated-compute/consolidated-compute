import type { AgentProfile } from "./messages.js";

/**
 * The launch settings carried by an Agent Profile after blank optional fields
 * have been normalized away.
 */
export interface MaterializedAgentProfile {
  provider: string;
  /** Empty when the profile names no model. */
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  featureValues: Record<string, unknown>;
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizeProfileCompatibility(
  profile: MaterializedAgentProfile,
): MaterializedAgentProfile {
  // COMPAT(opencode-full-access-profile): supported before v0.6, remove after 2027-02-26.
  if (profile.provider !== "opencode" || profile.modeId !== "full-access") {
    return profile;
  }
  return {
    ...profile,
    modeId: "build",
    featureValues: { ...profile.featureValues, auto_accept: true },
  };
}

/** Apply the canonical trim-and-default rules shared by every profile consumer. */
export function materializeAgentProfile(profile: AgentProfile): MaterializedAgentProfile {
  return normalizeProfileCompatibility({
    provider: trimmed(profile.provider),
    modelId: trimmed(profile.model),
    modeId: trimmed(profile.modeId),
    thinkingOptionId: trimmed(profile.thinkingOptionId),
    featureValues: profile.featureValues ?? {},
  });
}
