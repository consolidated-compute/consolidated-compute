import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TeamsScreen } from "@/teams/screen";

const LIST_VIEW = { kind: "list" } as const;

export default function TeamsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <TeamsScreen view={LIST_VIEW} />
    </HostRouteBootstrapBoundary>
  );
}
