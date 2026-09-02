import { describe, expect, it } from "vitest";
import type { TeamRunSupervisionStateDto } from "@getpaseo/protocol/team/types";
import {
  flattenTeamRunSupervisionEventPages,
  newestTeamRunSupervisionSummary,
  teamRunSupervisionPresentation,
  toTeamRunSupervisionSummary,
} from "./supervision-data";

const timestamp = "2026-09-01T12:00:00.000Z";

describe("Team supervision data", () => {
  it("deduplicates paginated events without changing daemon order", () => {
    const event = (id: string, sequence: number) => ({
      id,
      sequence,
      kind: "future.event",
      title: `Event ${sequence}`,
      decisionId: null,
      actionId: null,
      workItemId: null,
      attemptId: null,
      humanRequestId: null,
      roleIds: [],
      agentIds: [],
      stepIds: [],
      artifactIds: [],
      createdAt: timestamp,
    });
    expect(
      flattenTeamRunSupervisionEventPages([
        { events: [event("event-3", 3), event("event-2", 2)], nextCursor: "2" },
        { events: [event("event-2", 2), event("event-1", 1)], nextCursor: null },
      ]).map((entry) => entry.id),
    ).toEqual(["event-3", "event-2", "event-1"]);
  });

  it("projects only unresolved human requests into compact run attention state", () => {
    const state: TeamRunSupervisionStateDto = {
      runId: "run-1",
      revision: 4,
      status: "awaiting_human",
      supervisorRoleId: "supervisor",
      supervisorAgentId: "11111111-1111-4111-8111-111111111111",
      completedWorkItems: 1,
      totalWorkItems: 2,
      humanRequest: {
        id: "human-1",
        revision: 1,
        kind: "approval",
        title: "Review required",
        detail: "Choose an action",
        actions: [{ id: "continue", label: "Continue", requiresNote: false }],
        roleIds: [],
        agentIds: [],
        stepIds: [],
        artifactIds: [],
        createdAt: timestamp,
      },
      updatedAt: timestamp,
    };
    expect(toTeamRunSupervisionSummary(state)).toMatchObject({
      pendingHumanRequest: { id: "human-1", title: "Review required" },
    });

    state.humanRequest = {
      ...state.humanRequest!,
      resolution: { actionId: "continue", note: null, resolvedAt: timestamp },
    };
    expect(toTeamRunSupervisionSummary(state)).not.toHaveProperty("pendingHumanRequest");
  });

  it("presents pending review prominently and unknown phases neutrally", () => {
    const base = {
      status: "awaiting_human",
      supervisorRoleId: "supervisor",
      supervisorAgentId: "11111111-1111-4111-8111-111111111111",
      completedWorkItems: 1,
      totalWorkItems: 2,
      pendingHumanRequest: {
        id: "human-1",
        kind: "approval",
        title: "Review required",
        revision: 1,
      },
      updatedAt: timestamp,
    };
    expect(teamRunSupervisionPresentation(base)).toMatchObject({
      labelKey: "teams.runs.supervision.needsReview",
      variant: "warning",
    });
    expect(
      teamRunSupervisionPresentation({
        ...base,
        status: "future_phase",
        pendingHumanRequest: undefined,
      }),
    ).toEqual({
      labelKey: null,
      fallbackLabel: "future_phase",
      variant: "muted",
    });
  });

  it("does not let a stale detail response restore a cleared run-summary request", () => {
    const retained = {
      status: "completed",
      supervisorRoleId: "supervisor",
      supervisorAgentId: "11111111-1111-4111-8111-111111111111",
      completedWorkItems: 2,
      totalWorkItems: 2,
      updatedAt: "2026-09-01T12:05:00.000Z",
    };
    const fetched: TeamRunSupervisionStateDto = {
      runId: "run-1",
      revision: 4,
      status: "awaiting_human",
      supervisorRoleId: "supervisor",
      supervisorAgentId: "11111111-1111-4111-8111-111111111111",
      completedWorkItems: 1,
      totalWorkItems: 2,
      humanRequest: {
        id: "human-1",
        revision: 1,
        kind: "approval",
        title: "Old request",
        detail: "Already resolved",
        actions: [{ id: "continue", label: "Continue", requiresNote: false }],
        roleIds: [],
        agentIds: [],
        stepIds: [],
        artifactIds: [],
        createdAt: timestamp,
      },
      updatedAt: timestamp,
    };

    expect(newestTeamRunSupervisionSummary(retained, fetched)).toEqual(retained);
  });
});
