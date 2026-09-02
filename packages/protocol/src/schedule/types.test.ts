import { describe, expect, test } from "vitest";

import { ScheduleCadenceSchema, ScheduleRunSchema, ScheduleTargetSchema } from "./types.js";

describe("ScheduleCadenceSchema", () => {
  test("accepts existing UTC cron cadence without a time zone", () => {
    expect(ScheduleCadenceSchema.parse({ type: "cron", expression: "0 9 * * *" })).toEqual({
      type: "cron",
      expression: "0 9 * * *",
    });
  });

  test("accepts timezone-aware cron cadence", () => {
    expect(
      ScheduleCadenceSchema.parse({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      }),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });
});

describe("Assignment Team Run schedule schemas", () => {
  test("accepts a host-local Assignment, Team, and Workspace target", () => {
    expect(
      ScheduleTargetSchema.parse({
        type: "assignment-team-run",
        teamId: "team-1",
        assignmentId: "assignment-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      type: "assignment-team-run",
      teamId: "team-1",
      assignmentId: "assignment-1",
      workspaceId: "workspace-1",
    });
  });

  test("accepts an optional admitted Team Run identity on an occurrence", () => {
    expect(
      ScheduleRunSchema.parse({
        id: "occurrence-1",
        scheduledFor: "2026-09-02T12:00:00.000Z",
        startedAt: "2026-09-02T12:00:00.000Z",
        endedAt: "2026-09-02T12:00:01.000Z",
        status: "succeeded",
        agentId: null,
        teamRunId: "team-run-1",
        output: null,
        error: null,
      }),
    ).toMatchObject({ teamRunId: "team-run-1" });
  });
});
