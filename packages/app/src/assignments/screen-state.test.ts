import { describe, expect, it } from "vitest";
import type { AggregatedAssignment, AssignmentHostState } from "./data";
import type { AggregatedTeam, TeamHostState } from "@/teams/data";
import {
  isAssignmentRunEnabled,
  resolveActiveAssignmentKey,
  teamsForAssignment,
} from "./screen-state";

describe("Assignment screen state", () => {
  it("keeps routed identity host-qualified", () => {
    expect(
      resolveActiveAssignmentKey({ kind: "detail", serverId: "host:a", assignmentId: "b" }, null),
    ).toBe('["host:a","b"]');
  });

  it("offers only Teams owned by the Assignment host", () => {
    const assignment = { serverId: "host-a" } as AggregatedAssignment;
    const teams = [
      { serverId: "host-b", id: "team-b" },
      { serverId: "host-a", id: "team-a" },
    ] as AggregatedTeam[];
    expect(teamsForAssignment(assignment, teams).map((team) => team.id)).toEqual(["team-a"]);
  });

  it("keeps Run disabled until the Assignment host's Teams are ready", () => {
    const assignment = {
      serverId: "host-a",
      state: { status: "open" },
    } as AggregatedAssignment;
    const assignmentHost = {
      serverId: "host-a",
      status: "ready",
      canAuthor: true,
    } as AssignmentHostState;
    const loadingHost = {
      serverId: "host-a",
      status: "loading",
      canAuthor: false,
    } as TeamHostState;
    const readyHost = { ...loadingHost, status: "ready", canAuthor: true } as TeamHostState;

    expect(isAssignmentRunEnabled(assignment, assignmentHost, [loadingHost])).toBe(false);
    expect(isAssignmentRunEnabled(assignment, assignmentHost, [readyHost])).toBe(true);
  });
});
