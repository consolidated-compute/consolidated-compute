import { useEffect, useMemo } from "react";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import { useFetchQueries } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  buildTeamRunFeatureProbes,
  buildTeamRunFeatureRequest,
  type TeamRunFormModel,
  type TeamRunFormState,
} from "./run-form-model";

export function useTeamRunFormFeatureCatalogs(model: TeamRunFormModel, state: TeamRunFormState) {
  const client = useHostRuntimeClient(state.serverId);
  const connected = useHostRuntimeIsConnected(state.serverId);
  const requests = useMemo(
    () =>
      state.roleResolutions.flatMap((resolution) => {
        const request = buildTeamRunFeatureRequest(
          resolution,
          state.selectedWorkspaceCwd,
          state.catalogGeneration,
        );
        return request ? [request] : [];
      }),
    [state.catalogGeneration, state.roleResolutions, state.selectedWorkspaceCwd],
  );
  const probes = useMemo(() => buildTeamRunFeatureProbes(requests), [requests]);
  const queries = useFetchQueries<readonly AgentFeature[]>(
    probes.map((probe) => ({
      queryKey: ["teamRunFeatures", state.serverId, probe.requestKey],
      dataShape: "value" as const,
      staleTimeMs: 0,
      enabled: Boolean(client && connected),
      queryFn: async () => {
        if (!client) throw new Error("Host is offline");
        const payload = await client.listProviderFeatures(probe.config);
        if (payload.error) throw new Error(payload.error);
        return payload.features ?? [];
      },
    })),
  );

  useEffect(() => {
    probes.forEach((probe, index) => {
      const query = queries[index];
      if (query?.data) {
        probe.roleIds.forEach((roleId) =>
          model.applyFeatureCatalog(roleId, probe.requestKey, query.data),
        );
      } else if (query?.isError) {
        probe.roleIds.forEach((roleId) =>
          model.applyFeatureCatalog(roleId, probe.requestKey, null),
        );
      }
    });
  }, [model, probes, queries]);

  return { connected };
}
