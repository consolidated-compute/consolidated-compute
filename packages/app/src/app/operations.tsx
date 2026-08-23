import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { OperationsScreen } from "@/operations/screen";

export default function OperationsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <OperationsScreen />
    </HostRouteBootstrapBoundary>
  );
}
