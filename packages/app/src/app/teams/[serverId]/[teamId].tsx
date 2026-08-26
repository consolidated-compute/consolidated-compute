import { useMemo } from "react";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TeamsScreen } from "@/teams/screen";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default function TeamDetailRoute() {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    teamId?: string | string[];
  }>();
  const view = useMemo(
    () => ({
      kind: "detail" as const,
      serverId: first(params.serverId),
      teamId: first(params.teamId),
    }),
    [params.serverId, params.teamId],
  );
  return (
    <HostRouteBootstrapBoundary>
      <TeamsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
