import { useEffect, useMemo } from "react";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import { useFetchQueries } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
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
  const queries = useFetchQueries<readonly AgentFeature[]>(
    requests.map((request) => ({
      queryKey: ["teamRunFeatures", state.serverId, request.requestKey],
      dataShape: "value" as const,
      staleTimeMs: 0,
      enabled: Boolean(client && connected),
      queryFn: async () => {
        if (!client) throw new Error("Host is offline");
        const payload = await client.listProviderFeatures(request.config);
        if (payload.error) throw new Error(payload.error);
        return payload.features ?? [];
      },
    })),
  );

  useEffect(() => {
    requests.forEach((request, index) => {
      const query = queries[index];
      if (query?.data) {
        model.applyFeatureCatalog(request.roleId, request.requestKey, query.data);
      } else if (query?.isError) {
        model.applyFeatureCatalog(request.roleId, request.requestKey, null);
      }
    });
  }, [model, queries, requests]);

  return { connected };
}
