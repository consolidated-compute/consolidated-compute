import { describe, expect, test, vi } from "vitest";

import { SessionInboundMessageSchema, type SessionOutboundMessage } from "../messages.js";
import {
  PersistedAssignmentArtifactRecordSchema,
  PersistedAssignmentRecordSchema,
  type PersistedAssignmentArtifactRecord,
  type PersistedAssignmentRecord,
} from "./model.js";
import {
  AssignmentRevisionConflictError,
  type AssignmentRepositoryFileIssue,
} from "./repository.js";
import {
  AssignmentSession,
  type AssignmentSessionRepository,
  type AssignmentSessionRunService,
} from "./session.js";
import {
  PersistedTeamDefinitionSchema,
  PersistedTeamRunRecordSchema,
  type PersistedTeamRunRecord,
} from "../team/model.js";

const timestamp = "2026-08-27T12:00:00.000Z";

function createAssignment(): PersistedAssignmentRecord {
  return PersistedAssignmentRecordSchema.parse({
    id: "asgn_0123456789abcdef",
    revision: 2,
    title: "Expose Assignment APIs",
    objective: "Publish the durable Assignment contract.",
    workItem: null,
    state: { status: "open" },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function createArtifact(): PersistedAssignmentArtifactRecord {
  return PersistedAssignmentArtifactRecordSchema.parse({
    id: "aart_0123456789abcdef",
    assignmentId: "asgn_0123456789abcdef",
    assignmentRevision: 2,
    kind: "team_step_output",
    title: "Builder output",
    mediaType: "text/markdown",
    content: "Done",
    includedBytes: 4,
    originalBytes: 4,
    truncated: false,
    producer: {
      kind: "team_run_step",
      teamRunId: "trun_0123456789abcdef",
      stepId: "implement",
      roleId: "builder",
      agentId: "11111111-1111-4111-8111-111111111111",
      turnId: "turn_1",
    },
    createdAt: timestamp,
  });
}

function createRun(): PersistedTeamRunRecord {
  const definition = PersistedTeamDefinitionSchema.parse({
    id: "team_delivery",
    revision: 2,
    name: "Delivery Team",
    instructions: "Deliver the objective.",
    roles: [
      {
        id: "builder",
        name: "Builder",
        instructions: "Implement the objective.",
        profileId: "codex-builder",
      },
    ],
    workflow: [{ id: "implement", roleId: "builder", instructions: null }],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return PersistedTeamRunRecordSchema.parse({
    id: "trun_0123456789abcdef",
    teamId: definition.id,
    teamRevision: definition.revision,
    idempotencyKey: "assignment-run-1",
    teamSnapshot: definition,
    objective: "Publish the durable Assignment contract.",
    workspace: {
      workspaceId: "workspace_delivery",
      projectId: "project_delivery",
      cwd: "/repo",
      displayName: "main",
    },
    steps: [
      {
        snapshot: {
          stepId: "implement",
          roleId: "builder",
          roleName: "Builder",
          roleInstructions: "Implement the objective.",
          stepInstructions: null,
          resolvedLaunch: {
            profileId: "codex-builder",
            provider: "codex",
            model: "gpt-5.6-sol",
            modeId: null,
            thinkingOptionId: "high",
            featureValues: {},
          },
        },
        state: { status: "pending" },
      },
    ],
    state: { status: "queued" },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function createRepository(
  overrides: Partial<AssignmentSessionRepository> = {},
): AssignmentSessionRepository {
  return {
    createAssignment: vi.fn(async () => createAssignment()),
    listAssignments: vi.fn(async () => ({ assignments: [createAssignment()], issues: [] })),
    getAssignment: vi.fn(async () => createAssignment()),
    patchAssignment: vi.fn(async () => createAssignment()),
    completeAssignment: vi.fn(async () => createAssignment()),
    cancelAssignment: vi.fn(async () => createAssignment()),
    getArtifact: vi.fn(async () => createArtifact()),
    listArtifacts: vi.fn(async () => ({
      artifacts: [createArtifact()],
      nextCursor: null,
      issues: [],
    })),
    ...overrides,
  };
}

function createHarness(options?: {
  repository?: AssignmentSessionRepository;
  runService?: AssignmentSessionRunService;
}) {
  const messages: SessionOutboundMessage[] = [];
  const repository = options?.repository ?? createRepository();
  const runService =
    options?.runService ??
    ({ startAssignmentRun: vi.fn(async () => createRun()) } satisfies AssignmentSessionRunService);
  const session = new AssignmentSession({
    repository,
    runService,
    emit: (message) => messages.push(message),
  });
  return { messages, repository, runService, session };
}

describe("AssignmentSession", () => {
  test("dispatches Assignment CRUD through repository DTO projections", async () => {
    const harness = createHarness();
    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "assignment.create.request",
        requestId: "request_create",
        assignment: {
          title: "Expose Assignment APIs",
          objective: "Publish the durable Assignment contract.",
          workItem: null,
        },
      }),
    );
    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "assignment.patch.request",
        requestId: "request_patch",
        assignmentId: "asgn_0123456789abcdef",
        expectedRevision: 2,
        patch: { title: "Expose stable Assignment APIs" },
      }),
    );
    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "assignment.complete.request",
        requestId: "request_complete",
        assignmentId: "asgn_0123456789abcdef",
        expectedRevision: 2,
      }),
    );

    expect(harness.repository.patchAssignment).toHaveBeenCalledWith({
      assignmentId: "asgn_0123456789abcdef",
      expectedRevision: 2,
      patch: { title: "Expose stable Assignment APIs" },
    });
    expect(harness.messages.map((message) => message.type)).toEqual([
      "assignment.create.response",
      "assignment.patch.response",
      "assignment.complete.response",
    ]);
  });

  test("lists and gets immutable Artifact projections", async () => {
    const harness = createHarness();
    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "assignment.artifact.get.request",
        requestId: "request_get",
        artifactId: "aart_0123456789abcdef",
      }),
    );
    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "assignment.artifact.list.request",
        requestId: "request_list",
        assignmentId: "asgn_0123456789abcdef",
        limit: 25,
      }),
    );

    expect(harness.repository.listArtifacts).toHaveBeenCalledWith({
      assignmentId: "asgn_0123456789abcdef",
      limit: 25,
    });
    expect(harness.messages).toMatchObject([
      { type: "assignment.artifact.get.response", payload: { artifact: { content: "Done" } } },
      {
        type: "assignment.artifact.list.response",
        payload: { artifacts: [{ id: "aart_0123456789abcdef" }], nextCursor: null },
      },
    ]);
  });

  test("starts Assignment-backed Team Runs through authoritative admission", async () => {
    const harness = createHarness();
    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "assignment.team_run.start.request",
        requestId: "request_start",
        teamId: "team_delivery",
        expectedRevision: 2,
        idempotencyKey: "assignment-run-1",
        assignmentId: "asgn_0123456789abcdef",
        expectedAssignmentRevision: 2,
        workspaceId: "workspace_delivery",
      }),
    );

    expect(harness.runService.startAssignmentRun).toHaveBeenCalledWith({
      teamId: "team_delivery",
      expectedRevision: 2,
      idempotencyKey: "assignment-run-1",
      assignmentId: "asgn_0123456789abcdef",
      expectedAssignmentRevision: 2,
      workspaceId: "workspace_delivery",
    });
    expect(harness.messages).toMatchObject([
      { type: "assignment.team_run.start.response", payload: { run: { id: createRun().id } } },
    ]);
  });

  test("maps lifecycle and corrupt-list failures to stable RPC errors", async () => {
    const invalidIssue: AssignmentRepositoryFileIssue = {
      collection: "records",
      fileName: "broken.json",
      kind: "invalid_record",
      message: "Invalid record",
    };
    const harness = createHarness({
      repository: createRepository({
        patchAssignment: vi.fn(async () => {
          throw new AssignmentRevisionConflictError("asgn_0123456789abcdef", 1, 2);
        }),
        listAssignments: vi.fn(async () => ({ assignments: [], issues: [invalidIssue] })),
      }),
    });

    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "assignment.patch.request",
        requestId: "request_patch",
        assignmentId: "asgn_0123456789abcdef",
        expectedRevision: 1,
        patch: { title: "Stale" },
      }),
    );
    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "assignment.list.request",
        requestId: "request_list",
      }),
    );

    expect(harness.messages).toMatchObject([
      { type: "rpc_error", payload: { code: "assignment_revision_conflict" } },
      { type: "rpc_error", payload: { code: "assignment_storage_corrupt" } },
    ]);
  });
});
