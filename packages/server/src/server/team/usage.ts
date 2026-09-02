import type { TeamRunUsageDto } from "@getpaseo/protocol/team/types";
import type { AgentUsage } from "../agent/agent-sdk-types.js";
import {
  PersistedTeamRunStepUsageSchema,
  isTerminalTeamRunStepStatus,
  type PersistedTeamRunRecord,
  type PersistedTeamRunStepUsage,
} from "./model.js";

const ADDITIVE_USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "totalCostUsd",
] as const satisfies readonly (keyof AgentUsage)[];

const POINT_IN_TIME_USAGE_FIELDS = [
  "contextWindowMaxTokens",
  "contextWindowUsedTokens",
] as const satisfies readonly (keyof AgentUsage)[];

export function snapshotTeamRunStepUsage(
  reports: readonly (AgentUsage | undefined)[],
): PersistedTeamRunStepUsage {
  const sanitized = reports.map(sanitizeUsage);
  const reported = sanitized.filter((usage): usage is AgentUsage => usage !== null);
  if (reported.length === 0) return { status: "unavailable" };

  const values: AgentUsage = {};
  for (const field of ADDITIVE_USAGE_FIELDS) {
    const available = reported.flatMap((usage) =>
      usage[field] === undefined ? [] : [usage[field]],
    );
    if (available.length > 0) values[field] = available.reduce((sum, value) => sum + value, 0);
  }
  const latest = reported.at(-1)!;
  for (const field of POINT_IN_TIME_USAGE_FIELDS) {
    if (latest[field] !== undefined) values[field] = latest[field];
  }

  return PersistedTeamRunStepUsageSchema.parse({
    status: reported.length === reports.length ? "reported" : "partial",
    ...values,
  });
}

export function aggregateTeamRunUsage(run: Pick<PersistedTeamRunRecord, "steps">): TeamRunUsageDto {
  const settled = run.steps.filter((step) => isTerminalTeamRunStepStatus(step.state.status));
  const reported = settled.flatMap((step) => {
    if (step.state.status !== "succeeded") return [];
    const usage = step.state.usage;
    return usage && usage.status !== "unavailable" ? [usage] : [];
  });
  const unavailableSteps = settled.length - reported.length;
  const hasPartialStep = reported.some((usage) => usage.status === "partial");
  let status: TeamRunUsageDto["status"] = "reported";
  if (reported.length === 0) status = "unavailable";
  else if (unavailableSteps > 0 || hasPartialStep) status = "partial";
  const totals: AgentUsage = {};
  for (const field of ADDITIVE_USAGE_FIELDS) {
    const values = reported.flatMap((usage) => (usage[field] === undefined ? [] : [usage[field]]));
    if (values.length > 0) totals[field] = values.reduce((sum, value) => sum + value, 0);
  }
  return {
    status,
    reportedSteps: reported.length,
    unavailableSteps,
    ...totals,
  };
}

function sanitizeUsage(usage: AgentUsage | undefined): AgentUsage | null {
  if (!usage) return null;
  const sanitized: AgentUsage = {};
  for (const field of [...ADDITIVE_USAGE_FIELDS, ...POINT_IN_TIME_USAGE_FIELDS]) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      sanitized[field] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}
