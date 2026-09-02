import { useMemo } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import type { TeamRunSupervisionStateDto } from "@getpaseo/protocol/team/types";
import { useFetchInfiniteQuery, useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  flattenTeamRunSupervisionEventPages,
  teamRunSupervisionEventsQueryKey,
  teamRunSupervisionQueryKey,
  type TeamRunSupervisionEventPage,
} from "./supervision-data";

const SUPERVISION_EVENT_PAGE_LIMIT = 50;
const ACTIVE_SUPERVISION_REFRESH_INTERVAL_MS = 2_000;

interface TeamRunSupervisionQueryOptions {
  enabled?: boolean;
  runIsActive?: boolean;
}

function useTeamSupervisionCapability(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.teamSupervision === true,
  );
}

export function useTeamRunSupervision(
  serverId: string,
  runId: string,
  options: TeamRunSupervisionQueryOptions = {},
) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useTeamSupervisionCapability(serverId);
  const enabled = Boolean((options.enabled ?? true) && supported && client && connected && runId);
  const query = useFetchQuery<
    TeamRunSupervisionStateDto,
    Error,
    TeamRunSupervisionStateDto,
    ReturnType<typeof teamRunSupervisionQueryKey>
  >({
    queryKey: teamRunSupervisionQueryKey(serverId, runId),
    dataShape: "value",
    enabled,
    staleTimeMs: 0,
    refetchInterval: options.runIsActive ? ACTIVE_SUPERVISION_REFRESH_INTERVAL_MS : false,
    queryFn: async () => {
      if (!client) throw new Error("Host is offline");
      const payload = await client.getTeamRunSupervision(runId);
      return payload.supervision;
    },
  });
  return { ...query, supported, canLoad: enabled };
}

export function useTeamRunSupervisionEvents(
  serverId: string,
  runId: string,
  options: TeamRunSupervisionQueryOptions = {},
) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useTeamSupervisionCapability(serverId);
  const enabled = Boolean((options.enabled ?? true) && supported && client && connected && runId);
  const queryKey = useMemo(
    () => teamRunSupervisionEventsQueryKey(serverId, runId),
    [runId, serverId],
  );
  const query = useFetchInfiniteQuery<
    TeamRunSupervisionEventPage,
    Error,
    InfiniteData<TeamRunSupervisionEventPage, string | null>,
    ReturnType<typeof teamRunSupervisionEventsQueryKey>,
    string | null
  >({
    queryKey,
    dataShape: "list",
    enabled,
    initialPageParam: null,
    staleTimeMs: 0,
    refetchInterval: options.runIsActive ? ACTIVE_SUPERVISION_REFRESH_INTERVAL_MS : false,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      if (!client) throw new Error("Host is offline");
      const payload = await client.listTeamRunSupervisionEvents({
        runId,
        limit: SUPERVISION_EVENT_PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      return { events: payload.events, nextCursor: payload.nextCursor };
    },
  });
  const events = useMemo(
    () => flattenTeamRunSupervisionEventPages(query.data?.pages ?? []),
    [query.data?.pages],
  );
  return { ...query, events, supported, canLoad: enabled };
}
