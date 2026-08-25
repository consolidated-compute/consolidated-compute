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

/** Apply the canonical trim-and-default rules shared by every profile consumer. */
export function materializeAgentProfile(profile: AgentProfile): MaterializedAgentProfile {
  return {
    provider: trimmed(profile.provider),
    modelId: trimmed(profile.model),
    modeId: trimmed(profile.modeId),
    thinkingOptionId: trimmed(profile.thinkingOptionId),
    featureValues: profile.featureValues ?? {},
  };
}
