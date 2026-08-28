import { useMemo } from "react";
import type {
  AssignmentCollectionIssueDto,
  AssignmentDto,
} from "@getpaseo/protocol/assignment/types";
import { useFetchQueries, useFetchQuery } from "@/data/query";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import {
  assignmentListQueryKey,
  assignmentQueryKey,
  resolveAssignmentHostState,
  type AggregatedAssignment,
  type AssignmentHostState,
  type AssignmentListData,
} from "./data";

const ASSIGNMENT_LIST_REFRESH_INTERVAL_MS = 5_000;

export interface UseAssignmentsResult {
  hosts: AssignmentHostState[];
  assignments: AggregatedAssignment[];
  issues: Array<AssignmentCollectionIssueDto & { serverId: string; serverName: string }>;
  refetchHost: (serverId: string) => void;
  refetchAll: () => void;
  isRefetching: boolean;
}

export function useAssignments(): UseAssignmentsResult {
  const configuredHosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => configuredHosts.map((host) => host.serverId), [configuredHosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const assignmentFeatures = useHostFeatureAvailabilityMap(serverIds, "assignments");
  const queries = useFetchQueries<AssignmentListData>(
    configuredHosts.map((host) => {
      const status = connectionStatuses.get(host.serverId) ?? "connecting";
      const supported = assignmentFeatures.get(host.serverId) === true;
      return {
        queryKey: assignmentListQueryKey(host.serverId),
        dataShape: "list" as const,
        staleTimeMs: ASSIGNMENT_LIST_REFRESH_INTERVAL_MS,
        refetchInterval: ASSIGNMENT_LIST_REFRESH_INTERVAL_MS,
        enabled: status === "online" && supported,
        queryFn: async (): Promise<AssignmentListData> => {
          const client = runtime.getClient(host.serverId);
          if (!client) throw new Error("Host is offline");
          const payload = await client.listAssignments();
          return { assignments: payload.assignments, issues: payload.issues ?? [] };
        },
      };
    }),
  );

  const hosts = useMemo(
    () =>
      configuredHosts.map((host, index) => {
        const snapshot = runtime.getSnapshot(host.serverId);
        const query = queries[index]!;
        return resolveAssignmentHostState({
          serverId: host.serverId,
          serverName: host.label || host.serverId,
          connectionStatus: connectionStatuses.get(host.serverId) ?? "connecting",
          assignmentsFeature: assignmentFeatures.get(host.serverId) ?? null,
          query: {
            data: query.data,
            isLoading: query.isLoading,
            isError: query.isError,
            error: query.error,
          },
          connectionError: snapshot?.lastError ?? null,
        });
      }),
    [assignmentFeatures, configuredHosts, connectionStatuses, queries, runtime],
  );

  return {
    hosts,
    assignments: hosts.flatMap((host) => host.assignments),
    issues: hosts.flatMap((host) =>
      host.issues.map((issue) => ({
        ...issue,
        serverId: host.serverId,
        serverName: host.serverName,
      })),
    ),
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

export function useAssignment(
  serverId: string,
  assignmentId: string,
  options: { enabled?: boolean } = {},
) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery<AssignmentDto>({
    queryKey: assignmentQueryKey(serverId, assignmentId),
    dataShape: "value",
    staleTimeMs: 0,
    enabled: Boolean((options.enabled ?? true) && client && connected && assignmentId),
    queryFn: async () => {
      if (!client) throw new Error("Host is offline");
      const payload = await client.getAssignment(assignmentId);
      return payload.assignment;
    },
  });
}
