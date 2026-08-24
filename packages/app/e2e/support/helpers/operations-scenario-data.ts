export interface OperationsProviderSubagentSeed {
  id: string;
  provider: "claude" | "codex";
  description: string;
  status: "running" | "completed" | "failed" | "canceled";
  subtitle: string;
}

export const OPERATIONS_DUPLICATE_PROVIDER_SUBAGENT_ID = "duplicate-provider-child";

export const OPERATIONS_PRIMARY_PROVIDER_SUBAGENTS: readonly OperationsProviderSubagentSeed[] = [
  {
    id: OPERATIONS_DUPLICATE_PROVIDER_SUBAGENT_ID,
    provider: "codex",
    description: "Review the primary host changes",
    status: "failed",
    subtitle: "Primary host native child",
  },
  {
    id: "primary-running-provider",
    provider: "codex",
    description: "Coordinate active primary work",
    status: "running",
    subtitle: "Live provider child",
  },
  {
    id: "primary-completed-provider",
    provider: "claude",
    description: "Completed primary analysis",
    status: "completed",
    subtitle: "Finished provider child",
  },
  {
    id: "primary-canceled-provider",
    provider: "codex",
    description: "Canceled primary exploration",
    status: "canceled",
    subtitle: "Stopped provider child",
  },
];

export const OPERATIONS_SECONDARY_PROVIDER_SUBAGENTS: readonly OperationsProviderSubagentSeed[] = [
  {
    id: OPERATIONS_DUPLICATE_PROVIDER_SUBAGENT_ID,
    provider: "claude",
    description: "Inspect the secondary host",
    status: "completed",
    subtitle: "Secondary host native child",
  },
  {
    id: "secondary-running-provider",
    provider: "claude",
    description: "Coordinate active secondary work",
    status: "running",
    subtitle: "Live provider child",
  },
  {
    id: "secondary-completed-provider",
    provider: "codex",
    description: "Completed secondary analysis",
    status: "completed",
    subtitle: "Finished provider child",
  },
  {
    id: "secondary-failed-provider",
    provider: "claude",
    description: "Failed secondary verification",
    status: "failed",
    subtitle: "Failed provider child",
  },
];

export function mockProviderSubagentFeatureValue(
  seeds: readonly OperationsProviderSubagentSeed[],
): OperationsProviderSubagentSeed[] {
  return seeds.map((seed) => ({ ...seed }));
}
