import type { OperationsHostFacts, OperationsModel } from "./model";

export type OperationsBodyState =
  | { kind: "initial_loading" }
  | { kind: "empty" }
  | { kind: "all_hosts_unavailable" }
  | { kind: "content" };

export interface OperationsAvailability {
  body: OperationsBodyState;
  unavailableHosts: readonly OperationsHostFacts[];
  providerSubagentIssueHosts: readonly OperationsHostFacts[];
  areAllHostsUnavailable: boolean;
  isPartiallyLoading: boolean;
}

export function shouldShowUnavailableHostsAlert(
  availability: Pick<OperationsAvailability, "body" | "unavailableHosts">,
): boolean {
  return (
    availability.unavailableHosts.length > 0 && availability.body.kind !== "all_hosts_unavailable"
  );
}

function isUnavailable(host: OperationsHostFacts): boolean {
  return host.state.kind === "offline" || host.state.kind === "error";
}

export function resolveOperationsAvailability(model: OperationsModel): OperationsAvailability {
  const unavailableHosts = model.hosts.filter(isUnavailable);
  const providerSubagentIssueHosts = model.hosts.filter((host) => {
    const state = host.providerSubagentActivity;
    return state?.kind === "unsupported" || state?.kind === "error";
  });
  const areAllHostsUnavailable =
    model.hosts.length > 0 && unavailableHosts.length === model.hosts.length;
  const isPartiallyLoading =
    !model.isInitialLoading &&
    model.hosts.some(
      (host) =>
        host.state.kind === "initial_loading" ||
        host.providerSubagentActivity?.kind === "initial_loading" ||
        host.providerSubagentActivity?.kind === "loading",
    );

  let body: OperationsBodyState;
  if (model.isInitialLoading) body = { kind: "initial_loading" };
  else if (model.agentCount > 0) body = { kind: "content" };
  else if (areAllHostsUnavailable) body = { kind: "all_hosts_unavailable" };
  else body = { kind: "empty" };

  return {
    body,
    unavailableHosts,
    providerSubagentIssueHosts,
    areAllHostsUnavailable,
    isPartiallyLoading,
  };
}
