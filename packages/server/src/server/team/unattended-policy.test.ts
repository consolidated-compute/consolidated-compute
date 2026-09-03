import { describe, expect, test } from "vitest";

import type {
  PersistedTeamResolvedLaunch,
  PersistedTeamRunRecord,
  TeamRunUnattendedPolicyInput,
} from "./model.js";
import {
  enforceTeamRunUnattendedConcurrency,
  freezeTeamRunUnattendedPolicy,
  requireMatchingTeamRunUnattendedPolicy,
  TeamRunUnattendedPolicyError,
} from "./unattended-policy.js";

const admittedAt = "2026-09-02T12:00:00.000Z";
const launch: PersistedTeamResolvedLaunch = {
  profileId: "builder",
  provider: "codex",
  model: "gpt-5.4",
  modeId: "default",
  thinkingOptionId: "high",
  featureValues: {},
};

function schedulePolicy(
  overrides: Partial<TeamRunUnattendedPolicyInput> = {},
): TeamRunUnattendedPolicyInput {
  return {
    source: { type: "schedule", scopeId: "schedule-1" },
    executionWindow: { type: "schedule" },
    maxRuntimeMs: 60_000,
    maxActiveRunsOnHost: 3,
    maxActiveRunsForSource: 1,
    launchAllowlist: [{ provider: "codex", models: ["gpt-5.4"] }],
    ...overrides,
  };
}

function freeze(policy = schedulePolicy()) {
  return freezeTeamRunUnattendedPolicy({
    policy,
    launches: [{ roleId: "role-builder", resolvedLaunch: launch }],
    admittedAt,
  });
}

describe("unattended Team Run policy", () => {
  test("freezes an absolute deadline and the exact admitted bounds", () => {
    expect(freeze()).toEqual({
      ...schedulePolicy(),
      deadlineAt: "2026-09-02T12:01:00.000Z",
    });
  });

  test("uses the event window close as the earlier deadline", () => {
    const policy = schedulePolicy({
      source: { type: "hub", scopeId: "relationship-1:authorization-1" },
      executionWindow: {
        type: "event",
        opensAt: "2026-09-02T11:59:00.000Z",
        closesAt: "2026-09-02T12:00:30.000Z",
      },
    });

    expect(freeze(policy).deadlineAt).toBe("2026-09-02T12:00:30.000Z");
  });

  test("rejects admissions outside event windows and exact launch allowlists", () => {
    expect(() =>
      freeze(
        schedulePolicy({
          source: { type: "hub", scopeId: "authorization-1" },
          executionWindow: {
            type: "event",
            opensAt: "2026-09-02T12:01:00.000Z",
            closesAt: "2026-09-02T12:02:00.000Z",
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining<TeamRunUnattendedPolicyError>({
        issue: "outside_execution_window",
      }),
    );
    expect(() =>
      freeze(schedulePolicy({ launchAllowlist: [{ provider: "codex", models: ["gpt-5.3"] }] })),
    ).toThrowError(
      expect.objectContaining<TeamRunUnattendedPolicyError>({ issue: "launch_not_allowed" }),
    );
  });

  test("checks every resolved role instead of accepting after the first allowed launch", () => {
    const reviewerLaunch: PersistedTeamResolvedLaunch = {
      ...launch,
      profileId: "reviewer",
      provider: "claude",
      model: null,
    };

    expect(() =>
      freezeTeamRunUnattendedPolicy({
        policy: schedulePolicy(),
        launches: [
          { roleId: "role-builder", resolvedLaunch: launch },
          { roleId: "role-reviewer", resolvedLaunch: reviewerLaunch },
        ],
        admittedAt,
      }),
    ).toThrowError(
      expect.objectContaining<TeamRunUnattendedPolicyError>({ issue: "launch_not_allowed" }),
    );
  });

  test("treats the frozen policy as part of idempotent admission identity", () => {
    const persisted = freeze();
    expect(() => requireMatchingTeamRunUnattendedPolicy(persisted, schedulePolicy())).not.toThrow();
    expect(() =>
      requireMatchingTeamRunUnattendedPolicy(persisted, schedulePolicy({ maxRuntimeMs: 30_000 })),
    ).toThrowError(
      expect.objectContaining<TeamRunUnattendedPolicyError>({ issue: "invalid_policy" }),
    );
  });

  test("enforces source and host active-run limits without counting attended runs", () => {
    const policy = freeze();
    const activeState = { status: "queued" as const };
    const sourceRun: Pick<PersistedTeamRunRecord, "unattendedPolicy" | "state"> = {
      unattendedPolicy: policy,
      state: activeState,
    };
    const otherSourceRun: Pick<PersistedTeamRunRecord, "unattendedPolicy" | "state"> = {
      unattendedPolicy: freeze(
        schedulePolicy({ source: { type: "schedule", scopeId: "schedule-2" } }),
      ),
      state: activeState,
    };
    const attendedRun: Pick<PersistedTeamRunRecord, "unattendedPolicy" | "state"> = {
      state: activeState,
    };

    expect(() =>
      enforceTeamRunUnattendedConcurrency(policy, [sourceRun, attendedRun]),
    ).toThrowError(
      expect.objectContaining<TeamRunUnattendedPolicyError>({ issue: "source_active_run_limit" }),
    );
    const hostLimited = freeze(
      schedulePolicy({ maxActiveRunsOnHost: 1, maxActiveRunsForSource: 1 }),
    );
    expect(() =>
      enforceTeamRunUnattendedConcurrency(hostLimited, [otherSourceRun, attendedRun]),
    ).toThrowError(
      expect.objectContaining<TeamRunUnattendedPolicyError>({ issue: "host_active_run_limit" }),
    );
  });
});
