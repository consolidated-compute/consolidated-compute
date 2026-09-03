import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export function scheduleInspectionQueryKey(serverId: string, scheduleId: string) {
  return ["scheduleInspection", serverId, scheduleId] as const;
}

export function useScheduleInspection(
  serverId: string,
  scheduleId: string,
  options: { enabled: boolean },
) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery<StoredSchedule>({
    queryKey: scheduleInspectionQueryKey(serverId, scheduleId),
    dataShape: "value",
    staleTimeMs: 5_000,
    refetchInterval: 5_000,
    enabled: Boolean(options.enabled && client && connected && scheduleId),
    queryFn: async () => {
      if (!client) throw new Error("Host is offline");
      const payload = await client.scheduleInspect({ id: scheduleId });
      if (payload.error || !payload.schedule) {
        throw new Error(payload.error ?? "Schedule not found");
      }
      return payload.schedule;
    },
  });
}
