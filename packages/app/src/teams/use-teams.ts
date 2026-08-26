import { useMemo } from "react";
import type { TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import { useFetchQueries } from "@/data/query";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  resolveTeamHostState,
  teamListQueryKey,
  type AggregatedTeam,
  type TeamHostState,
} from "./data";

export interface UseTeamsResult {
  hosts: TeamHostState[];
  teams: AggregatedTeam[];
  refetchHost: (serverId: string) => void;
  refetchAll: () => void;
  isRefetching: boolean;
}

export function useTeams(): UseTeamsResult {
  const configuredHosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => configuredHosts.map((host) => host.serverId), [configuredHosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const teamsFeatures = useHostFeatureAvailabilityMap(serverIds, "teams");
  const profileFeatures = useHostFeatureAvailabilityMap(serverIds, "agentProfiles");
  const queries = useFetchQueries<TeamDefinitionDto[]>(
    configuredHosts.map((host) => {
      const status = connectionStatuses.get(host.serverId) ?? "connecting";
      const supported = teamsFeatures.get(host.serverId) === true;
      return {
        queryKey: teamListQueryKey(host.serverId),
        dataShape: "list" as const,
        staleTimeMs: 5_000,
        enabled: status === "online" && supported,
        queryFn: async () => {
          const client = runtime.getClient(host.serverId);
          if (!client) throw new Error("Host is offline");
          const payload = await client.listTeams();
          return payload.teams;
        },
      };
    }),
  );

  const hosts = useMemo(
    () =>
      configuredHosts.map((host, index) => {
        const snapshot = runtime.getSnapshot(host.serverId);
        const query = queries[index]!;
        return resolveTeamHostState({
          serverId: host.serverId,
          serverName: host.label || host.serverId,
          connectionStatus: connectionStatuses.get(host.serverId) ?? "connecting",
          teamsFeature: teamsFeatures.get(host.serverId) ?? null,
          agentProfilesFeature: profileFeatures.get(host.serverId) ?? null,
          query: {
            data: query.data,
            isLoading: query.isLoading,
            isError: query.isError,
            error: query.error,
          },
          connectionError: snapshot?.lastError ?? null,
        });
      }),
    [configuredHosts, connectionStatuses, profileFeatures, queries, runtime, teamsFeatures],
  );

  const teams = useMemo(() => hosts.flatMap((host) => host.teams), [hosts]);

  return {
    hosts,
    teams,
    refetchHost: (serverId) => {
      const index = configuredHosts.findIndex((host) => host.serverId === serverId);
      if (index >= 0) void queries[index]?.refetch();
    },
    refetchAll: () => {
      for (const query of queries) void query.refetch();
    },
    isRefetching: queries.some((query) => query.isRefetching),
  };
}
