import type { OperationsHostFacts, OperationsModel } from "./model";

export type OperationsBodyState =
  | { kind: "initial_loading" }
  | { kind: "empty" }
  | { kind: "all_hosts_unavailable" }
  | { kind: "content" };

export interface OperationsAvailability {
  body: OperationsBodyState;
  unavailableHosts: readonly OperationsHostFacts[];
  areAllHostsUnavailable: boolean;
}

function isUnavailable(host: OperationsHostFacts): boolean {
  return host.state.kind === "offline" || host.state.kind === "error";
}

export function resolveOperationsAvailability(model: OperationsModel): OperationsAvailability {
  const unavailableHosts = model.hosts.filter(isUnavailable);
  const areAllHostsUnavailable =
    model.hosts.length > 0 && unavailableHosts.length === model.hosts.length;

  let body: OperationsBodyState;
  if (model.isInitialLoading) body = { kind: "initial_loading" };
  else if (model.agentCount > 0) body = { kind: "content" };
  else if (areAllHostsUnavailable) body = { kind: "all_hosts_unavailable" };
  else body = { kind: "empty" };

  return { body, unavailableHosts, areAllHostsUnavailable };
}
