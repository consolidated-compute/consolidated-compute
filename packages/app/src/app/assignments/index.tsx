import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AssignmentsScreen } from "@/assignments/screen";

const LIST_VIEW = { kind: "list" } as const;

export default function AssignmentsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <AssignmentsScreen view={LIST_VIEW} />
    </HostRouteBootstrapBoundary>
  );
}
