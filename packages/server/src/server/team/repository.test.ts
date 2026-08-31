import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  AssignmentHasActiveRunError,
  AssignmentNotFoundError,
  AssignmentRepository,
  AssignmentRevisionConflictError,
  AssignmentStateConflictError,
} from "../assignment/repository.js";
import {
  PersistedTeamRunRecordSchema,
  type PersistedTeamDefinition,
  type PersistedTeamRunRecord,
  type PersistedTeamRunSupervision,
} from "./model.js";
import {
  TEAM_RUN_PAGE_MAX_LIMIT,
  TeamRepository,
  TeamHasActiveRunError,
  TeamAssignmentHasActiveRunError,
  TeamRepositoryIdError,
  TeamRevisionConflictError,
  TeamRunIdempotencyConflictError,
  TeamRunSupervisionActionConflictError,
  TeamRunSupervisionRevisionConflictError,
  TeamRunPageError,
  TeamStorageCorruptError,
  TeamWorkspaceHasActiveRunError,
  type CreateTeamDefinitionInput,
  type CreateAssignmentTeamRunInput,
  type CreateTeamRunInput,
  type TeamRepositoryChange,
  type TeamRunSupervisionDecision,
  type TeamRunSupervisionUpdate,
} from "./repository.js";
import { toTeamRunDto } from "./wire.js";

const firstTimestamp = "2026-08-25T12:00:00.000Z";
const secondTimestamp = "2026-08-25T12:01:00.000Z";
const firstAgentId = "28c954c9-f75c-49d6-8477-900c99a6dc0b";
const secondAgentId = "6fcf0340-95e6-49eb-8e01-4c95da99884e";

function createDefinitionInput(): CreateTeamDefinitionInput {
  return {
    name: "Delivery team",
    instructions: "Ship the objective with a separate review step.",
    roles: [
      {
        id: "role_builder",
        name: "Builder",
        instructions: "Implement and verify the requested change.",
        profileId: "profile_builder",
      },
      {
        id: "role_reviewer",
        name: "Reviewer",
        instructions: "Review the implementation for correctness.",
        profileId: "profile_reviewer",
      },
      {
        id: "role_supervisor",
        name: "Supervisor",
        instructions: "Coordinate bounded work and escalate exceptions.",
        profileId: "profile_supervisor",
      },
    ],
    workflow: [
      { id: "step_build", roleId: "role_builder", instructions: null },
      {
        id: "step_review",
        roleId: "role_reviewer",
        instructions: "Report only actionable findings.",
      },
    ],
  };
}

function createRunInput(
  definition: PersistedTeamDefinition,
  idempotencyKey = "start-1",
  workspaceId = "wks_0123456789abcdef",
): CreateTeamRunInput {
  const roles = new Map(definition.roles.map((role) => [role.id, role]));
  return {
    teamId: definition.id,
    expectedRevision: definition.revision,
    idempotencyKey,
    objective: "Deliver the requested repository change.",
    workspace: {
      workspaceId,
      projectId: "prj_0123456789abcdef",
      cwd: `/repo/${workspaceId}`,
      displayName: "feature/teams",
    },
    steps: definition.workflow.map((workflowStep) => {
      const role = roles.get(workflowStep.roleId);
      if (!role) throw new Error(`Missing role ${workflowStep.roleId}`);
      return {
        snapshot: {
          stepId: workflowStep.id,
          roleId: role.id,
          roleName: role.name,
          roleInstructions: role.instructions,
          stepInstructions: workflowStep.instructions,
          resolvedLaunch: {
            profileId: role.profileId,
            provider: role.id === "role_builder" ? "codex" : "claude",
            model: role.id === "role_builder" ? "gpt-5.6" : null,
            modeId: role.id === "role_builder" ? "workspace-write" : null,
            thinkingOptionId: role.id === "role_builder" ? "high" : null,
            featureValues: role.id === "role_builder" ? { web_search: true } : {},
          },
        },
        state: { status: "pending" as const },
      };
    }),
  };
}

function createAssignmentRunInput(
  definition: PersistedTeamDefinition,
  assignment: { id: string; revision: number },
  idempotencyKey = "assignment-start-1",
  workspaceId = "wks_assignment_012345",
): CreateAssignmentTeamRunInput {
  const { objective: _, ...runInput } = createRunInput(definition, idempotencyKey, workspaceId);
  return {
    ...runInput,
    assignmentId: assignment.id,
    expectedAssignmentRevision: assignment.revision,
  };
}

function createSupervision(definition: PersistedTeamDefinition): PersistedTeamRunSupervision {
  const runInput = createRunInput(definition);
  const supervisor = definition.roles.find((role) => role.id === "role_supervisor")!;
  return {
    revision: 1,
    phase: "queued",
    supervisor: {
      roleId: supervisor.id,
      roleName: supervisor.name,
      roleInstructions: supervisor.instructions,
      resolvedLaunch: {
        profileId: supervisor.profileId,
        provider: "codex",
        model: "gpt-5.6",
        modeId: "workspace-write",
        thinkingOptionId: "high",
        featureValues: {},
      },
      agentId: "0c783b8c-1bd7-4d79-863e-63a311742eef",
    },
    workerTemplates: runInput.steps.map((step) => step.snapshot),
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
    updatedAt: firstTimestamp,
  };
}

function createSucceededSupervisorTurn(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  decisionId: string,
  turn: number,
  timestamp: string,
): PersistedTeamRunRecord["steps"][number] {
  return {
    snapshot: {
      stepId: `supervisor_turn_${turn}`,
      roleId: run.supervision.supervisor.roleId,
      roleName: run.supervision.supervisor.roleName,
      roleInstructions: run.supervision.supervisor.roleInstructions,
      stepInstructions: null,
      resolvedLaunch: run.supervision.supervisor.resolvedLaunch,
      supervision: {
        kind: "supervisor",
        turn,
        decisionId,
      },
    },
    state: {
      status: "succeeded",
      plannedAgentId: run.supervision.supervisor.agentId,
      agentId: run.supervision.supervisor.agentId,
      startedAt: timestamp,
      endedAt: timestamp,
    },
  };
}

function createWorkerDispatchUpdate(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  decision: Extract<TeamRunSupervisionDecision, { kind: "dispatch" }>,
  options: {
    outputArtifactId: string;
    phase: PersistedTeamRunSupervision["phase"];
    workItemStatus: PersistedTeamRunSupervision["workItems"][number]["status"];
  },
): TeamRunSupervisionUpdate {
  const template = run.supervision.workerTemplates[0]!;
  return {
    state: run.state,
    steps: [
      ...run.steps,
      createSucceededSupervisorTurn(run, decision.id, decision.sequence, secondTimestamp),
      {
        snapshot: {
          ...template,
          stepId: `worker_${decision.attemptId}`,
          inputArtifactIds: [],
          outputArtifact: {
            id: options.outputArtifactId,
            kind: "team_step_output",
            title: `${template.roleName} output`,
            mediaType: "text/markdown",
          },
          supervision: {
            kind: "worker",
            workItemId: decision.workItemId,
            attemptId: decision.attemptId,
            attemptNumber: 1,
            templateStepId: template.stepId,
            revisionParentAttemptId: null,
          },
        },
        state: {
          status: "creating",
          plannedAgentId: firstAgentId,
          startedAt: secondTimestamp,
        },
      },
    ],
    supervision: {
      ...run.supervision,
      revision: run.supervision.revision + 1,
      phase: options.phase,
      workItems: [
        {
          id: decision.workItemId,
          templateStepId: template.stepId,
          inputArtifactIds: [],
          attemptIds: [decision.attemptId],
          acceptedAttemptId: null,
          status: options.workItemStatus,
        },
      ],
      decisions: [...run.supervision.decisions, decision],
      updatedAt: secondTimestamp,
    },
  };
}

function succeededRunState(run: PersistedTeamRunRecord) {
  const agentIds = [firstAgentId, secondAgentId];
  return {
    state: {
      status: "succeeded" as const,
      startedAt: firstTimestamp,
      endedAt: secondTimestamp,
    },
    steps: run.steps.map((step, index) => {
      const timestamp = index === 0 ? firstTimestamp : secondTimestamp;
      return {
        ...step,
        state: {
          status: "succeeded" as const,
          plannedAgentId: agentIds[index]!,
          agentId: agentIds[index]!,
          startedAt: timestamp,
          endedAt: timestamp,
        },
      };
    }),
  };
}

describe("TeamRepository definitions", () => {
  let paseoHome: string;
  let currentTimestamp: string;
  let repository: TeamRepository;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "team-repository-test-"));
    currentTimestamp = firstTimestamp;
    repository = new TeamRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
    });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("creates definitions and reloads them after restart", async () => {
    const created = await repository.createDefinition(createDefinitionInput());

    expect(created).toMatchObject({
      id: expect.stringMatching(/^team_[0-9a-f]{16}$/),
      revision: 1,
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    });

    const reloaded = new TeamRepository({ paseoHome });
    await expect(reloaded.getDefinition(created.id)).resolves.toEqual(created);
    await expect(reloaded.listDefinitions()).resolves.toEqual({
      definitions: [created],
      issues: [],
    });
  });

  test("keeps definitions visible when their host profile is missing", async () => {
    const input = createDefinitionInput();
    input.roles[0] = { ...input.roles[0]!, profileId: "profile_deleted_later" };

    const created = await repository.createDefinition(input);

    await expect(new TeamRepository({ paseoHome }).listDefinitions()).resolves.toEqual({
      definitions: [created],
      issues: [],
    });
  });

  test("patches one definition field without replacing the remaining record", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    currentTimestamp = secondTimestamp;

    const updated = await repository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Release team" },
    });

    expect(updated).toEqual({
      ...created,
      name: "Release team",
      revision: 2,
      updatedAt: secondTimestamp,
    });
    await expect(new TeamRepository({ paseoHome }).getDefinition(created.id)).resolves.toEqual(
      updated,
    );
  });

  test("serializes concurrent updates so exactly one stale revision fails", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    currentTimestamp = secondTimestamp;

    const outcomes = await Promise.allSettled([
      repository.updateDefinition({
        teamId: created.id,
        expectedRevision: 1,
        patch: { name: "First update" },
      }),
      repository.updateDefinition({
        teamId: created.id,
        expectedRevision: 1,
        patch: { instructions: "Second update" },
      }),
    ]);

    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<PersistedTeamDefinition> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(TeamRevisionConflictError);
    expect(rejected[0]?.reason).toMatchObject({
      code: "team_revision_conflict",
      teamId: created.id,
      expectedRevision: 1,
      actualRevision: 2,
    });
    await expect(repository.getDefinition(created.id)).resolves.toEqual(fulfilled[0]?.value);
  });

  test("serializes stale-revision updates across repository instances", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    let releaseFirstWrite: (() => void) | null = null;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteEntered: (() => void) | null = null;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstWriteEntered = resolve;
    });
    const firstRepository = new TeamRepository({
      paseoHome,
      now: () => new Date(secondTimestamp),
      writeJson: async (filePath, value) => {
        firstWriteEntered?.();
        await firstWriteBlocked;
        await writeJsonFileAtomic(filePath, value);
      },
    });
    const secondRepository = new TeamRepository({
      paseoHome,
      now: () => new Date(secondTimestamp),
    });

    const firstUpdate = firstRepository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "First instance" },
    });
    await firstWriteStarted;
    const secondUpdate = secondRepository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Second instance" },
    });
    releaseFirstWrite?.();
    const outcomes = await Promise.allSettled([firstUpdate, secondUpdate]);

    expect(outcomes[0]).toMatchObject({ status: "fulfilled" });
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      reason: { code: "team_revision_conflict", actualRevision: 2 },
    });
    await expect(repository.getDefinition(created.id)).resolves.toMatchObject({
      name: "First instance",
      revision: 2,
    });
  });

  test("reports unknown and corrupt files without hiding healthy definitions", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    const definitionsDir = join(paseoHome, "teams", "definitions");
    await writeFile(join(definitionsDir, "broken.json"), '{"id":', "utf8");
    await writeFile(join(definitionsDir, "notes.txt"), "unexpected", "utf8");

    const listed = await repository.listDefinitions();

    expect(listed.definitions).toEqual([created]);
    expect(listed.issues).toEqual([
      expect.objectContaining({
        collection: "definitions",
        fileName: "broken.json",
        kind: "invalid_record",
      }),
      expect.objectContaining({
        collection: "definitions",
        fileName: "notes.txt",
        kind: "unknown_file",
      }),
    ]);
  });

  test("notifies observers only after durable definition changes", async () => {
    const changes: TeamRepositoryChange[] = [];
    const unsubscribe = repository.subscribe((change) => changes.push(change));
    const created = await repository.createDefinition(createDefinitionInput());
    currentTimestamp = secondTimestamp;
    const updated = await repository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Observed update" },
    });
    await repository.deleteDefinition({ teamId: created.id, expectedRevision: 2 });
    unsubscribe();
    await repository.createDefinition({
      ...createDefinitionInput(),
      name: "Unobserved team",
    });

    expect(changes).toEqual([
      { type: "definition_created", definition: created },
      { type: "definition_updated", definition: updated },
      { type: "definition_deleted", teamId: created.id, revision: 2 },
    ]);
  });

  test("rejects deletion with a stale revision", async () => {
    const created = await repository.createDefinition(createDefinitionInput());
    await repository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Second revision" },
    });

    await expect(
      repository.deleteDefinition({ teamId: created.id, expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(TeamRevisionConflictError);
    await expect(repository.getDefinition(created.id)).resolves.toMatchObject({ revision: 2 });
  });

  test("retains the previous record when an atomic update is interrupted", async () => {
    let interruptNextWrite = false;
    const interruptedRepository = new TeamRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      writeJson: async (filePath, value) => {
        if (interruptNextWrite) {
          await writeFile(`${filePath}.interrupted.tmp`, '{"partial":', "utf8");
          throw new Error("simulated interruption before rename");
        }
        await writeJsonFileAtomic(filePath, value);
      },
    });
    const changes: TeamRepositoryChange[] = [];
    interruptedRepository.subscribe((change) => changes.push(change));
    const created = await interruptedRepository.createDefinition(createDefinitionInput());
    currentTimestamp = secondTimestamp;
    interruptNextWrite = true;

    await expect(
      interruptedRepository.updateDefinition({
        teamId: created.id,
        expectedRevision: 1,
        patch: { name: "Incomplete update" },
      }),
    ).rejects.toThrow("simulated interruption before rename");

    await expect(interruptedRepository.getDefinition(created.id)).resolves.toEqual(created);
    expect(changes).toEqual([{ type: "definition_created", definition: created }]);

    interruptNextWrite = false;
    const recovered = await interruptedRepository.updateDefinition({
      teamId: created.id,
      expectedRevision: 1,
      patch: { name: "Recovered update" },
    });
    expect(recovered).toMatchObject({ name: "Recovered update", revision: 2 });
  });

  test("reports unknown directories in the definitions collection", async () => {
    await mkdir(join(paseoHome, "teams", "definitions", "nested"), { recursive: true });

    const listed = await repository.listDefinitions();

    expect(listed.definitions).toEqual([]);
    expect(listed.issues).toEqual([
      expect.objectContaining({
        collection: "definitions",
        fileName: "nested",
        kind: "unknown_file",
      }),
    ]);
  });

  test("rejects path-shaped IDs at the repository boundary", async () => {
    await expect(repository.getDefinition("../outside")).rejects.toBeInstanceOf(
      TeamRepositoryIdError,
    );
    await expect(repository.getRun("../../outside")).rejects.toMatchObject({
      code: "invalid_team_repository_id",
      entityId: "../../outside",
    });
  });
});

describe("TeamRepository runs", () => {
  let paseoHome: string;
  let currentTimestamp: string;
  let repository: TeamRepository;
  let definition: PersistedTeamDefinition;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "team-run-repository-test-"));
    currentTimestamp = firstTimestamp;
    repository = new TeamRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
    });
    definition = await repository.createDefinition(createDefinitionInput());
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("durably creates a queued run with the accepted Team snapshot", async () => {
    const run = await repository.createRun(createRunInput(definition));

    expect(run).toMatchObject({
      id: expect.stringMatching(/^trun_[0-9a-f]{16}$/),
      teamId: definition.id,
      teamRevision: 1,
      idempotencyKey: "start-1",
      teamSnapshot: definition,
      state: { status: "queued" },
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    });
    await expect(new TeamRepository({ paseoHome }).getRun(run.id)).resolves.toEqual(run);
  });

  test("durably admits a frozen Assignment with a preallocated sequential Artifact plan", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const assignment = await assignments.createAssignment({
      title: "Assignment-backed Team Run",
      objective: "Deliver the Assignment objective.",
      workItem: null,
    });
    const run = await repository.createAssignmentRun(
      createAssignmentRunInput(definition, assignment),
      assignments,
    );

    expect(run).toMatchObject({
      objective: assignment.objective,
      assignmentId: assignment.id,
      assignmentRevision: assignment.revision,
      assignmentSnapshot: assignment,
      steps: [
        {
          snapshot: {
            inputArtifactIds: [],
            outputArtifact: {
              id: expect.stringMatching(/^aart_[0-9a-f]{16}$/),
              kind: "team_step_output",
              title: "Builder output",
              mediaType: "text/markdown",
            },
          },
        },
        {
          snapshot: {
            inputArtifactIds: [run.steps[0]!.snapshot.outputArtifact!.id],
            outputArtifact: {
              id: expect.stringMatching(/^aart_[0-9a-f]{16}$/),
              kind: "team_step_output",
              title: "Reviewer output",
              mediaType: "text/markdown",
            },
          },
        },
      ],
    });
    expect(run.steps[1]!.snapshot.outputArtifact!.id).not.toBe(
      run.steps[0]!.snapshot.outputArtifact!.id,
    );

    currentTimestamp = secondTimestamp;
    await assignments.patchAssignment({
      assignmentId: assignment.id,
      expectedRevision: 1,
      patch: { objective: "Edited after acceptance." },
    });
    await repository.updateDefinition({
      teamId: definition.id,
      expectedRevision: 1,
      patch: { name: "Edited Team" },
    });
    await expect(repository.getRun(run.id)).resolves.toEqual(run);
  });

  test("durably admits a supervised Assignment without exposing it to the sequential executor", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const assignment = await assignments.createAssignment({
      title: "Supervised Assignment",
      objective: "Freeze supervised execution before any agent starts.",
      workItem: null,
    });
    const sequentialInput = createAssignmentRunInput(definition, assignment);
    const { steps: _steps, ...admission } = sequentialInput;
    const run = await repository.createSupervisedAssignmentRun(
      { ...admission, supervision: createSupervision(definition) },
      assignments,
    );

    expect(run).toMatchObject({
      assignmentId: assignment.id,
      steps: [],
      state: { status: "queued" },
      supervision: {
        revision: 1,
        phase: "queued",
        supervisor: {
          roleId: "role_supervisor",
          agentId: "0c783b8c-1bd7-4d79-863e-63a311742eef",
        },
        workItems: [],
        decisions: [],
      },
    });
    await expect(new TeamRepository({ paseoHome }).getRun(run.id)).resolves.toEqual(run);
    await expect(
      repository.createAssignmentRun(sequentialInput, assignments),
    ).rejects.toBeInstanceOf(TeamRunIdempotencyConflictError);
  });

  test("commits supervisor decisions atomically with revision and action idempotency", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const assignment = await assignments.createAssignment({
      title: "Durable supervisor decision",
      objective: "Persist the decision before any later external effect.",
      workItem: null,
    });
    const sequentialInput = createAssignmentRunInput(definition, assignment);
    const { steps: _steps, ...admission } = sequentialInput;
    const admitted = await repository.createSupervisedAssignmentRun(
      { ...admission, supervision: createSupervision(definition) },
      assignments,
    );
    currentTimestamp = secondTimestamp;
    const decision = {
      id: "decision_plan_1",
      sequence: 1,
      actionId: "action_plan_1",
      kind: "plan" as const,
      summary: "Accept the bounded workflow templates.",
      workItemId: null,
      attemptId: null,
      createdAt: secondTimestamp,
    };
    const committed = await repository.commitSupervisionDecision(
      {
        runId: admitted.id,
        expectedSupervisionRevision: 1,
        decision,
      },
      (current) => ({
        state: { status: "running", startedAt: secondTimestamp },
        steps: [
          {
            snapshot: {
              stepId: "supervisor_turn_1",
              roleId: current.supervision.supervisor.roleId,
              roleName: current.supervision.supervisor.roleName,
              roleInstructions: current.supervision.supervisor.roleInstructions,
              stepInstructions: null,
              resolvedLaunch: current.supervision.supervisor.resolvedLaunch,
              supervision: {
                kind: "supervisor",
                turn: 1,
                decisionId: decision.id,
              },
            },
            state: {
              status: "succeeded",
              plannedAgentId: current.supervision.supervisor.agentId,
              agentId: current.supervision.supervisor.agentId,
              startedAt: secondTimestamp,
              endedAt: secondTimestamp,
            },
          },
        ],
        supervision: {
          ...current.supervision,
          revision: 2,
          phase: "planning",
          decisions: [decision],
        },
      }),
    );

    expect(committed).toMatchObject({
      state: { status: "running" },
      supervision: { revision: 2, decisions: [decision], updatedAt: secondTimestamp },
      updatedAt: secondTimestamp,
    });
    const repeated = await repository.commitSupervisionDecision(
      {
        runId: admitted.id,
        expectedSupervisionRevision: 1,
        decision,
      },
      () => {
        throw new Error("Idempotent retry must not invoke the updater");
      },
    );
    expect(repeated).toEqual(committed);

    const mutationDecision = {
      ...decision,
      id: "decision_dispatch_2",
      sequence: 2,
      actionId: "action_dispatch_2",
      kind: "plan" as const,
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: mutationDecision,
        },
        (current) => {
          current.supervision.supervisor.roleName = "Mutated supervisor";
          return {
            state: current.state,
            steps: current.steps,
            supervision: {
              ...current.supervision,
              revision: 3,
              decisions: [...current.supervision.decisions, mutationDecision],
              updatedAt: secondTimestamp,
            },
          };
        },
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);
    await expect(repository.getRun(admitted.id)).resolves.toEqual(committed);

    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: { ...decision, summary: "Conflicting action payload." },
        },
        () => {
          throw new Error("Conflicting action must not invoke the updater");
        },
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 1,
          decision: {
            ...decision,
            id: "decision_dispatch_2",
            sequence: 2,
            actionId: "action_dispatch_2",
            kind: "plan",
          },
        },
        () => {
          throw new Error("Stale revision must not invoke the updater");
        },
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionRevisionConflictError);

    const inactiveWorkItemDispatch = {
      ...decision,
      id: "decision_dispatch_inactive_work_2",
      sequence: 2,
      actionId: "action_dispatch_inactive_work_2",
      kind: "dispatch" as const,
      summary: "Dispatch one bounded worker attempt.",
      workItemId: "work_inactive_dispatch",
      attemptId: "attempt_inactive_dispatch",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: inactiveWorkItemDispatch,
        },
        (current) =>
          createWorkerDispatchUpdate(current, inactiveWorkItemDispatch, {
            outputArtifactId: "aart_4444444444444444",
            phase: "working",
            workItemStatus: "planned",
          }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);
    await expect(repository.getRun(admitted.id)).resolves.toEqual(committed);

    const planningPhaseDispatch = {
      ...inactiveWorkItemDispatch,
      id: "decision_dispatch_planning_phase_2",
      actionId: "action_dispatch_planning_phase_2",
      workItemId: "work_planning_phase_dispatch",
      attemptId: "attempt_planning_phase_dispatch",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: planningPhaseDispatch,
        },
        (current) =>
          createWorkerDispatchUpdate(current, planningPhaseDispatch, {
            outputArtifactId: "aart_5555555555555555",
            phase: "planning",
            workItemStatus: "active",
          }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);

    const artifactOwnerAssignment = await assignments.createAssignment({
      title: "Reserved supervised output",
      objective: "Reserve an output Artifact ID in another Team Run.",
      workItem: null,
    });
    const artifactOwnerRun = await repository.createAssignmentRun(
      createAssignmentRunInput(
        definition,
        artifactOwnerAssignment,
        "reserved-supervised-output",
        "wks_reserved_output_01",
      ),
      assignments,
    );
    const reservedOutputArtifactId = artifactOwnerRun.steps[0]!.snapshot.outputArtifact!.id;
    const collidingOutputDispatch = {
      ...inactiveWorkItemDispatch,
      id: "decision_dispatch_reserved_output_2",
      actionId: "action_dispatch_reserved_output_2",
      workItemId: "work_reserved_output_dispatch",
      attemptId: "attempt_reserved_output_dispatch",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: collidingOutputDispatch,
        },
        (current) =>
          createWorkerDispatchUpdate(current, collidingOutputDispatch, {
            outputArtifactId: reservedOutputArtifactId,
            phase: "working",
            workItemStatus: "active",
          }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);
    await expect(repository.getRun(admitted.id)).resolves.toEqual(committed);

    const stateRewriteDecision = {
      ...decision,
      id: "decision_rewrite_run_state_2",
      sequence: 2,
      actionId: "action_rewrite_run_state_2",
      summary: "Preserve the existing outer run provenance.",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: stateRewriteDecision,
        },
        (current) => ({
          state: { status: "running", startedAt: firstTimestamp },
          steps: [
            ...current.steps,
            createSucceededSupervisorTurn(current, stateRewriteDecision.id, 2, secondTimestamp),
          ],
          supervision: {
            ...current.supervision,
            revision: 3,
            decisions: [...current.supervision.decisions, stateRewriteDecision],
            updatedAt: secondTimestamp,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);

    const transitionRewriteDecision = {
      ...decision,
      id: "decision_rewrite_run_transition_2",
      sequence: 2,
      actionId: "action_rewrite_run_transition_2",
      kind: "complete" as const,
      summary: "Complete without rewriting the run start time.",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: transitionRewriteDecision,
        },
        (current) => ({
          state: {
            status: "succeeded",
            startedAt: firstTimestamp,
            endedAt: secondTimestamp,
          },
          steps: [
            ...current.steps,
            createSucceededSupervisorTurn(
              current,
              transitionRewriteDecision.id,
              2,
              secondTimestamp,
            ),
          ],
          supervision: {
            ...current.supervision,
            revision: 3,
            phase: "completed",
            decisions: [...current.supervision.decisions, transitionRewriteDecision],
            updatedAt: secondTimestamp,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);

    const unauthorizedCompletionDecision = {
      ...decision,
      id: "decision_unauthorized_completion_2",
      sequence: 2,
      actionId: "action_unauthorized_completion_2",
      summary: "A plan must not authorize successful terminalization.",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: unauthorizedCompletionDecision,
        },
        (current) => ({
          state: {
            status: "succeeded",
            startedAt: secondTimestamp,
            endedAt: secondTimestamp,
          },
          steps: [
            ...current.steps,
            createSucceededSupervisorTurn(
              current,
              unauthorizedCompletionDecision.id,
              2,
              secondTimestamp,
            ),
          ],
          supervision: {
            ...current.supervision,
            revision: 3,
            phase: "completed",
            decisions: [...current.supervision.decisions, unauthorizedCompletionDecision],
            updatedAt: secondTimestamp,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);

    const incompleteEscalationDecision = {
      ...decision,
      id: "decision_incomplete_escalation_2",
      sequence: 2,
      actionId: "action_incomplete_escalation_2",
      kind: "escalate" as const,
      summary: "Request a human decision.",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: incompleteEscalationDecision,
        },
        (current) => ({
          state: current.state,
          steps: [
            ...current.steps,
            createSucceededSupervisorTurn(
              current,
              incompleteEscalationDecision.id,
              2,
              secondTimestamp,
            ),
          ],
          supervision: {
            ...current.supervision,
            revision: 3,
            decisions: [...current.supervision.decisions, incompleteEscalationDecision],
            updatedAt: secondTimestamp,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);

    const unauthorizedHumanWaitDecision = {
      ...decision,
      id: "decision_unauthorized_human_wait_2",
      sequence: 2,
      actionId: "action_unauthorized_human_wait_2",
      summary: "A plan must not create a pending human wait.",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: unauthorizedHumanWaitDecision,
        },
        (current) => ({
          state: current.state,
          steps: [
            ...current.steps,
            createSucceededSupervisorTurn(
              current,
              unauthorizedHumanWaitDecision.id,
              2,
              secondTimestamp,
            ),
          ],
          supervision: {
            ...current.supervision,
            revision: 3,
            phase: "awaiting_human",
            decisions: [...current.supervision.decisions, unauthorizedHumanWaitDecision],
            humanRequest: {
              id: "human_unauthorized_wait",
              revision: 1,
              kind: "approval",
              title: "Choose the next action",
              detail: "Resume with the selected bounded action.",
              actions: [{ id: "continue", label: "Continue", requiresNote: false }],
              roleIds: [current.supervision.supervisor.roleId],
              agentIds: [current.supervision.supervisor.agentId],
              stepIds: [],
              artifactIds: [],
              createdAt: secondTimestamp,
            },
            updatedAt: secondTimestamp,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);
    await expect(repository.getRun(admitted.id)).resolves.toEqual(committed);

    const escalationDecision = {
      ...decision,
      id: "decision_escalate_2",
      sequence: 2,
      actionId: "action_escalate_2",
      kind: "escalate" as const,
      summary: "Ask the human to choose the bounded next action.",
    };
    const awaitingHuman = await repository.commitSupervisionDecision(
      {
        runId: admitted.id,
        expectedSupervisionRevision: 2,
        decision: escalationDecision,
      },
      (current) => ({
        state: current.state,
        steps: [
          ...current.steps,
          {
            snapshot: {
              stepId: "supervisor_turn_2",
              roleId: current.supervision.supervisor.roleId,
              roleName: current.supervision.supervisor.roleName,
              roleInstructions: current.supervision.supervisor.roleInstructions,
              stepInstructions: null,
              resolvedLaunch: current.supervision.supervisor.resolvedLaunch,
              supervision: {
                kind: "supervisor",
                turn: 2,
                decisionId: escalationDecision.id,
              },
            },
            state: {
              status: "succeeded",
              plannedAgentId: current.supervision.supervisor.agentId,
              agentId: current.supervision.supervisor.agentId,
              startedAt: secondTimestamp,
              endedAt: secondTimestamp,
            },
          },
        ],
        supervision: {
          ...current.supervision,
          revision: 3,
          phase: "awaiting_human",
          decisions: [...current.supervision.decisions, escalationDecision],
          workItems: [
            {
              id: "work_pending_review",
              templateStepId: current.supervision.workerTemplates[0]!.stepId,
              inputArtifactIds: [],
              attemptIds: [],
              acceptedAttemptId: null,
              status: "planned",
            },
          ],
          humanRequest: {
            id: "human_review_1",
            revision: 1,
            kind: "approval",
            title: "Choose the next action",
            detail: "Select one frozen action before the run continues.",
            actions: [
              { id: "continue", label: "Continue", requiresNote: false },
              { id: "cancel", label: "Cancel", requiresNote: false },
            ],
            roleIds: [current.supervision.supervisor.roleId],
            agentIds: [current.supervision.supervisor.agentId],
            stepIds: [],
            artifactIds: [],
            createdAt: secondTimestamp,
          },
          updatedAt: secondTimestamp,
        },
      }),
    );
    expect(awaitingHuman.supervision?.phase).toBe("awaiting_human");
    expect(awaitingHuman.supervision?.humanRequest).not.toHaveProperty("retirement");

    const decisionDuringHumanWait = {
      ...decision,
      id: "decision_during_human_wait",
      sequence: 3,
      actionId: "action_during_human_wait",
      summary: "This action must wait for the human response.",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: awaitingHuman.supervision!.revision,
          decision: decisionDuringHumanWait,
        },
        () => {
          throw new Error("A human-waiting run must not invoke the updater for a new action");
        },
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);

    const canceled = await repository.updateRun(admitted.id, (current) => ({
      steps: current.steps,
      state: {
        status: "canceled",
        startedAt: secondTimestamp,
        endedAt: secondTimestamp,
      },
    }));

    expect(canceled.supervision).toMatchObject({
      revision: 4,
      phase: "canceled",
      workItems: [{ id: "work_pending_review", status: "canceled" }],
      humanRequest: {
        id: "human_review_1",
        retirement: { reason: "canceled", retiredAt: secondTimestamp },
      },
    });
    expect(toTeamRunDto(canceled).supervision).not.toHaveProperty("pendingHumanRequest");
    await expect(repository.getActiveRunForAssignment(assignment.id)).resolves.toBeNull();

    const postTerminalChanges: TeamRepositoryChange[] = [];
    const unsubscribe = repository.subscribe((change) => postTerminalChanges.push(change));
    currentTimestamp = "2026-08-25T12:02:00.000Z";
    const unchangedAfterCancellation = await repository.updateRun(admitted.id, (current) => ({
      steps: current.steps,
      state: current.state,
    }));
    unsubscribe();
    expect(unchangedAfterCancellation).toEqual(canceled);
    expect(postTerminalChanges).toEqual([]);

    const repeatedAfterCancellation = await repository.commitSupervisionDecision(
      {
        runId: admitted.id,
        expectedSupervisionRevision: 2,
        decision: escalationDecision,
      },
      () => {
        throw new Error("A terminal idempotent retry must not invoke the updater");
      },
    );
    expect(repeatedAfterCancellation).toEqual(canceled);

    const postCancellationDecision = {
      ...decision,
      id: "decision_dispatch_after_cancel",
      sequence: 3,
      actionId: "action_dispatch_after_cancel",
      kind: "plan" as const,
      summary: "This action must not be committed after cancellation.",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: canceled.supervision!.revision,
          decision: postCancellationDecision,
        },
        () => {
          throw new Error("A terminal run must not invoke the updater for a new action");
        },
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);
    await expect(repository.getRun(admitted.id)).resolves.toEqual(canceled);
  });

  test("preserves planned work and settled human evidence across decisions", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const assignment = await assignments.createAssignment({
      title: "Durable supervision evidence",
      objective: "Keep planned work and human decisions in the run ledger.",
      workItem: null,
    });
    const sequentialInput = createAssignmentRunInput(
      definition,
      assignment,
      "durable-supervision-evidence",
    );
    const { steps: _steps, ...admission } = sequentialInput;
    const admitted = await repository.createSupervisedAssignmentRun(
      { ...admission, supervision: createSupervision(definition) },
      assignments,
    );
    currentTimestamp = secondTimestamp;
    const plannedWorkItemId = "work_preserved_plan";
    const escalationDecision = {
      id: "decision_preserve_evidence_1",
      sequence: 1,
      actionId: "action_preserve_evidence_1",
      kind: "escalate" as const,
      summary: "Ask the human before continuing planned work.",
      workItemId: plannedWorkItemId,
      attemptId: null,
      createdAt: secondTimestamp,
    };
    const awaitingHuman = await repository.commitSupervisionDecision(
      {
        runId: admitted.id,
        expectedSupervisionRevision: 1,
        decision: escalationDecision,
      },
      (current) => ({
        state: { status: "running", startedAt: secondTimestamp },
        steps: [createSucceededSupervisorTurn(current, escalationDecision.id, 1, secondTimestamp)],
        supervision: {
          ...current.supervision,
          revision: 2,
          phase: "awaiting_human",
          workItems: [
            {
              id: plannedWorkItemId,
              templateStepId: current.supervision.workerTemplates[0]!.stepId,
              inputArtifactIds: [],
              attemptIds: [],
              acceptedAttemptId: null,
              status: "planned",
            },
          ],
          decisions: [escalationDecision],
          humanRequest: {
            id: "human_preserved_evidence",
            revision: 1,
            kind: "approval",
            title: "Choose the next action",
            detail: "Resume with the selected bounded action.",
            actions: [{ id: "continue", label: "Continue", requiresNote: false }],
            roleIds: [current.supervision.supervisor.roleId],
            agentIds: [current.supervision.supervisor.agentId],
            stepIds: [],
            artifactIds: [],
            createdAt: secondTimestamp,
          },
          updatedAt: secondTimestamp,
        },
      }),
    );
    const resolved = PersistedTeamRunRecordSchema.parse({
      ...awaitingHuman,
      supervision: {
        ...awaitingHuman.supervision!,
        revision: 3,
        phase: "planning",
        humanRequest: {
          ...awaitingHuman.supervision!.humanRequest!,
          resolution: {
            actionId: "continue",
            note: null,
            idempotencyKey: "resolve-preserved-evidence",
            resolvedAt: secondTimestamp,
          },
        },
        updatedAt: secondTimestamp,
      },
    });
    await writeJsonFileAtomic(join(paseoHome, "teams", "runs", `${admitted.id}.json`), resolved);

    const eraseWorkDecision = {
      id: "decision_erase_work_2",
      sequence: 2,
      actionId: "action_erase_work_2",
      kind: "complete" as const,
      summary: "This must not erase unfinished planned work.",
      workItemId: null,
      attemptId: null,
      createdAt: secondTimestamp,
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 3,
          decision: eraseWorkDecision,
        },
        (current) => ({
          state: {
            status: "succeeded",
            startedAt: secondTimestamp,
            endedAt: secondTimestamp,
          },
          steps: [
            ...current.steps,
            createSucceededSupervisorTurn(current, eraseWorkDecision.id, 2, secondTimestamp),
          ],
          supervision: {
            ...current.supervision,
            revision: 4,
            phase: "completed",
            workItems: [],
            decisions: [...current.supervision.decisions, eraseWorkDecision],
            updatedAt: secondTimestamp,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);

    const eraseHumanDecision = {
      id: "decision_erase_human_2",
      sequence: 2,
      actionId: "action_erase_human_2",
      kind: "plan" as const,
      summary: "This must not erase settled human evidence.",
      workItemId: null,
      attemptId: null,
      createdAt: secondTimestamp,
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 3,
          decision: eraseHumanDecision,
        },
        (current) => ({
          state: current.state,
          steps: [
            ...current.steps,
            createSucceededSupervisorTurn(current, eraseHumanDecision.id, 2, secondTimestamp),
          ],
          supervision: {
            ...current.supervision,
            revision: 4,
            humanRequest: null,
            decisions: [...current.supervision.decisions, eraseHumanDecision],
            updatedAt: secondTimestamp,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);
    await expect(repository.getRun(admitted.id)).resolves.toEqual(resolved);
  });

  test("rejects replay or rewrite of terminal worker history during a decision", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const assignment = await assignments.createAssignment({
      title: "Terminal worker history",
      objective: "Never reopen a completed attempt.",
      workItem: null,
    });
    const sequentialInput = createAssignmentRunInput(
      definition,
      assignment,
      "terminal-worker-history",
    );
    const { steps: _steps, ...admission } = sequentialInput;
    const admitted = await repository.createSupervisedAssignmentRun(
      { ...admission, supervision: createSupervision(definition) },
      assignments,
    );
    const workItemId = "work_terminal_attempt";
    const attemptId = "attempt_terminal_1";
    const dispatchDecision = {
      id: "decision_dispatch_terminal",
      sequence: 1,
      actionId: "action_dispatch_terminal",
      kind: "dispatch" as const,
      summary: "Dispatch the bounded worker attempt.",
      workItemId,
      attemptId,
      createdAt: secondTimestamp,
    };
    currentTimestamp = secondTimestamp;
    const creating = await repository.commitSupervisionDecision(
      {
        runId: admitted.id,
        expectedSupervisionRevision: 1,
        decision: dispatchDecision,
      },
      (current) => {
        const template = current.supervision.workerTemplates[0]!;
        return {
          state: { status: "running", startedAt: secondTimestamp },
          steps: [
            {
              snapshot: {
                stepId: "supervisor_turn_terminal_1",
                roleId: current.supervision.supervisor.roleId,
                roleName: current.supervision.supervisor.roleName,
                roleInstructions: current.supervision.supervisor.roleInstructions,
                stepInstructions: null,
                resolvedLaunch: current.supervision.supervisor.resolvedLaunch,
                supervision: {
                  kind: "supervisor",
                  turn: 1,
                  decisionId: dispatchDecision.id,
                },
              },
              state: {
                status: "succeeded",
                plannedAgentId: current.supervision.supervisor.agentId,
                agentId: current.supervision.supervisor.agentId,
                startedAt: secondTimestamp,
                endedAt: secondTimestamp,
              },
            },
            {
              snapshot: {
                ...template,
                stepId: "worker_terminal_attempt_1",
                inputArtifactIds: [],
                outputArtifact: {
                  id: "aart_3333333333333333",
                  kind: "team_step_output",
                  title: `${template.roleName} output`,
                  mediaType: "text/markdown",
                },
                supervision: {
                  kind: "worker",
                  workItemId,
                  attemptId,
                  attemptNumber: 1,
                  templateStepId: template.stepId,
                  revisionParentAttemptId: null,
                },
              },
              state: {
                status: "creating",
                plannedAgentId: firstAgentId,
                startedAt: secondTimestamp,
              },
            },
          ],
          supervision: {
            ...current.supervision,
            revision: 2,
            phase: "working",
            workItems: [
              {
                id: workItemId,
                templateStepId: template.stepId,
                inputArtifactIds: [],
                attemptIds: [attemptId],
                acceptedAttemptId: null,
                status: "active",
              },
            ],
            decisions: [dispatchDecision],
            updatedAt: secondTimestamp,
          },
        };
      },
    );
    const failedSteps: PersistedTeamRunRecord["steps"] = [];
    for (const step of creating.steps) {
      failedSteps.push(
        step.snapshot.supervision?.kind === "worker"
          ? {
              ...step,
              state: {
                status: "failed",
                plannedAgentId: firstAgentId,
                agentId: firstAgentId,
                startedAt: secondTimestamp,
                endedAt: secondTimestamp,
                error: "Worker failed.",
              },
            }
          : step,
      );
    }
    const failedWorkItems: PersistedTeamRunSupervision["workItems"] = [];
    for (const workItem of creating.supervision!.workItems) {
      failedWorkItems.push({ ...workItem, status: "failed" });
    }
    const failed = PersistedTeamRunRecordSchema.parse({
      ...creating,
      steps: failedSteps,
      supervision: {
        ...creating.supervision!,
        workItems: failedWorkItems,
      },
    });
    await writeJsonFileAtomic(join(paseoHome, "teams", "runs", `${admitted.id}.json`), failed);
    const redispatchDecision = {
      ...dispatchDecision,
      id: "decision_redispatch_terminal",
      sequence: 2,
      actionId: "action_redispatch_terminal",
      summary: "This decision must not redispatch a terminal attempt.",
    };
    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: redispatchDecision,
        },
        (current) => ({
          state: current.state,
          steps: [
            ...current.steps,
            {
              snapshot: {
                stepId: "supervisor_turn_redispatch_2",
                roleId: current.supervision.supervisor.roleId,
                roleName: current.supervision.supervisor.roleName,
                roleInstructions: current.supervision.supervisor.roleInstructions,
                stepInstructions: null,
                resolvedLaunch: current.supervision.supervisor.resolvedLaunch,
                supervision: {
                  kind: "supervisor",
                  turn: 2,
                  decisionId: redispatchDecision.id,
                },
              },
              state: {
                status: "succeeded",
                plannedAgentId: current.supervision.supervisor.agentId,
                agentId: current.supervision.supervisor.agentId,
                startedAt: secondTimestamp,
                endedAt: secondTimestamp,
              },
            },
          ],
          supervision: {
            ...current.supervision,
            revision: 3,
            decisions: [...current.supervision.decisions, redispatchDecision],
            updatedAt: secondTimestamp,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);

    const replayDecision = {
      id: "decision_replay_terminal",
      sequence: 2,
      actionId: "action_replay_terminal",
      kind: "plan" as const,
      summary: "This decision must not reopen terminal history.",
      workItemId: null,
      attemptId: null,
      createdAt: secondTimestamp,
    };

    await expect(
      repository.commitSupervisionDecision(
        {
          runId: admitted.id,
          expectedSupervisionRevision: 2,
          decision: replayDecision,
        },
        (current) => {
          const replayedSteps: PersistedTeamRunRecord["steps"] = [];
          for (const step of current.steps) {
            replayedSteps.push(
              step.snapshot.supervision?.kind === "worker" && step.state.status === "failed"
                ? {
                    ...step,
                    state: {
                      ...step.state,
                      error: "Rewritten worker failure.",
                    },
                  }
                : step,
            );
          }
          replayedSteps.push({
            snapshot: {
              stepId: "supervisor_turn_terminal_2",
              roleId: current.supervision.supervisor.roleId,
              roleName: current.supervision.supervisor.roleName,
              roleInstructions: current.supervision.supervisor.roleInstructions,
              stepInstructions: null,
              resolvedLaunch: current.supervision.supervisor.resolvedLaunch,
              supervision: {
                kind: "supervisor",
                turn: 2,
                decisionId: replayDecision.id,
              },
            },
            state: {
              status: "succeeded",
              plannedAgentId: current.supervision.supervisor.agentId,
              agentId: current.supervision.supervisor.agentId,
              startedAt: secondTimestamp,
              endedAt: secondTimestamp,
            },
          });
          return {
            state: current.state,
            steps: replayedSteps,
            supervision: {
              ...current.supervision,
              revision: 3,
              decisions: [...current.supervision.decisions, replayDecision],
              updatedAt: secondTimestamp,
            },
          };
        },
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);
    await expect(repository.getRun(admitted.id)).resolves.toEqual(failed);
  });

  test("rejects missing, stale, and terminal Assignments before creating a run", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const missingInput = createAssignmentRunInput(definition, {
      id: "asgn_0000000000000000",
      revision: 1,
    });
    await expect(repository.createAssignmentRun(missingInput, assignments)).rejects.toBeInstanceOf(
      AssignmentNotFoundError,
    );

    const stale = await assignments.createAssignment({
      title: "Stale Assignment",
      objective: "This revision will become stale.",
      workItem: null,
    });
    await assignments.patchAssignment({
      assignmentId: stale.id,
      expectedRevision: 1,
      patch: { title: "New revision" },
    });
    await expect(
      repository.createAssignmentRun(
        createAssignmentRunInput(definition, stale, "stale", "wks_stale_assignment"),
        assignments,
      ),
    ).rejects.toBeInstanceOf(AssignmentRevisionConflictError);

    const terminal = await assignments.createAssignment({
      title: "Terminal Assignment",
      objective: "This Assignment will be completed before admission.",
      workItem: null,
    });
    const completed = await assignments.completeAssignment({
      assignmentId: terminal.id,
      expectedRevision: 1,
    });
    await expect(
      repository.createAssignmentRun(
        createAssignmentRunInput(definition, completed, "terminal", "wks_terminal_assignment"),
        assignments,
      ),
    ).rejects.toBeInstanceOf(AssignmentStateConflictError);
    await expect(repository.listRuns()).resolves.toMatchObject({ runs: [], issues: [] });
  });

  test("shares one mutation boundary with concurrent Assignment edits", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const assignment = await assignments.createAssignment({
      title: "Concurrent Assignment",
      objective: "Do not admit a stale snapshot.",
      workItem: null,
    });
    const input = createAssignmentRunInput(definition, assignment);

    const [edited, admitted] = await Promise.allSettled([
      assignments.patchAssignment({
        assignmentId: assignment.id,
        expectedRevision: 1,
        patch: { title: "Edited first" },
      }),
      repository.createAssignmentRun(input, assignments),
    ]);

    expect(edited.status).toBe("fulfilled");
    expect(admitted).toMatchObject({
      status: "rejected",
      reason: { code: "assignment_revision_conflict", actualRevision: 2 },
    });
    await expect(repository.listRuns()).resolves.toMatchObject({ runs: [], issues: [] });
  });

  test("atomically permits only one active run per Assignment", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const assignment = await assignments.createAssignment({
      title: "Single active run",
      objective: "Admit exactly one active run.",
      workItem: null,
    });

    const outcomes = await Promise.allSettled([
      repository.createAssignmentRun(
        createAssignmentRunInput(definition, assignment, "first", "wks_assignment_first"),
        assignments,
      ),
      repository.createAssignmentRun(
        createAssignmentRunInput(definition, assignment, "second", "wks_assignment_second"),
        assignments,
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      TeamAssignmentHasActiveRunError,
    );
  });

  test("rejects conflicting reuse of Assignment-backed idempotency inputs", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const assignment = await assignments.createAssignment({
      title: "Idempotent Assignment",
      objective: "Bind every immutable admission input.",
      workItem: null,
    });
    const input = createAssignmentRunInput(definition, assignment);
    const run = await repository.createAssignmentRun(input, assignments);

    await expect(repository.createAssignmentRun(input, assignments)).resolves.toEqual(run);
    const conflicts = [
      { ...input, workspace: { ...input.workspace, workspaceId: "wks_other_workspace" } },
      { ...input, expectedRevision: input.expectedRevision + 1 },
      { ...input, expectedAssignmentRevision: input.expectedAssignmentRevision + 1 },
      { ...input, assignmentId: "asgn_fedcba9876543210" },
    ];
    for (const conflict of conflicts) {
      await expect(repository.createAssignmentRun(conflict, assignments)).rejects.toBeInstanceOf(
        TeamRunIdempotencyConflictError,
      );
    }
  });

  test("allows active Assignment edits but fences terminal transitions", async () => {
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
      activeRunStore: repository,
    });
    const assignment = await assignments.createAssignment({
      title: "Lifecycle-fenced Assignment",
      objective: "Remain open while the run is active.",
      workItem: null,
    });
    const run = await repository.createAssignmentRun(
      createAssignmentRunInput(definition, assignment),
      assignments,
    );
    const edited = await assignments.patchAssignment({
      assignmentId: assignment.id,
      expectedRevision: 1,
      patch: { title: "Edit allowed during execution" },
    });

    await expect(
      assignments.completeAssignment({
        assignmentId: assignment.id,
        expectedRevision: edited.revision,
      }),
    ).rejects.toEqual(new AssignmentHasActiveRunError(assignment.id, run.id));
    await expect(
      assignments.cancelAssignment({
        assignmentId: assignment.id,
        expectedRevision: edited.revision,
      }),
    ).rejects.toEqual(new AssignmentHasActiveRunError(assignment.id, run.id));
    currentTimestamp = secondTimestamp;
    await repository.updateRun(run.id, (current) => succeededRunState(current));
    await expect(assignments.getAssignment(assignment.id)).resolves.toMatchObject({
      state: { status: "open" },
    });
    await expect(
      assignments.completeAssignment({
        assignmentId: assignment.id,
        expectedRevision: edited.revision,
      }),
    ).resolves.toMatchObject({ state: { status: "completed" } });
  });

  test("returns one run for concurrent starts with the same idempotency key", async () => {
    const input = createRunInput(definition);

    const [first, second] = await Promise.all([
      repository.createRun(input),
      repository.createRun(input),
    ]);

    expect(second).toEqual(first);
    await expect(repository.listRuns()).resolves.toMatchObject({ runs: [first], issues: [] });
  });

  test("rejects conflicting reuse of objective-only idempotency inputs", async () => {
    const input = createRunInput(definition);
    await repository.createRun(input);

    const conflicts = [
      { ...input, objective: "A different Objective" },
      { ...input, expectedRevision: input.expectedRevision + 1 },
      { ...input, workspace: { ...input.workspace, workspaceId: "wks_other_idempotency" } },
    ];
    for (const conflict of conflicts) {
      await expect(repository.createRun(conflict)).rejects.toBeInstanceOf(
        TeamRunIdempotencyConflictError,
      );
    }
  });

  test("creates distinct runs for different idempotency keys and Workspaces", async () => {
    const first = await repository.createRun(createRunInput(definition, "start-1"));
    const second = await repository.createRun(
      createRunInput(definition, "start-2", "wks_1123456789abcdef"),
    );

    expect(second.id).not.toBe(first.id);
    await expect(repository.listRuns()).resolves.toMatchObject({
      runs: expect.arrayContaining([first, second]),
      issues: [],
    });
  });

  test("atomically rejects competing runs for one Workspace", async () => {
    const [first, second] = await Promise.allSettled([
      repository.createRun(createRunInput(definition, "start-1")),
      repository.createRun(createRunInput(definition, "start-2")),
    ]);

    const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
    const rejected = [first, second].filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.any(TeamWorkspaceHasActiveRunError),
    });
    await expect(repository.listActiveRuns()).resolves.toHaveLength(1);
  });

  test("releases the Workspace after the owning run becomes terminal", async () => {
    const first = await repository.createRun(createRunInput(definition, "start-1"));
    currentTimestamp = secondTimestamp;
    await repository.updateRun(first.id, (current) => succeededRunState(current));

    const second = await repository.createRun(createRunInput(definition, "start-2"));

    await expect(repository.getActiveRunForWorkspace(first.workspace.workspaceId)).resolves.toEqual(
      second,
    );
    await expect(repository.getRunByIdempotency(definition.id, "start-1")).resolves.toMatchObject({
      id: first.id,
      state: { status: "succeeded" },
    });
  });

  test("rejects a stale Team revision before creating a new run", async () => {
    await repository.updateDefinition({
      teamId: definition.id,
      expectedRevision: 1,
      patch: { name: "New revision" },
    });

    await expect(repository.createRun(createRunInput(definition))).rejects.toMatchObject({
      code: "team_revision_conflict",
      teamId: definition.id,
      expectedRevision: 1,
      actualRevision: 2,
    });
    await expect(repository.listRuns()).resolves.toMatchObject({ runs: [], issues: [] });
  });

  test("returns an idempotent run after the Team revision changes", async () => {
    const run = await repository.createRun(createRunInput(definition));
    await repository.updateDefinition({
      teamId: definition.id,
      expectedRevision: 1,
      patch: { name: "New revision" },
    });

    await expect(repository.createRun(createRunInput(definition))).resolves.toEqual(run);
  });

  test("rejects deletion while the Team owns an active run", async () => {
    const run = await repository.createRun(createRunInput(definition));

    await expect(
      repository.deleteDefinition({ teamId: definition.id, expectedRevision: 1 }),
    ).rejects.toEqual(new TeamHasActiveRunError(definition.id, run.id));
    await expect(repository.getDefinition(definition.id)).resolves.toEqual(definition);
  });

  test("deletes a Team after completion while preserving its run snapshot", async () => {
    const run = await repository.createRun(createRunInput(definition));
    currentTimestamp = secondTimestamp;
    const completed = await repository.updateRun(run.id, (current) => succeededRunState(current));

    await repository.deleteDefinition({ teamId: definition.id, expectedRevision: 1 });

    const reloaded = new TeamRepository({ paseoHome });
    await expect(reloaded.getDefinition(definition.id)).resolves.toBeNull();
    await expect(reloaded.getRun(run.id)).resolves.toEqual(completed);
    expect(completed.teamSnapshot).toEqual(definition);
  });

  test("preserves frozen snapshots when an updater mutates its input", async () => {
    const run = await repository.createRun(createRunInput(definition));
    currentTimestamp = secondTimestamp;

    const updated = await repository.updateRun(run.id, (current) => {
      current.teamSnapshot.name = "Rewritten Team";
      current.workspace.displayName = "rewritten/workspace";
      current.steps[0]!.snapshot.roleName = "Rewritten role";
      current.steps[1]!.snapshot.resolvedLaunch.model = "rewritten-model";
      return succeededRunState(current);
    });

    expect(updated.teamSnapshot).toEqual(run.teamSnapshot);
    expect(updated.workspace).toEqual(run.workspace);
    expect(updated.steps.map((step) => step.snapshot)).toEqual(
      run.steps.map((step) => step.snapshot),
    );
    await expect(repository.getRun(run.id)).resolves.toEqual(updated);
  });

  test("notifies observers after durable run creation and updates", async () => {
    const changes: TeamRepositoryChange[] = [];
    repository.subscribe((change) => changes.push(change));
    const run = await repository.createRun(createRunInput(definition));
    currentTimestamp = secondTimestamp;
    const completed = await repository.updateRun(run.id, (current) => succeededRunState(current));

    expect(changes.slice(-2)).toEqual([
      { type: "run_created", run },
      { type: "run_updated", run: completed },
    ]);
  });

  test("reports corrupt run files without hiding healthy history", async () => {
    const run = await repository.createRun(createRunInput(definition));
    const runsDir = join(paseoHome, "teams", "runs");
    await writeFile(join(runsDir, "broken.json"), "not-json", "utf8");

    const listed = await repository.listRuns();

    expect(listed.runs).toEqual([run]);
    expect(listed.issues).toEqual([
      expect.objectContaining({
        collection: "runs",
        fileName: "broken.json",
        kind: "invalid_record",
      }),
    ]);
  });

  test("lists runs newest-first with restart-stable cursor pagination", async () => {
    const runs: PersistedTeamRunRecord[] = [];
    for (let minute = 0; minute < 5; minute += 1) {
      currentTimestamp = `2026-08-25T12:0${minute}:00.000Z`;
      runs.push(
        await repository.createRun(
          createRunInput(definition, `start-${minute}`, `wks_page_${minute}`),
        ),
      );
    }

    const firstPage = await repository.listRuns({ limit: 2 });
    expect(firstPage.runs).toEqual([runs[4], runs[3]]);
    expect(firstPage.nextCursor).not.toBeNull();

    const reloaded = new TeamRepository({ paseoHome });
    const secondPage = await reloaded.listRuns({ cursor: firstPage.nextCursor!, limit: 2 });
    expect(secondPage.runs).toEqual([runs[2], runs[1]]);
    expect(secondPage.nextCursor).not.toBeNull();

    const finalPage = await reloaded.listRuns({ cursor: secondPage.nextCursor!, limit: 2 });
    expect(finalPage).toEqual({ runs: [runs[0]], nextCursor: null, issues: [] });
  });

  test("orders offset timestamps by their instant across cursor pages", async () => {
    const older = await repository.createRun(createRunInput(definition, "older", "wks_older"));
    const newer = await repository.createRun(createRunInput(definition, "newer", "wks_newer"));
    const runsDir = join(paseoHome, "teams", "runs");
    await writeJsonFileAtomic(join(runsDir, `${older.id}.json`), {
      ...older,
      createdAt: "2026-08-25T13:00:00.000+01:00",
      updatedAt: "2026-08-25T13:00:00.000+01:00",
    });
    await writeJsonFileAtomic(join(runsDir, `${newer.id}.json`), {
      ...newer,
      createdAt: "2026-08-25T12:30:00.000Z",
      updatedAt: "2026-08-25T12:30:00.000Z",
    });

    const firstPage = await repository.listRuns({ limit: 1 });
    expect(firstPage.runs.map((run) => run.id)).toEqual([newer.id]);
    const secondPage = await repository.listRuns({ cursor: firstPage.nextCursor!, limit: 1 });
    expect(secondPage.runs.map((run) => run.id)).toEqual([older.id]);
    expect(secondPage.nextCursor).toBeNull();
  });

  test("binds a run cursor to its Team filter", async () => {
    currentTimestamp = "2026-08-25T12:02:00.000Z";
    await repository.createRun(createRunInput(definition, "start-2", "wks_cursor_2"));
    currentTimestamp = "2026-08-25T12:03:00.000Z";
    await repository.createRun(createRunInput(definition, "start-3", "wks_cursor_3"));
    const page = await repository.listRuns({ limit: 1 });

    await expect(
      repository.listRuns({ teamId: definition.id, cursor: page.nextCursor!, limit: 1 }),
    ).rejects.toEqual(new TeamRunPageError("Team Run cursor does not match the Team filter"));
  });

  test("rejects run page sizes outside the bounded range", async () => {
    await expect(repository.listRuns({ limit: 0 })).rejects.toBeInstanceOf(TeamRunPageError);
    await expect(
      repository.listRuns({ limit: TEAM_RUN_PAGE_MAX_LIMIT + 1 }),
    ).rejects.toBeInstanceOf(TeamRunPageError);
  });

  test("fails closed when corruption prevents a complete idempotency check", async () => {
    const runsDir = join(paseoHome, "teams", "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "broken.json"), "not-json", "utf8");

    await expect(repository.createRun(createRunInput(definition))).rejects.toBeInstanceOf(
      TeamStorageCorruptError,
    );
    await expect(
      repository.deleteDefinition({ teamId: definition.id, expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(TeamStorageCorruptError);
  });

  test("reports a leftover atomic temp file without blocking new runs", async () => {
    const runsDir = join(paseoHome, "teams", "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, ".interrupted.tmp"), "partial", "utf8");

    const run = await repository.createRun(createRunInput(definition));
    const listed = await repository.listRuns();

    expect(listed.runs).toEqual([run]);
    expect(listed.issues).toEqual([
      expect.objectContaining({
        collection: "runs",
        fileName: ".interrupted.tmp",
        kind: "unknown_file",
      }),
    ]);
  });
});
