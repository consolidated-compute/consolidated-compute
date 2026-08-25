import {
  materializeAgentProfile,
  type MaterializedAgentProfile,
} from "@getpaseo/protocol/agent-profiles";
import type { AgentConfigApply } from "@getpaseo/protocol/messages";

export { materializeAgentProfile };
export type { MaterializedAgentProfile };

/** Drop a saved mode that the live agent's provider no longer offers. */
export function reconcileMaterializedProfileMode(
  profile: MaterializedAgentProfile,
  availableModeIds: readonly string[] | null,
): MaterializedAgentProfile | null {
  if (availableModeIds === null) {
    return null;
  }
  if (!profile.modeId || availableModeIds.includes(profile.modeId)) {
    return profile;
  }
  return { ...profile, modeId: "" };
}

/**
 * The payload for a running agent. Omitted fields are left alone by the daemon,
 * so a profile that names no mode does not reset the agent's mode. Provider is
 * absent because a running agent cannot change the process it is.
 */
export function toAgentConfigApply(profile: MaterializedAgentProfile): AgentConfigApply {
  return {
    ...(profile.modelId ? { modelId: profile.modelId } : {}),
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    ...(Object.keys(profile.featureValues).length > 0
      ? { featureValues: profile.featureValues }
      : {}),
  };
}
