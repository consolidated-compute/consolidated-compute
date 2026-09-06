import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { GitHubWorkScreen } from "@/github-work/screen";

export default function GitHubWorkRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <GitHubWorkScreen />
    </HostRouteBootstrapBoundary>
  );
}
