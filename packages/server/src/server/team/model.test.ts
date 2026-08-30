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
  isTeamRunSupervisionDecisionBoundary,
  isTerminalTeamRunStatus,
  PersistedTeamDefinitionSchema,
  PersistedTeamRunRecordSchema,
  PersistedTeamRunSupervisionDecisionSchema,
  PersistedTeamRunSupervisionWorkItemSchema,
  PersistedTeamResolvedLaunchSchema,
  PersistedTeamRunStateSchema,
  PersistedTeamRunStepStateSchema,
  TEAM_INSTRUCTIONS_MAX_CHARS,
  type PersistedTeamDefinition,
  type PersistedTeamRunRecord,
} from "./model.js";

const timestamp = "2026-08-25T12:00:00.000Z";
const agentId = "9f44cd43-89a5-4371-af49-679bfbf8d1d7";
const secondAgentId = "d65fc288-0a1b-45a9-b0c8-8346cd1721b3";
const thirdAgentId = "d5c82f35-5235-48fd-b3ba-425b377d20ab";

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
      {
        id: "role_supervisor",
        name: "Supervisor",
        instructions: "Coordinate bounded work and escalate explicit exceptions.",
        profileId: "profile_supervisor",
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

function createSupervisedAssignmentRun(): PersistedTeamRunRecord {
  const source = createAssignmentRun();
  const supervisorRole = source.teamSnapshot.roles.find((role) => role.id === "role_supervisor")!;
  const workerTemplates = source.steps.map((step) => {
    const {
      inputArtifactIds: _inputArtifactIds,
      outputArtifact: _outputArtifact,
      supervision: _supervision,
      ...snapshot
    } = step.snapshot;
    return snapshot;
  });
  return PersistedTeamRunRecordSchema.parse({
    ...source,
    steps: [],
    state: { status: "queued" },
    supervision: {
      revision: 1,
      phase: "queued",
      supervisor: {
        roleId: supervisorRole.id,
        roleName: supervisorRole.name,
        roleInstructions: supervisorRole.instructions,
        resolvedLaunch: {
          profileId: supervisorRole.profileId,
          provider: "codex",
          model: "gpt-5.6",
          modeId: "workspace-write",
          thinkingOptionId: "high",
          featureValues: {},
        },
        agentId: "6cc64262-085a-47ab-8ca7-77ccad4bd505",
      },
      workerTemplates,
      limits: {
        maxWorkItems: 24,
        maxActiveWorkers: 1,
        maxAttemptsPerWorkItem: 4,
        maxSupervisorActions: 128,
        maxDelegationDepth: 1,
      },
      workItems: [],
      decisions: [],
      humanRequest: null,
      updatedAt: timestamp,
    },
  });
}

function createSupervisedRunWithDecision(): PersistedTeamRunRecord {
  const run = createSupervisedAssignmentRun();
  const decision = {
    id: "decision_plan_1",
    sequence: 1,
    actionId: "action_plan_1",
    kind: "plan" as const,
    summary: "Accept the bounded workflow templates.",
    workItemId: null,
    attemptId: null,
    createdAt: timestamp,
  };
  return PersistedTeamRunRecordSchema.parse({
    ...run,
    steps: [
      {
        snapshot: {
          stepId: "supervisor_turn_1",
          roleId: run.supervision!.supervisor.roleId,
          roleName: run.supervision!.supervisor.roleName,
          roleInstructions: run.supervision!.supervisor.roleInstructions,
          stepInstructions: null,
          resolvedLaunch: run.supervision!.supervisor.resolvedLaunch,
          supervision: { kind: "supervisor", turn: 1, decisionId: decision.id },
        },
        state: {
          status: "succeeded",
          plannedAgentId: run.supervision!.supervisor.agentId,
          agentId: run.supervision!.supervisor.agentId,
          startedAt: timestamp,
          endedAt: timestamp,
        },
      },
    ],
    state: { status: "running", startedAt: timestamp },
    supervision: {
      ...run.supervision!,
      revision: 2,
      phase: "planning",
      decisions: [decision],
    },
  });
}

function createSupervisorTurn(
  run: PersistedTeamRunRecord,
  turn: number,
  decisionId: string,
): PersistedTeamRunRecord["steps"][number] {
  const firstTurn = run.steps[0]!;
  return {
    ...firstTurn,
    snapshot: {
      ...firstTurn.snapshot,
      stepId: `supervisor_turn_${turn}`,
      supervision: {
        kind: "supervisor",
        turn,
        decisionId,
      },
    },
  };
}

function createSupervisedRunWithWorkerAttempts(): PersistedTeamRunRecord {
  const run = createSupervisedRunWithDecision();
  const [plannerTemplate, builderTemplate] = run.supervision!.workerTemplates;
  const firstArtifactId = "aart_1111111111111111";
  const secondArtifactId = "aart_2222222222222222";
  const firstWorkItemId = "work_plan";
  const secondWorkItemId = "work_build";
  const firstAttemptId = "attempt_plan_1";
  const secondAttemptId = "attempt_build_1";
  const dispatchPlan = {
    id: "decision_dispatch_plan",
    sequence: 2,
    actionId: "action_dispatch_plan",
    kind: "dispatch" as const,
    summary: "Dispatch the planning work item.",
    workItemId: firstWorkItemId,
    attemptId: firstAttemptId,
    createdAt: timestamp,
  };
  const dispatchBuild = {
    id: "decision_dispatch_build",
    sequence: 3,
    actionId: "action_dispatch_build",
    kind: "dispatch" as const,
    summary: "Dispatch the build work item.",
    workItemId: secondWorkItemId,
    attemptId: secondAttemptId,
    createdAt: timestamp,
  };
  return PersistedTeamRunRecordSchema.parse({
    ...run,
    steps: [
      ...run.steps,
      createSupervisorTurn(run, 2, dispatchPlan.id),
      {
        snapshot: {
          ...plannerTemplate!,
          stepId: "supervised_step_plan_1",
          inputArtifactIds: [],
          outputArtifact: {
            id: firstArtifactId,
            kind: "team_step_output",
            title: "Planner output",
            mediaType: "text/markdown",
          },
          supervision: {
            kind: "worker",
            workItemId: firstWorkItemId,
            attemptId: firstAttemptId,
            attemptNumber: 1,
            templateStepId: plannerTemplate!.stepId,
            revisionParentAttemptId: null,
          },
        },
        state: {
          status: "succeeded",
          plannedAgentId: secondAgentId,
          agentId: secondAgentId,
          startedAt: timestamp,
          endedAt: timestamp,
        },
      },
      createSupervisorTurn(run, 3, dispatchBuild.id),
      {
        snapshot: {
          ...builderTemplate!,
          stepId: "supervised_step_build_1",
          inputArtifactIds: [firstArtifactId],
          outputArtifact: {
            id: secondArtifactId,
            kind: "team_step_output",
            title: "Implementer output",
            mediaType: "text/markdown",
          },
          supervision: {
            kind: "worker",
            workItemId: secondWorkItemId,
            attemptId: secondAttemptId,
            attemptNumber: 1,
            templateStepId: builderTemplate!.stepId,
            revisionParentAttemptId: null,
          },
        },
        state: {
          status: "succeeded",
          plannedAgentId: thirdAgentId,
          agentId: thirdAgentId,
          startedAt: timestamp,
          endedAt: timestamp,
        },
      },
    ],
    supervision: {
      ...run.supervision!,
      revision: 4,
      phase: "working",
      workItems: [
        {
          id: firstWorkItemId,
          templateStepId: plannerTemplate!.stepId,
          inputArtifactIds: [],
          attemptIds: [firstAttemptId],
          acceptedAttemptId: firstAttemptId,
          status: "succeeded",
        },
        {
          id: secondWorkItemId,
          templateStepId: builderTemplate!.stepId,
          inputArtifactIds: [firstArtifactId],
          attemptIds: [secondAttemptId],
          acceptedAttemptId: secondAttemptId,
          status: "succeeded",
        },
      ],
      decisions: [...run.supervision!.decisions, dispatchPlan, dispatchBuild],
    },
  });
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

  test("accepts legacy launches without posture and validates new posture snapshots strictly", () => {
    const launch = createRun().steps[0]!.snapshot.resolvedLaunch;
    expect(PersistedTeamResolvedLaunchSchema.parse(launch)).not.toHaveProperty("securityPosture");

    const securityPosture = {
      source: { provider: launch.provider },
      filesystemWrite: { status: "enforced", summary: "Writes are denied." },
      networkAccess: { status: "unavailable", summary: "No network claim." },
      toolShell: { status: "policy_only", summary: "Provider approvals apply." },
    } as const;
    expect(PersistedTeamResolvedLaunchSchema.parse({ ...launch, securityPosture })).toMatchObject({
      securityPosture,
    });

    expect(
      PersistedTeamResolvedLaunchSchema.safeParse({
        ...launch,
        securityPosture: {
          ...securityPosture,
          source: { provider: "claude" },
        },
      }).success,
    ).toBe(false);
    expect(
      PersistedTeamResolvedLaunchSchema.safeParse({
        ...launch,
        securityPosture: {
          ...securityPosture,
          networkAccess: { status: "unknown", summary: "Unknown." },
        },
      }).success,
    ).toBe(false);
    expect(
      PersistedTeamResolvedLaunchSchema.safeParse({
        ...launch,
        securityPosture: {
          ...securityPosture,
          networkAccess: { status: "unavailable", summary: "x".repeat(241) },
        },
      }).success,
    ).toBe(false);
  });

  test("accepts a frozen Assignment and exact sequential Artifact plan", () => {
    const run = createAssignmentRun();

    expect(PersistedTeamRunRecordSchema.parse(run)).toEqual(run);
  });

  test("accepts a bounded supervised Assignment admission snapshot", () => {
    const run = createSupervisedAssignmentRun();

    expect(PersistedTeamRunRecordSchema.parse(run)).toEqual(run);
    expect(run.steps).toEqual([]);
    expect(run.supervision).toMatchObject({
      revision: 1,
      phase: "queued",
      supervisor: { roleId: "role_supervisor" },
      limits: { maxActiveWorkers: 1, maxDelegationDepth: 1 },
      workItems: [],
      decisions: [],
    });
  });

  test("requires supervised steps to retain the complete frozen launch", () => {
    const run = createSupervisedRunWithDecision();
    run.steps[0]!.snapshot.resolvedLaunch = {
      ...run.steps[0]!.snapshot.resolvedLaunch,
      provider: "claude",
      model: null,
      providerOptions: { permission: { edit: "allow" } },
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Supervisor step must match the frozen supervisor role",
    );
  });

  test("binds every decision attempt to its named supervised work item", () => {
    const run = createSupervisedRunWithWorkerAttempts();
    run.supervision!.decisions[2] = {
      ...run.supervision!.decisions[2]!,
      workItemId: "work_plan",
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Supervisor decision attempt must belong to its named work item",
    );
  });

  test("reserves the frozen supervisor agent ID from worker attempts", () => {
    const run = createSupervisedRunWithWorkerAttempts();
    const supervisorAgentId = run.supervision!.supervisor.agentId;
    const workerStep = run.steps.find((step) => step.snapshot.supervision?.kind === "worker")!;
    workerStep.state = {
      status: "succeeded",
      plannedAgentId: supervisorAgentId,
      agentId: supervisorAgentId,
      startedAt: timestamp,
      endedAt: timestamp,
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Each supervised worker attempt must own a distinct agent ID",
    );
  });

  test("requires human requests to reference run-local evidence", () => {
    const run = createSupervisedRunWithWorkerAttempts();
    run.supervision = {
      ...run.supervision!,
      phase: "awaiting_human",
      humanRequest: {
        id: "human_invalid_evidence",
        revision: 1,
        kind: "approval",
        title: "Review the evidence",
        detail: "Every reference must resolve inside this frozen Team Run.",
        actions: [{ id: "continue", label: "Continue", requiresNote: false }],
        roleIds: ["role_missing"],
        agentIds: ["3ceaf5a8-ee7a-48bb-a01f-b591fe5d7bc5"],
        stepIds: ["step_missing"],
        artifactIds: ["aart_ffffffffffffffff"],
        createdAt: timestamp,
      },
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        ["supervision", "humanRequest", "roleIds", 0],
        ["supervision", "humanRequest", "agentIds", 0],
        ["supervision", "humanRequest", "stepIds", 0],
        ["supervision", "humanRequest", "artifactIds", 0],
      ]),
    );
  });

  test("rejects unmaterialized attempt outputs as human-request evidence", () => {
    const run = createSupervisedRunWithWorkerAttempts();
    const workerStep = run.steps.findLast((step) => step.snapshot.supervision?.kind === "worker")!;
    const metadata = workerStep.snapshot.supervision!;
    if (metadata.kind !== "worker") throw new Error("Expected a worker attempt");
    workerStep.state = {
      status: "failed",
      plannedAgentId: workerStep.state.plannedAgentId!,
      agentId: workerStep.state.plannedAgentId!,
      startedAt: timestamp,
      endedAt: timestamp,
      error: "Worker failed before materializing output.",
    };
    const workItem = run.supervision!.workItems.find((item) => item.id === metadata.workItemId)!;
    workItem.status = "failed";
    workItem.acceptedAttemptId = null;
    const outputArtifactId = workerStep.snapshot.outputArtifact!.id;
    run.supervision = {
      ...run.supervision!,
      phase: "awaiting_human",
      humanRequest: {
        id: "human_unmaterialized_evidence",
        revision: 1,
        kind: "approval",
        title: "Review the failed attempt",
        detail: "Only materialized Artifacts may be cited as evidence.",
        actions: [{ id: "continue", label: "Continue", requiresNote: false }],
        roleIds: [],
        agentIds: [],
        stepIds: [],
        artifactIds: [outputArtifactId],
        createdAt: timestamp,
      },
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
      "supervision",
      "humanRequest",
      "artifactIds",
      0,
    ]);
  });

  test.each([
    [
      "waiting_for_permission",
      {
        status: "waiting_for_permission",
        plannedAgentId: thirdAgentId,
        agentId: thirdAgentId,
        startedAt: timestamp,
      },
    ],
    [
      "stopping",
      {
        status: "stopping",
        plannedAgentId: thirdAgentId,
        agentId: thirdAgentId,
        startedAt: timestamp,
        stopRequestedAt: timestamp,
      },
    ],
    [
      "stop_failed",
      {
        status: "stop_failed",
        plannedAgentId: thirdAgentId,
        agentId: thirdAgentId,
        startedAt: timestamp,
        stopRequestedAt: timestamp,
        error: "Cancellation was refused.",
      },
    ],
  ] as const)("requires outer run state to match supervised step state %s", (status, state) => {
    const run = createSupervisedRunWithWorkerAttempts();
    const workerStep = run.steps.findLast((step) => step.snapshot.supervision?.kind === "worker")!;
    const metadata = workerStep.snapshot.supervision!;
    if (metadata.kind !== "worker") throw new Error("Expected a worker attempt");
    workerStep.state = state;
    const workItem = run.supervision!.workItems.find((item) => item.id === metadata.workItemId)!;
    workItem.status = "active";
    workItem.acceptedAttemptId = null;

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      `Supervised step status ${status} requires run status ${status}`,
    );
  });

  test("binds every durable decision to exactly one succeeded supervisor turn", () => {
    const supervised = createSupervisedRunWithDecision();
    const missingTurn = PersistedTeamRunRecordSchema.safeParse({
      ...supervised,
      steps: [],
    });
    const duplicateTurn = PersistedTeamRunRecordSchema.safeParse({
      ...supervised,
      steps: [
        ...supervised.steps,
        createSupervisorTurn(supervised, 2, supervised.supervision!.decisions[0]!.id),
      ],
    });

    expect(missingTurn.success).toBe(false);
    expect(duplicateTurn.success).toBe(false);
    if (!missingTurn.success) {
      expect(missingTurn.error.issues.map((issue) => issue.message)).toContain(
        "A durable supervisor decision must belong to exactly one succeeded turn",
      );
    }
    if (!duplicateTurn.success) {
      expect(duplicateTurn.error.issues.map((issue) => issue.message)).toContain(
        "A durable supervisor decision must belong to exactly one succeeded turn",
      );
    }
  });

  test.each(["dispatch", "request_revision"] as const)(
    "requires exact work and attempt targets for %s decisions",
    (kind) => {
      const result = PersistedTeamRunSupervisionDecisionSchema.safeParse({
        id: `decision_${kind}`,
        sequence: 1,
        actionId: `action_${kind}`,
        kind,
        summary: "Act on one exact supervised attempt.",
        workItemId: null,
        attemptId: null,
        createdAt: timestamp,
      });

      expect(result.success).toBe(false);
    },
  );

  test("rejects duplicate Artifact inputs in supervised work items", () => {
    const artifactId = "aart_0123456789abcdef";
    const result = PersistedTeamRunSupervisionWorkItemSchema.safeParse({
      id: "work_duplicate_inputs",
      templateStepId: "step_plan",
      inputArtifactIds: [artifactId, artifactId],
      attemptIds: [],
      acceptedAttemptId: null,
      status: "planned",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      `Duplicate supervised input Artifact ID: ${artifactId}`,
    );
  });

  test("rejects duplicate dispatch decisions for one worker attempt", () => {
    const run = createSupervisedRunWithWorkerAttempts();
    const firstDispatch = run.supervision!.decisions.find(
      (decision) => decision.kind === "dispatch",
    )!;
    const duplicateDispatch = {
      ...firstDispatch,
      id: "decision_dispatch_duplicate",
      sequence: run.supervision!.decisions.length + 1,
      actionId: "action_dispatch_duplicate",
    };
    run.steps.push(createSupervisorTurn(run, 4, duplicateDispatch.id));
    run.supervision!.decisions.push(duplicateDispatch);
    run.supervision!.revision += 1;

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      `Supervised attempt may be dispatched only once: ${firstDispatch.attemptId}`,
    );
  });

  test("requires active worker attempts to activate their work item", () => {
    const run = createSupervisedRunWithWorkerAttempts();
    const workerStep = run.steps.findLast((step) => step.snapshot.supervision?.kind === "worker")!;
    const metadata = workerStep.snapshot.supervision!;
    if (metadata.kind !== "worker") throw new Error("Expected a worker attempt");
    workerStep.state = {
      status: "creating",
      plannedAgentId: workerStep.state.plannedAgentId!,
      startedAt: timestamp,
    };
    const workItem = run.supervision!.workItems.find((item) => item.id === metadata.workItemId)!;
    workItem.status = "planned";
    workItem.acceptedAttemptId = null;

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "An active worker attempt requires an active supervised work item",
    );
  });

  test("requires complete decisions to terminalize supervision atomically", () => {
    const run = createSupervisedRunWithDecision();
    run.supervision!.decisions[0] = {
      ...run.supervision!.decisions[0]!,
      kind: "complete",
      workItemId: null,
      attemptId: null,
    };

    const result = PersistedTeamRunRecordSchema.safeParse(run);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "A complete supervisor decision must atomically complete the Team Run",
    );
  });

  test("admits supervisor decisions only at idle execution boundaries", () => {
    const queued = createSupervisedAssignmentRun();
    const planning = createSupervisedRunWithDecision();
    const activeWorker = createSupervisedRunWithWorkerAttempts();
    const workerStep = activeWorker.steps.find(
      (step) => step.snapshot.supervision?.kind === "worker",
    )!;
    workerStep.state = {
      status: "running",
      plannedAgentId: workerStep.state.plannedAgentId!,
      agentId: workerStep.state.plannedAgentId!,
      startedAt: timestamp,
    };
    const awaitingHuman = createSupervisedRunWithDecision();
    awaitingHuman.supervision!.phase = "awaiting_human";
    const stopping = createSupervisedRunWithDecision();
    stopping.state = {
      status: "stopping",
      startedAt: timestamp,
      stopRequestedAt: timestamp,
    };

    expect(isTeamRunSupervisionDecisionBoundary(queued)).toBe(true);
    expect(isTeamRunSupervisionDecisionBoundary(planning)).toBe(true);
    expect(isTeamRunSupervisionDecisionBoundary(activeWorker)).toBe(false);
    expect(isTeamRunSupervisionDecisionBoundary(awaitingHuman)).toBe(false);
    expect(isTeamRunSupervisionDecisionBoundary(stopping)).toBe(false);
  });

  test("rejects supervised runs without an Assignment or with a worker as supervisor", () => {
    const supervised = createSupervisedAssignmentRun();
    const withoutAssignment = {
      ...supervised,
      assignmentId: undefined,
      assignmentRevision: undefined,
      assignmentSnapshot: undefined,
    };
    const workerSupervisor = {
      ...supervised,
      supervision: {
        ...supervised.supervision!,
        supervisor: {
          ...supervised.supervision!.supervisor,
          roleId: "role_planner",
          roleName: "Planner",
          roleInstructions: "Inspect the objective and produce a bounded plan.",
          resolvedLaunch: supervised.supervision!.workerTemplates[0]!.resolvedLaunch,
        },
      },
    };

    const missingResult = PersistedTeamRunRecordSchema.safeParse(withoutAssignment);
    const workerResult = PersistedTeamRunRecordSchema.safeParse(workerSupervisor);
    expect(missingResult.success).toBe(false);
    expect(workerResult.success).toBe(false);
    if (!missingResult.success) {
      expect(missingResult.error.issues.map((issue) => issue.message)).toContain(
        "Supervised Team Runs must be backed by an Assignment",
      );
    }
    if (!workerResult.success) {
      expect(workerResult.error.issues.map((issue) => issue.message)).toContain(
        "The supervisor role cannot also be a worker workflow role",
      );
    }
  });

  test("enforces frozen supervision limits and unique durable IDs", () => {
    const supervised = createSupervisedAssignmentRun();
    const workItem = {
      id: "work_build",
      templateStepId: "step_plan",
      inputArtifactIds: [] as string[],
      attemptIds: ["attempt_1", "attempt_1"],
      acceptedAttemptId: null,
      status: "planned" as const,
    };
    const result = PersistedTeamRunRecordSchema.safeParse({
      ...supervised,
      state: { status: "running", startedAt: timestamp },
      supervision: {
        ...supervised.supervision!,
        phase: "planning",
        limits: { ...supervised.supervision!.limits, maxWorkItems: 1 },
        workItems: [workItem, { ...workItem }],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "Supervised work exceeds the frozen work-item limit",
        "Duplicate supervised work item ID: work_build",
        "Duplicate supervised attempt ID: attempt_1",
      ]),
    );
  });

  test("rejects terminal success while a human request remains unresolved", () => {
    const supervised = createSupervisedAssignmentRun();
    const result = PersistedTeamRunRecordSchema.safeParse({
      ...supervised,
      state: { status: "succeeded", startedAt: timestamp, endedAt: timestamp },
      supervision: {
        ...supervised.supervision!,
        phase: "completed",
        humanRequest: {
          id: "human_review",
          revision: 1,
          kind: "approval",
          title: "Approve completion",
          detail: "Confirm the bounded result.",
          actions: [
            { id: "approve", label: "Approve", requiresNote: false },
            { id: "reject", label: "Reject", requiresNote: true },
          ],
          roleIds: ["role_supervisor"],
          agentIds: [supervised.supervision!.supervisor.agentId],
          stepIds: [],
          artifactIds: [],
          createdAt: timestamp,
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "An unresolved human request must keep supervision awaiting the human",
        "A succeeded supervised run cannot retain an unresolved human request",
      ]),
    );
  });

  test.each([
    ["completed", "succeeded"],
    ["failed", "failed"],
    ["canceled", "canceled"],
    ["interrupted", "interrupted"],
  ] as const)("requires supervision phase %s to terminalize the run as %s", (phase, status) => {
    const supervised = createSupervisedAssignmentRun();
    const result = PersistedTeamRunRecordSchema.safeParse({
      ...supervised,
      state: { status: "running", startedAt: timestamp },
      supervision: {
        ...supervised.supervision!,
        phase,
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      `Supervision phase ${phase} requires run status ${status}`,
    );
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
