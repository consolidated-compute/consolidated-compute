import { useCallback } from "react";
import type { AgentProfile, AgentProfilePatch } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { assertAgentProfilePatchesSupported, supportsAgentProfiles } from "./capabilities";

export interface UseAgentProfilesResult {
  /** `null` until the daemon config has arrived. */
  profiles: AgentProfile[] | null;
  /** False on daemons that predate agent profiles, or while disconnected. */
  isSupported: boolean;
  /** Writes the whole list; there is no per-profile RPC. */
  saveProfiles: (next: AgentProfilePatch[]) => Promise<void>;
}

export function useAgentProfiles(serverId: string | null): UseAgentProfilesResult {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const features = useSessionStore((state) => state.sessions[serverId ?? ""]?.serverInfo?.features);
  const isSupported = supportsAgentProfiles(features);

  const saveProfiles = useCallback(
    async (next: AgentProfilePatch[]) => {
      assertAgentProfilePatchesSupported(features, next);
      await patchConfig({ agentProfiles: next });
    },
    [features, patchConfig],
  );

  return {
    profiles: config ? (config.agentProfiles ?? []) : null,
    isSupported,
    saveProfiles,
  };
}
