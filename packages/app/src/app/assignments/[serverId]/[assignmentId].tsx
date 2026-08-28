import { useMemo } from "react";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AssignmentsScreen } from "@/assignments/screen";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default function AssignmentDetailRoute() {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    assignmentId?: string | string[];
  }>();
  const view = useMemo(
    () => ({
      kind: "detail" as const,
      serverId: first(params.serverId),
      assignmentId: first(params.assignmentId),
    }),
    [params.assignmentId, params.serverId],
  );
  return (
    <HostRouteBootstrapBoundary>
      <AssignmentsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
