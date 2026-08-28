import { describe, expect, it } from "vitest";
import type { AggregatedAssignment } from "./data";
import type { AggregatedTeam } from "@/teams/data";
import { resolveActiveAssignmentKey, teamsForAssignment } from "./screen-state";

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
});
