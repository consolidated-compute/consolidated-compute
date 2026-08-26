import { useMemo } from "react";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TeamRunScreen } from "@/teams/team-run-screen";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default function TeamRunRoute() {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    teamId?: string | string[];
    runId?: string | string[];
  }>();
  const identity = useMemo(
    () => ({
      serverId: first(params.serverId),
      teamId: first(params.teamId),
      runId: first(params.runId),
    }),
    [params.runId, params.serverId, params.teamId],
  );
  return (
    <HostRouteBootstrapBoundary>
      <TeamRunScreen {...identity} />
    </HostRouteBootstrapBoundary>
  );
}
