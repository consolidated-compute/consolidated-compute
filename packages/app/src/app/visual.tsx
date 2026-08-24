import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { VisualScreen } from "@/operations/visual/screen";

export default function VisualRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <VisualScreen />
    </HostRouteBootstrapBoundary>
  );
}
