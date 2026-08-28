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
const secondAgentId = "d65fc288-0a1b-45a9-b0c8-8346cd1721b3";

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
        profileId: "profile_planner",
      },
      {
        id: "role_builder",
        name: "Implementer",
        instructions: "Implement the accepted plan and verify the change.",
        profileId: "profile_builder",
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
          resolvedLaunch: {
            profileId: "profile_planner",
            provider: "codex",
            model: "gpt-5.6",
            modeId: "plan",
            thinkingOptionId: "high",
            featureValues: { web_search: true },
          },
        },
        state: {
          status: "succeeded",
          plannedAgentId: agentId,
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
          resolvedLaunch: {
            profileId: "profile_builder",
            provider: "codex",
            model: "gpt-5.6",
            modeId: null,
            thinkingOptionId: null,
            featureValues: {},
          },
        },
        state: {
          status: "running",
          plannedAgentId: secondAgentId,
          agentId: secondAgentId,
          startedAt: timestamp,
        },
      },
    ],
    state: { status: "running", startedAt: timestamp },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createAssignmentRun() {
  const run = createRun();
  const assignmentSnapshot = {
    id: "asgn_0123456789abcdef",
    revision: 3,
    title: "Ship Assignment-backed Team Runs",
    objective: "Add the requested feature.",
    workItem: null,
    state: { status: "open" as const },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  for (const [index, step] of run.steps.entries()) {
    step.snapshot.inputArtifactIds = index === 0 ? [] : ["aart_0123456789abcdef"];
    step.snapshot.outputArtifact = {
      id: index === 0 ? "aart_0123456789abcdef" : "aart_fedcba9876543210",
      kind: "team_step_output",
      title: `${step.snapshot.roleName} output`,
      mediaType: "text/markdown",
    };
  }
  return {
    ...run,
    assignmentId: assignmentSnapshot.id,
    assignmentRevision: assignmentSnapshot.revision,
    assignmentSnapshot,
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

  test("accepts a frozen Assignment and exact sequential Artifact plan", () => {
    const run = createAssignmentRun();

    expect(PersistedTeamRunRecordSchema.parse(run)).toEqual(run);
  });

  test("requires Assignment identity, revision, and snapshot together", () => {
    const run = createAssignmentRun();
    const { assignmentSnapshot: _, ...withoutSnapshot } = run;

    const result = PersistedTeamRunRecordSchema.safeParse(withoutSnapshot);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Assignment identity, revision, and snapshot must be present together",
    );
  });

  test("rejects drift from the frozen open Assignment", () => {
    const source = createAssignmentRun();
    const run = {
      ...source,
      objective: "Different objective",
      assignmentSnapshot: {
        ...source.assignmentSnapshot,
        state: { status: "completed" as const, completedAt: timestamp },
      },
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "objective must match the frozen Assignment snapshot",
        "Assignment-backed runs must freeze an open Assignment",
      ]),
    );
  });

  test("rejects missing or latest-style Artifact handoffs", () => {
    const run = createAssignmentRun();
    run.steps[1]!.snapshot.inputArtifactIds = [];

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Each downstream step must consume exactly the preceding output Artifact ID",
    );
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

  test("preserves legacy path-shaped Workspace IDs in the Workspace snapshot", () => {
    const run = createRun();
    run.workspace.workspaceId = "/Users/example/legacy workspace";

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(true);
  });

  test("requires each resolved step to retain its role's profile identity", () => {
    const run = createRun();
    run.steps[0]!.snapshot.resolvedLaunch.profileId = "profile_other";

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Run step snapshot must match its frozen Team role and workflow step",
    );
  });

  test("keeps resolved launch facts independent of later Agent Profile configuration", () => {
    const run = createRun();
    run.steps[1]!.snapshot.resolvedLaunch = {
      ...run.steps[1]!.snapshot.resolvedLaunch,
      provider: "claude",
      model: null,
      modeId: "accept-edits",
      thinkingOptionId: null,
      featureValues: { auto_accept: false },
      providerOptions: { permission: { edit: "allow", bash: "ask" } },
    };

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(true);
  });

  test("keeps legacy resolved launches without provider options readable", () => {
    const run = createRun();
    for (const step of run.steps) delete step.snapshot.resolvedLaunch.providerOptions;

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(true);
  });

  test("allows cancellation while a planned agent is still being created", () => {
    const run = createRun();
    run.steps[0]!.state = {
      status: "stopping",
      plannedAgentId: agentId,
      agentId: null,
      startedAt: timestamp,
      stopRequestedAt: timestamp,
    };
    run.steps[1]!.state = { status: "pending" };
    run.state = {
      status: "stopping",
      startedAt: timestamp,
      stopRequestedAt: timestamp,
    };

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(true);
  });

  test("rejects non-JSON feature values in frozen launch facts", () => {
    const run = createRun();
    run.steps[1]!.snapshot.resolvedLaunch.featureValues = {
      callback: () => undefined,
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
      "steps",
      1,
      "snapshot",
      "resolvedLaunch",
      "featureValues",
      "callback",
    ]);
  });

  test("rejects non-JSON provider options in frozen launch facts", () => {
    const run = createRun();
    const unvalidatedLaunch = run.steps[1]!.snapshot.resolvedLaunch as unknown as {
      providerOptions: Record<string, unknown>;
    };
    unvalidatedLaunch.providerOptions = {
      callback: () => undefined,
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
      "steps",
      1,
      "snapshot",
      "resolvedLaunch",
      "providerOptions",
      "callback",
    ]);
  });

  test("rejects more than one active sequential step", () => {
    const run = createRun();
    run.steps[0]!.state = {
      status: "waiting_for_permission",
      plannedAgentId: agentId,
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
      plannedAgentId: secondAgentId,
      agentId: secondAgentId,
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

  test.each(["canceled", "interrupted"] as const)("rejects an all-succeeded %s run", (status) => {
    const run = createRun();
    run.steps[1]!.state = {
      status: "succeeded",
      plannedAgentId: secondAgentId,
      agentId: secondAgentId,
      startedAt: timestamp,
      endedAt: timestamp,
    };
    if (status === "canceled") {
      run.state = { status, startedAt: timestamp, endedAt: timestamp };
    } else {
      run.state = { status, startedAt: timestamp, endedAt: timestamp, error: "restart" };
    }

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      `A ${status} run requires a matching step or a pending workflow boundary`,
    );
  });

  test("rejects a pre-start interrupted run with reached work", () => {
    const run = createRun();
    run.steps[1]!.state = { status: "pending" };
    run.state = {
      status: "interrupted",
      startedAt: null,
      endedAt: timestamp,
      error: "restart",
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "A pre-start interrupted run can contain only pending steps",
    );
  });

  test("accepts cancellation before any step starts", () => {
    const run = createRun();
    run.steps[0]!.state = { status: "pending" };
    run.steps[1]!.state = { status: "pending" };
    run.state = { status: "canceled", startedAt: null, endedAt: timestamp };

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(true);
  });

  test("accepts cancellation while the current agent is still being created", () => {
    const run = createRun();
    run.steps[0]!.state = {
      status: "canceled",
      plannedAgentId: agentId,
      agentId: null,
      startedAt: timestamp,
      endedAt: timestamp,
    };
    run.steps[1]!.state = { status: "pending" };
    run.state = { status: "canceled", startedAt: timestamp, endedAt: timestamp };

    expect(PersistedTeamRunRecordSchema.safeParse(run).success).toBe(true);
    expect(canTransitionTeamRunStep("creating", "canceled")).toBe(true);
  });

  test("rejects terminal timestamps before their start", () => {
    const run = createRun();
    run.steps[0]!.state = {
      status: "succeeded",
      plannedAgentId: agentId,
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

  test("rejects a pre-start terminal timestamp outside the record bounds", () => {
    const run = createRun();
    run.steps[1]!.state = { status: "pending" };
    run.state = {
      status: "canceled",
      startedAt: null,
      endedAt: "2026-08-25T11:59:59.000Z",
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "endedAt cannot precede createdAt",
    );
  });

  test("rejects active timestamps after the record update", () => {
    const run = createRun();
    run.steps[1]!.state = {
      status: "stopping",
      plannedAgentId: secondAgentId,
      agentId: secondAgentId,
      startedAt: timestamp,
      stopRequestedAt: "2026-08-25T12:00:01.000Z",
    };
    run.state = {
      status: "stopping",
      startedAt: timestamp,
      stopRequestedAt: "2026-08-25T12:00:01.000Z",
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "stopRequestedAt cannot follow updatedAt",
    );
  });

  test("rejects a step that starts before its run", () => {
    const run = createRun();
    run.state = { status: "running", startedAt: "2026-08-25T12:00:01.000Z" };
    run.updatedAt = "2026-08-25T12:00:02.000Z";

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Step startedAt cannot precede run startedAt",
    );
  });

  test("rejects a step that ends after its run", () => {
    const run = createRun();
    run.steps[0]!.state = {
      status: "succeeded",
      plannedAgentId: agentId,
      agentId,
      startedAt: timestamp,
      endedAt: "2026-08-25T12:00:02.000Z",
    };
    run.steps[1]!.state = { status: "pending" };
    run.state = {
      status: "failed",
      startedAt: timestamp,
      endedAt: "2026-08-25T12:00:01.000Z",
      error: "preflight failed",
    };
    run.updatedAt = "2026-08-25T12:00:03.000Z";

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Step endedAt cannot follow run endedAt",
    );
  });

  test("rejects a step stop request before the run stop request", () => {
    const run = createRun();
    run.steps[1]!.state = {
      status: "stopping",
      plannedAgentId: secondAgentId,
      agentId: secondAgentId,
      startedAt: timestamp,
      stopRequestedAt: "2026-08-25T12:00:01.000Z",
    };
    run.state = {
      status: "stopping",
      startedAt: timestamp,
      stopRequestedAt: "2026-08-25T12:00:02.000Z",
    };
    run.updatedAt = "2026-08-25T12:00:03.000Z";

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Step stopRequestedAt cannot precede run stopRequestedAt",
    );
  });

  test("rejects overlap between sequential steps", () => {
    const run = createRun();
    run.steps[0]!.state = {
      status: "succeeded",
      plannedAgentId: agentId,
      agentId,
      startedAt: timestamp,
      endedAt: "2026-08-25T12:00:02.000Z",
    };
    run.steps[1]!.state = {
      status: "running",
      plannedAgentId: secondAgentId,
      agentId: secondAgentId,
      startedAt: "2026-08-25T12:00:01.000Z",
    };
    run.updatedAt = "2026-08-25T12:00:03.000Z";

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Step startedAt cannot precede the preceding step endedAt",
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
      { status: "running", plannedAgentId: agentId, agentId, startedAt: timestamp },
      { status: "waiting_for_permission", plannedAgentId: agentId, agentId, startedAt: timestamp },
      {
        status: "stopping",
        plannedAgentId: agentId,
        agentId,
        startedAt: timestamp,
        stopRequestedAt: timestamp,
      },
      {
        status: "succeeded",
        plannedAgentId: agentId,
        agentId,
        startedAt: timestamp,
        endedAt: timestamp,
      },
      {
        status: "failed",
        plannedAgentId: agentId,
        agentId: null,
        startedAt: timestamp,
        endedAt: timestamp,
        error: "failed",
      },
      {
        status: "canceled",
        plannedAgentId: agentId,
        agentId,
        startedAt: timestamp,
        endedAt: timestamp,
      },
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
        plannedAgentId: agentId,
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

  test("rejects step states whose created agent differs from the planned identity", () => {
    const states = [
      {
        status: "running",
        plannedAgentId: agentId,
        agentId: secondAgentId,
        startedAt: timestamp,
      },
      {
        status: "waiting_for_permission",
        plannedAgentId: agentId,
        agentId: secondAgentId,
        startedAt: timestamp,
      },
      {
        status: "stopping",
        plannedAgentId: agentId,
        agentId: secondAgentId,
        startedAt: timestamp,
        stopRequestedAt: timestamp,
      },
      {
        status: "succeeded",
        plannedAgentId: agentId,
        agentId: secondAgentId,
        startedAt: timestamp,
        endedAt: timestamp,
      },
      {
        status: "failed",
        plannedAgentId: agentId,
        agentId: secondAgentId,
        startedAt: timestamp,
        endedAt: timestamp,
        error: "failed",
      },
      {
        status: "canceled",
        plannedAgentId: agentId,
        agentId: secondAgentId,
        startedAt: timestamp,
        endedAt: timestamp,
      },
      {
        status: "interrupted",
        plannedAgentId: agentId,
        agentId: secondAgentId,
        startedAt: timestamp,
        endedAt: timestamp,
        error: "restart",
      },
      {
        status: "stop_failed",
        plannedAgentId: agentId,
        agentId: secondAgentId,
        startedAt: timestamp,
        stopRequestedAt: timestamp,
        error: "busy",
      },
    ];

    for (const state of states) {
      expect(PersistedTeamRunStepStateSchema.safeParse(state).success).toBe(false);
    }
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
