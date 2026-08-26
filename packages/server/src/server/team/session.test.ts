import { SessionInboundMessageSchema, type SessionOutboundMessage } from "../messages.js";
import { describe, expect, test, vi } from "vitest";

import {
  PersistedTeamDefinitionSchema,
  PersistedTeamRunRecordSchema,
  type PersistedTeamDefinition,
  type PersistedTeamRunRecord,
} from "./model.js";
import { TeamExecutionPreflightError } from "./execution.js";
import {
  TeamHasActiveRunError,
  TeamRevisionConflictError,
  TeamWorkspaceHasActiveRunError,
} from "./repository.js";
import { TeamSession, type TeamSessionRepository, type TeamSessionRunService } from "./session.js";

const timestamp = "2026-08-26T12:00:00.000Z";

function createDefinition(): PersistedTeamDefinition {
  return PersistedTeamDefinitionSchema.parse({
    id: "team_delivery",
    revision: 2,
    name: "Delivery Team",
    instructions: "Deliver and review the objective.",
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
}

function createRun(definition = createDefinition()): PersistedTeamRunRecord {
  return PersistedTeamRunRecordSchema.parse({
    id: "run_delivery",
    teamId: definition.id,
    teamRevision: definition.revision,
    idempotencyKey: "retry-safe-key",
    teamSnapshot: definition,
    objective: "Ship the Team RPC.",
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
            featureValues: { fast_mode: false },
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

function createRepository(overrides: Partial<TeamSessionRepository> = {}): TeamSessionRepository {
  return {
    createDefinition: vi.fn(async () => createDefinition()),
    listDefinitions: vi.fn(async () => ({ definitions: [createDefinition()], issues: [] })),
    getDefinition: vi.fn(async () => createDefinition()),
    updateDefinition: vi.fn(async () => createDefinition()),
    deleteDefinition: vi.fn(async () => undefined),
    listRuns: vi.fn(async () => ({ runs: [createRun()], nextCursor: null, issues: [] })),
    getRun: vi.fn(async () => createRun()),
    ...overrides,
  };
}

function createRunService(overrides: Partial<TeamSessionRunService> = {}): TeamSessionRunService {
  return {
    startRun: vi.fn(async () => createRun()),
    cancelRun: vi.fn(async () => createRun()),
    ...overrides,
  };
}

function createHarness(options?: {
  repository?: TeamSessionRepository;
  runService?: TeamSessionRunService;
}) {
  const messages: SessionOutboundMessage[] = [];
  const repository = options?.repository ?? createRepository();
  const runService = options?.runService ?? createRunService();
  const session = new TeamSession({
    repository,
    runService,
    emit: (message) => messages.push(message),
  });
  return { messages, repository, runService, session };
}

describe("TeamSession", () => {
  test("creates profile-backed definitions through the repository", async () => {
    const harness = createHarness();
    const message = SessionInboundMessageSchema.parse({
      type: "team.create.request",
      requestId: "request_create",
      definition: {
        name: "Delivery Team",
        instructions: "Deliver and review the objective.",
        roles: [
          {
            id: "builder",
            name: "Builder",
            instructions: "Implement the objective.",
            profileId: "codex-builder",
          },
        ],
        workflow: [{ id: "implement", roleId: "builder", instructions: null }],
      },
    });

    await harness.session.dispatch(message);

    expect(harness.repository.createDefinition).toHaveBeenCalledWith(message.definition);
    expect(harness.messages).toMatchObject([
      {
        type: "team.create.response",
        payload: { requestId: "request_create", team: { id: "team_delivery" } },
      },
    ]);
  });

  test("forwards the caller idempotency key and returns the frozen durable run", async () => {
    const harness = createHarness();
    const message = SessionInboundMessageSchema.parse({
      type: "team.run.start.request",
      requestId: "request_start",
      teamId: "team_delivery",
      expectedRevision: 2,
      idempotencyKey: "retry-safe-key",
      objective: "Ship the Team RPC.",
      workspaceId: "workspace_delivery",
    });

    await harness.session.dispatch(message);

    expect(harness.runService.startRun).toHaveBeenCalledWith({
      teamId: "team_delivery",
      expectedRevision: 2,
      idempotencyKey: "retry-safe-key",
      objective: "Ship the Team RPC.",
      workspaceId: "workspace_delivery",
    });
    expect(harness.messages).toMatchObject([
      {
        type: "team.run.start.response",
        payload: {
          requestId: "request_start",
          run: {
            id: "run_delivery",
            steps: [
              {
                snapshot: {
                  resolvedLaunch: {
                    profileId: "codex-builder",
                    provider: "codex",
                    model: "gpt-5.6-sol",
                  },
                },
              },
            ],
          },
        },
      },
    ]);
  });

  test.each([
    {
      issue: {
        kind: "profile_not_found" as const,
        roleId: "builder",
        profileId: "missing-profile",
        message: "Profile not found",
      },
      code: "team_profile_not_found",
    },
    {
      issue: {
        kind: "launch_unavailable" as const,
        roleId: "builder",
        profileId: "codex-builder",
        provider: "codex",
        model: "removed-model",
        message: "Model is unavailable",
      },
      code: "team_launch_unavailable",
    },
    {
      issue: {
        kind: "workspace_archived" as const,
        workspaceId: "workspace_delivery",
      },
      code: "team_workspace_unsupported",
    },
  ])("maps $code preflight failures to stable RPC errors", async ({ issue, code }) => {
    const runService = createRunService({
      startRun: vi.fn(async () => {
        throw new TeamExecutionPreflightError([issue]);
      }),
    });
    const harness = createHarness({ runService });

    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "team.run.start.request",
        requestId: "request_start",
        teamId: "team_delivery",
        expectedRevision: 2,
        idempotencyKey: "retry-safe-key",
        objective: "Ship the Team RPC.",
        workspaceId: "workspace_delivery",
      }),
    );

    expect(harness.messages).toMatchObject([
      {
        type: "rpc_error",
        payload: { requestId: "request_start", code },
      },
    ]);
  });

  test("preserves repository revision-conflict codes", async () => {
    const repository = createRepository({
      updateDefinition: vi.fn(async () => {
        throw new TeamRevisionConflictError("team_delivery", 1, 2);
      }),
    });
    const harness = createHarness({ repository });

    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "team.update.request",
        requestId: "request_update",
        teamId: "team_delivery",
        expectedRevision: 1,
        patch: { name: "New name" },
      }),
    );

    expect(harness.messages).toMatchObject([
      {
        type: "rpc_error",
        payload: { requestId: "request_update", code: "team_revision_conflict" },
      },
    ]);
  });

  test("reports Workspace ownership conflicts with a stable busy code", async () => {
    const runService = createRunService({
      startRun: vi.fn(async () => {
        throw new TeamWorkspaceHasActiveRunError("workspace_delivery", "run_existing");
      }),
    });
    const harness = createHarness({ runService });

    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "team.run.start.request",
        requestId: "request_start",
        teamId: "team_delivery",
        expectedRevision: 2,
        idempotencyKey: "retry-safe-key",
        objective: "Ship the Team RPC.",
        workspaceId: "workspace_delivery",
      }),
    );

    expect(harness.messages).toMatchObject([
      {
        type: "rpc_error",
        payload: { requestId: "request_start", code: "team_workspace_has_active_run" },
      },
    ]);
  });

  test("reports deletion blocked by an active run as a stable invalid state", async () => {
    const repository = createRepository({
      deleteDefinition: vi.fn(async () => {
        throw new TeamHasActiveRunError("team_delivery", "run_existing");
      }),
    });
    const harness = createHarness({ repository });

    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "team.delete.request",
        requestId: "request_delete",
        teamId: "team_delivery",
        expectedRevision: 2,
      }),
    );

    expect(harness.messages).toMatchObject([
      {
        type: "rpc_error",
        payload: { requestId: "request_delete", code: "team_has_active_run" },
      },
    ]);
  });

  test("passes bounded pagination through without rewriting the stable cursor", async () => {
    const listRuns = vi.fn(async () => ({
      runs: [createRun()],
      nextCursor: "opaque-stable-cursor",
      issues: [],
    }));
    const harness = createHarness({ repository: createRepository({ listRuns }) });

    await harness.session.dispatch(
      SessionInboundMessageSchema.parse({
        type: "team.run.list.request",
        requestId: "request_list",
        teamId: "team_delivery",
        cursor: "previous-cursor",
        limit: 25,
      }),
    );

    expect(listRuns).toHaveBeenCalledWith({
      teamId: "team_delivery",
      cursor: "previous-cursor",
      limit: 25,
    });
    expect(harness.messages).toMatchObject([
      {
        type: "team.run.list.response",
        payload: { requestId: "request_list", nextCursor: "opaque-stable-cursor" },
      },
    ]);
  });
});
