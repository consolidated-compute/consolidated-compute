import { useEffect } from "react";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { TeamRunFormModel, TeamRunFormState } from "./run-form-model";

export function useTeamRunFormProviderSnapshot(model: TeamRunFormModel, state: TeamRunFormState) {
  const snapshot = useProvidersSnapshot(state.serverId, {
    cwd: state.selectedWorkspaceCwd,
    enabled: state.selectedWorkspaceCwd !== null,
  });

  useEffect(() => {
    const workspaceId = state.selectedWorkspaceId;
    const workspaceCwd = state.selectedWorkspaceCwd;
    if (!workspaceId || !workspaceCwd) return;
    model.applyProviderCatalog(
      workspaceId,
      workspaceCwd,
      snapshot.entries ?? (snapshot.error ? [] : null),
    );
  }, [
    model,
    snapshot.entries,
    snapshot.error,
    state.selectedWorkspaceCwd,
    state.selectedWorkspaceId,
  ]);

  return snapshot;
}
