import { describe, expect, it } from "vitest";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import {
  canCancelTeamRun,
  flattenTeamRunPages,
  isTerminalTeamRunStatus,
  matchesTeamRunRoute,
  newestTeamRunSnapshot,
  teamRunHistoryPlaceholder,
  teamRunListQueryKey,
  teamRunQueryKey,
  upsertTeamRun,
  upsertTeamRunPages,
} from "./run-data";

function run(id: string, createdAt: string): TeamRunDto {
  return {
    id,
    teamId: "team-1",
    teamRevision: 1,
    idempotencyKey: id,
    teamSnapshot: {
      id: "team-1",
      revision: 1,
      name: "Delivery",
      instructions: "Ship",
      roles: [{ id: "role", name: "Builder", instructions: "Build", profileId: "builder" }],
      workflow: [{ id: "step", roleId: "role", instructions: null }],
      createdAt,
      updatedAt: createdAt,
    },
    objective: "Implement",
    workspace: {
      workspaceId: "workspace-1",
      projectId: "project-1",
      cwd: "/repo",
      displayName: "main",
    },
    steps: [
      {
        snapshot: {
          stepId: "step",
          roleId: "role",
          roleName: "Builder",
          roleInstructions: "Build",
          stepInstructions: null,
          resolvedLaunch: {
            profileId: "builder",
            provider: "codex",
            model: "gpt-5.6",
            modeId: null,
            thinkingOptionId: null,
            featureValues: {},
          },
        },
        state: { status: "pending" },
      },
    ],
    state: { status: "queued" },
    createdAt,
    updatedAt: createdAt,
  };
}

describe("Team Run data", () => {
  it("qualifies list and detail caches by host", () => {
    expect(teamRunListQueryKey("host-a", "team-1")).toEqual([
      "teamRuns",
      "host-a",
      "team",
      "team-1",
      "list",
    ]);
    expect(teamRunQueryKey("host-b", "run-1")).toEqual(["teamRuns", "host-b", "run", "run-1"]);
  });

  it("distinguishes terminal and cancelable lifecycle states", () => {
    expect(isTerminalTeamRunStatus("succeeded")).toBe(true);
    expect(isTerminalTeamRunStatus("stop_failed")).toBe(false);
    expect(canCancelTeamRun("running")).toBe(true);
    expect(canCancelTeamRun("stop_failed")).toBe(true);
    expect(canCancelTeamRun("stopping")).toBe(false);
    expect(canCancelTeamRun("interrupted")).toBe(false);
  });

  it("rejects a Run reached through another Team's route", () => {
    expect(matchesTeamRunRoute(run("run-1", "2026-08-26T00:00:00.000Z"), "team-1")).toBe(true);
    expect(matchesTeamRunRoute(run("run-1", "2026-08-26T00:00:00.000Z"), "team-2")).toBe(false);
  });

  it("replaces a run by ID and keeps newest-first order", () => {
    const older = run("older", "2026-08-25T00:00:00.000Z");
    const newer = run("newer", "2026-08-26T00:00:00.000Z");
    const updated = { ...older, state: { status: "running", startedAt: older.createdAt } } as const;
    expect(upsertTeamRun([older, newer], updated)).toEqual([newer, updated]);
  });

  it("upserts a changed Run once across paginated results", () => {
    const older = run("older", "2026-08-24T00:00:00.000Z");
    const target = run("target", "2026-08-25T00:00:00.000Z");
    const newer = run("newer", "2026-08-26T00:00:00.000Z");
    const updated = {
      ...target,
      state: { status: "running", startedAt: target.createdAt },
    } as const;
    expect(
      upsertTeamRunPages(
        [
          { runs: [newer], nextCursor: "next" },
          { runs: [target, older], nextCursor: null },
        ],
        updated,
      ),
    ).toEqual([
      { runs: [newer, updated], nextCursor: "next" },
      { runs: [older], nextCursor: null },
    ]);
  });

  it("deduplicates paginated Runs and keeps the newest available snapshot", () => {
    const older = run("older", "2026-08-24T00:00:00.000Z");
    const target = run("target", "2026-08-25T00:00:00.000Z");
    expect(
      flattenTeamRunPages([
        { runs: [target], nextCursor: "next" },
        { runs: [target, older], nextCursor: null },
      ]),
    ).toEqual([target, older]);

    const running = {
      ...target,
      state: { status: "running", startedAt: target.createdAt },
      updatedAt: "2026-08-26T00:00:00.000Z",
    } as const;
    expect(newestTeamRunSnapshot(target, running)).toBe(running);
    expect(newestTeamRunSnapshot(running, target)).toBe(running);
  });

  it("distinguishes unfetched offline history from a loaded empty list", () => {
    expect(
      teamRunHistoryPlaceholder({
        isLoading: false,
        isError: false,
        runCount: 0,
        hasLoadedData: false,
        canLoad: false,
      }),
    ).toBe("offline");
    expect(
      teamRunHistoryPlaceholder({
        isLoading: false,
        isError: false,
        runCount: 0,
        hasLoadedData: true,
        canLoad: false,
      }),
    ).toBe("empty");
    expect(
      teamRunHistoryPlaceholder({
        isLoading: true,
        isError: false,
        runCount: 0,
        hasLoadedData: false,
        canLoad: true,
      }),
    ).toBe("none");
  });
});
