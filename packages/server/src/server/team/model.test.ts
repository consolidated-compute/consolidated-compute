import { isAbsolute } from "node:path";

import { describe, expect, test } from "vitest";

import {
  canTransitionTeamRun,
  canTransitionTeamRunStep,
  generateTeamId,
  generateTeamRoleId,
  generateTeamRunId,
  generateTeamWorkflowStepId,
  isActiveTeamRunStatus,
  isTerminalTeamRunStatus,
  PersistedTeamDefinitionSchema,
  PersistedTeamRunRecordSchema,
  PersistedTeamRunStateSchema,
  PersistedTeamRunStepStateSchema,
  TEAM_INSTRUCTIONS_MAX_CHARS,
  type PersistedTeamDefinition,
  type PersistedTeamRunRecord,
} from "./model.js";

const timestamp = "2026-08-25T12:00:00.000Z";
const agentId = "9f44cd43-89a5-4371-af49-679bfbf8d1d7";

function createTeam(): PersistedTeamDefinition {
  return {
    id: "team_0123456789abcdef",
    revision: 1,
    name: "Delivery team",
    instructions: "Make changes carefully and leave the Workspace reviewable.",
    roles: [
      {
        id: "role_planner",
        name: "Planner",
        instructions: "Inspect the objective and produce a bounded plan.",
        launch: { provider: "codex", model: "gpt-5.6" },
      },
      {
        id: "role_builder",
        name: "Implementer",
        instructions: "Implement the accepted plan and verify the change.",
        launch: { provider: "codex", model: null },
      },
    ],
    workflow: [
      { id: "step_plan", roleId: "role_planner", instructions: null },
      {
        id: "step_build",
        roleId: "role_builder",
        instructions: "Keep the diff focused.",
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createRun(team = createTeam()): PersistedTeamRunRecord {
  return {
    id: "trun_0123456789abcdef",
    teamId: team.id,
    teamRevision: team.revision,
    idempotencyKey: "start-1",
    teamSnapshot: team,
    objective: "Add the requested feature.",
    workspace: {
      workspaceId: "wks_0123456789abcdef",
      projectId: "prj_0123456789abcdef",
      cwd: "/repo/worktree",
      displayName: "feature/teams",
    },
    steps: [
      {
        snapshot: {
          stepId: "step_plan",
          roleId: "role_planner",
          roleName: "Planner",
          roleInstructions: "Inspect the objective and produce a bounded plan.",
          stepInstructions: null,
          resolvedLaunch: { provider: "codex", model: "gpt-5.6" },
        },
        state: {
          status: "succeeded",
          agentId,
          startedAt: timestamp,
          endedAt: timestamp,
        },
      },
      {
        snapshot: {
          stepId: "step_build",
          roleId: "role_builder",
          roleName: "Implementer",
          roleInstructions: "Implement the accepted plan and verify the change.",
          stepInstructions: "Keep the diff focused.",
          resolvedLaunch: { provider: "codex", model: "gpt-5.6" },
        },
        state: {
          status: "running",
          agentId: "d65fc288-0a1b-45a9-b0c8-8346cd1721b3",
          startedAt: timestamp,
        },
      },
    ],
    state: { status: "running", startedAt: timestamp },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("Team definition contract", () => {
  test("accepts stable roles and an explicit sequential workflow", () => {
    expect(PersistedTeamDefinitionSchema.parse(createTeam())).toEqual(createTeam());
  });

  test("rejects duplicate role and step IDs", () => {
    const team = createTeam();
    team.roles[1] = { ...team.roles[1]!, id: team.roles[0]!.id };
    team.workflow[1] = { ...team.workflow[1]!, id: team.workflow[0]!.id };

    const result = PersistedTeamDefinitionSchema.safeParse(team);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Duplicate role ID"),
        expect.stringContaining("Duplicate workflow step ID"),
      ]),
    );
  });

  test("rejects unknown workflow role references and whitespace-only instructions", () => {
    const team = createTeam();
    team.workflow[0] = { ...team.workflow[0]!, roleId: "role_missing" };
    team.instructions = "   ";

    const result = PersistedTeamDefinitionSchema.safeParse(team);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "Must contain non-whitespace characters",
        "Unknown role ID: role_missing",
      ]),
    );
  });

  test("rejects empty workflows and oversized instructions", () => {
    const team = createTeam();
    team.workflow = [];
    team.instructions = "x".repeat(TEAM_INSTRUCTIONS_MAX_CHARS + 1);

    const result = PersistedTeamDefinitionSchema.safeParse(team);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([["workflow"], ["instructions"]]),
    );
  });
});

describe("Team Run contract", () => {
  test("accepts a frozen Team, Workspace, resolved steps, and active state", () => {
    expect(PersistedTeamRunRecordSchema.parse(createRun())).toEqual(createRun());
  });

  test("rejects a run whose Team revision or workflow snapshot drifted", () => {
    const run = createRun();
    run.teamRevision = 2;
    run.steps[1]!.snapshot.roleName = "Changed later";

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "teamRevision must match the frozen Team snapshot",
        "Run step snapshot must match its frozen Team role and workflow step",
      ]),
    );
  });

  test("preserves legacy path-shaped project IDs in the Workspace snapshot", () => {
    const run = createRun();
    run.workspace.projectId = "/Users/example/legacy project";

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(true);
  });

  test("requires an explicit model preference in the resolved launch", () => {
    const run = createRun();
    run.steps[0]!.snapshot.resolvedLaunch.model = null;

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Run step snapshot must match its frozen Team role and workflow step",
    );
  });

  test("rejects more than one active sequential step", () => {
    const run = createRun();
    run.steps[0]!.state = {
      status: "waiting_for_permission",
      agentId,
      startedAt: timestamp,
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "A sequential Team Run cannot have more than one active step",
    );
  });

  test("rejects a later active step while an earlier step is pending", () => {
    const run = createRun();
    run.steps[0]!.state = { status: "pending" };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Only the next workflow step may be active or terminal",
    );
  });

  test("requires run and current-step permission states to agree", () => {
    const run = createRun();
    run.state = { status: "waiting_for_permission", startedAt: timestamp };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Run status waiting_for_permission requires a matching current step",
    );
  });

  test("rejects a successful run with unfinished steps", () => {
    const run = createRun();
    run.state = { status: "succeeded", startedAt: timestamp, endedAt: timestamp };

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(false);
  });

  test("rejects a failed run after every step succeeded", () => {
    const run = createRun();
    run.steps[1]!.state = {
      status: "succeeded",
      agentId: "d65fc288-0a1b-45a9-b0c8-8346cd1721b3",
      startedAt: timestamp,
      endedAt: timestamp,
    };
    run.state = { status: "failed", startedAt: timestamp, endedAt: timestamp, error: "failed" };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "A failed run requires a failed step or a preflight failure",
    );
  });

  test("accepts a failed run at a step boundary", () => {
    const run = createRun();
    run.steps[1]!.state = { status: "pending" };
    run.state = { status: "failed", startedAt: timestamp, endedAt: timestamp, error: "missing" };

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(true);
  });

  test("rejects terminal timestamps before their start", () => {
    const run = createRun();
    run.steps[0]!.state = {
      status: "succeeded",
      agentId,
      startedAt: "2026-08-25T12:00:01.000Z",
      endedAt: timestamp,
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "endedAt cannot precede startedAt",
    );
  });

  test("does not admit copied outputs or transcripts", () => {
    const run = { ...createRun(), output: "copied", transcript: [] };

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(false);
  });
});

describe("Team Run state shapes", () => {
  test("represents every run lifecycle state explicitly", () => {
    const states = [
      { status: "queued" },
      { status: "running", startedAt: timestamp },
      { status: "waiting_for_permission", startedAt: timestamp },
      { status: "stopping", startedAt: timestamp, stopRequestedAt: timestamp },
      { status: "succeeded", startedAt: timestamp, endedAt: timestamp },
      { status: "failed", startedAt: timestamp, endedAt: timestamp, error: "failed" },
      { status: "canceled", startedAt: null, endedAt: timestamp },
      { status: "interrupted", startedAt: null, endedAt: timestamp, error: "restart" },
      { status: "stop_failed", startedAt: timestamp, stopRequestedAt: timestamp, error: "busy" },
    ];

    expect(states.every((state) => PersistedTeamRunStateSchema.safeParse(state).success)).toBe(
      true,
    );
  });

  test("represents every step lifecycle state explicitly", () => {
    const states = [
      { status: "pending" },
      { status: "creating", plannedAgentId: agentId, startedAt: timestamp },
      { status: "running", agentId, startedAt: timestamp },
      { status: "waiting_for_permission", agentId, startedAt: timestamp },
      { status: "stopping", agentId, startedAt: timestamp, stopRequestedAt: timestamp },
      { status: "succeeded", agentId, startedAt: timestamp, endedAt: timestamp },
      {
        status: "failed",
        plannedAgentId: agentId,
        agentId: null,
        startedAt: timestamp,
        endedAt: timestamp,
        error: "failed",
      },
      { status: "canceled", agentId, startedAt: timestamp, endedAt: timestamp },
      {
        status: "interrupted",
        plannedAgentId: agentId,
        agentId,
        startedAt: timestamp,
        endedAt: timestamp,
        error: "restart",
      },
      {
        status: "stop_failed",
        agentId,
        startedAt: timestamp,
        stopRequestedAt: timestamp,
        error: "busy",
      },
    ];

    expect(states.every((state) => PersistedTeamRunStepStateSchema.safeParse(state).success)).toBe(
      true,
    );
  });
});

describe("Team Run transitions", () => {
  test("keeps permission and stop-failed states nonterminal", () => {
    expect(canTransitionTeamRun("running", "waiting_for_permission")).toBe(true);
    expect(canTransitionTeamRun("waiting_for_permission", "running")).toBe(true);
    expect(canTransitionTeamRun("stopping", "stop_failed")).toBe(true);
    expect(isActiveTeamRunStatus("waiting_for_permission")).toBe(true);
    expect(isActiveTeamRunStatus("stop_failed")).toBe(true);
  });

  test("does not transition terminal runs or completed steps", () => {
    expect(canTransitionTeamRun("succeeded", "running")).toBe(false);
    expect(canTransitionTeamRunStep("succeeded", "running")).toBe(false);
    expect(isTerminalTeamRunStatus("failed")).toBe(true);
  });
});

describe("opaque Team IDs", () => {
  test("generates daemon-local IDs that are not paths", () => {
    expect(generateTeamId()).toMatch(/^team_[0-9a-f]{16}$/);
    expect(generateTeamRunId()).toMatch(/^trun_[0-9a-f]{16}$/);
    expect(generateTeamRoleId()).toMatch(/^role_[0-9a-f]{16}$/);
    expect(generateTeamWorkflowStepId()).toMatch(/^step_[0-9a-f]{16}$/);
    expect(isAbsolute(generateTeamId())).toBe(false);
  });
});
