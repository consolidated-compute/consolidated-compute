import equal from "fast-deep-equal";

import {
  PersistedTeamRunUnattendedPolicySchema,
  TeamRunUnattendedPolicyInputSchema,
  isActiveTeamRunStatus,
  type PersistedTeamResolvedLaunch,
  type PersistedTeamRunRecord,
  type PersistedTeamRunUnattendedPolicy,
  type TeamRunUnattendedPolicyInput,
} from "./model.js";

export type TeamRunUnattendedPolicyIssue =
  | "invalid_policy"
  | "outside_execution_window"
  | "launch_not_allowed"
  | "host_active_run_limit"
  | "source_active_run_limit"
  | "deadline_elapsed";

export class TeamRunUnattendedPolicyError extends Error {
  readonly code = "team_unattended_policy_rejected";

  constructor(
    readonly issue: TeamRunUnattendedPolicyIssue,
    message: string,
  ) {
    super(message);
    this.name = "TeamRunUnattendedPolicyError";
  }
}

export interface TeamRunUnattendedLaunch {
  roleId: string;
  resolvedLaunch: PersistedTeamResolvedLaunch;
}

export function freezeTeamRunUnattendedPolicy(input: {
  policy: TeamRunUnattendedPolicyInput;
  launches: readonly TeamRunUnattendedLaunch[];
  admittedAt: string;
}): PersistedTeamRunUnattendedPolicy {
  const parsed = TeamRunUnattendedPolicyInputSchema.safeParse(input.policy);
  if (!parsed.success) {
    throw new TeamRunUnattendedPolicyError(
      "invalid_policy",
      `Invalid unattended Team Run policy: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  const admittedAtMs = Date.parse(input.admittedAt);
  const window = parsed.data.executionWindow;
  if (
    window.type === "event" &&
    (admittedAtMs < Date.parse(window.opensAt) || admittedAtMs >= Date.parse(window.closesAt))
  ) {
    throw new TeamRunUnattendedPolicyError(
      "outside_execution_window",
      "Unattended Team Run admission is outside its allowed event execution window",
    );
  }

  for (const launch of input.launches) {
    const provider = parsed.data.launchAllowlist.find(
      (entry) => entry.provider === launch.resolvedLaunch.provider,
    );
    if (!provider?.models.includes(launch.resolvedLaunch.model)) {
      throw new TeamRunUnattendedPolicyError(
        "launch_not_allowed",
        `Role '${launch.roleId}' resolves to disallowed launch '${launch.resolvedLaunch.provider}/${launch.resolvedLaunch.model ?? "[provider default]"}'`,
      );
    }
  }

  const runtimeDeadline = admittedAtMs + parsed.data.maxRuntimeMs;
  const deadlineAtMs =
    window.type === "event"
      ? Math.min(runtimeDeadline, Date.parse(window.closesAt))
      : runtimeDeadline;
  return PersistedTeamRunUnattendedPolicySchema.parse({
    ...parsed.data,
    deadlineAt: new Date(deadlineAtMs).toISOString(),
  });
}

export function requireMatchingTeamRunUnattendedPolicy(
  persisted: PersistedTeamRunUnattendedPolicy | undefined,
  requested: TeamRunUnattendedPolicyInput | undefined,
): void {
  if (persisted === undefined && requested === undefined) return;
  if (persisted === undefined || requested === undefined) {
    throw new TeamRunUnattendedPolicyError(
      "invalid_policy",
      "The idempotent Team Run admission changed its unattended policy",
    );
  }
  const parsed = TeamRunUnattendedPolicyInputSchema.safeParse(requested);
  if (!parsed.success) {
    throw new TeamRunUnattendedPolicyError(
      "invalid_policy",
      `Invalid unattended Team Run policy: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  const { deadlineAt: _deadlineAt, ...persistedInput } = persisted;
  if (!equal(persistedInput, parsed.data)) {
    throw new TeamRunUnattendedPolicyError(
      "invalid_policy",
      "The idempotent Team Run admission changed its unattended policy",
    );
  }
}

export function enforceTeamRunUnattendedConcurrency(
  policy: PersistedTeamRunUnattendedPolicy,
  existingRuns: readonly Pick<PersistedTeamRunRecord, "unattendedPolicy" | "state">[],
): void {
  const active = existingRuns.filter(
    (run) => run.unattendedPolicy && isActiveTeamRunStatus(run.state.status),
  );
  const activeForSource = active.filter(
    (run) =>
      run.unattendedPolicy?.source.type === policy.source.type &&
      run.unattendedPolicy.source.scopeId === policy.source.scopeId,
  );
  if (activeForSource.length >= policy.maxActiveRunsForSource) {
    throw new TeamRunUnattendedPolicyError(
      "source_active_run_limit",
      `Unattended source '${policy.source.type}:${policy.source.scopeId}' reached its active Team Run limit`,
    );
  }
  if (active.length >= policy.maxActiveRunsOnHost) {
    throw new TeamRunUnattendedPolicyError(
      "host_active_run_limit",
      "This host reached its active unattended Team Run limit",
    );
  }
}

export function requireTeamRunUnattendedDeadlineOpen(
  run: Pick<PersistedTeamRunRecord, "id" | "unattendedPolicy">,
  commitAt: string,
): void {
  if (run.unattendedPolicy && Date.parse(commitAt) >= Date.parse(run.unattendedPolicy.deadlineAt)) {
    throw new TeamRunUnattendedPolicyError(
      "deadline_elapsed",
      `Unattended Team Run ${run.id} reached its frozen deadline`,
    );
  }
}
