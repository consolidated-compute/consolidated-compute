import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { AgentRunCancellationResult } from "../agent/agent-manager.js";
import type {
  AgentFeature,
  AgentPromptInput,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import type { CreateAgentFromMcpInput } from "../agent/create-agent/create.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { AssignmentRepository } from "../assignment/repository.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceMutation,
  type WorkspaceTerminationBoundary,
} from "../workspace-registry.js";
import { TeamExecutionPreflightError, type TeamProviderCatalog } from "./execution.js";
import { materializeTeamStepArtifact } from "./artifacts.js";
import type { PersistedTeamDefinition, PersistedTeamRunRecord } from "./model.js";
import {
  TeamRepository,
  TeamWorkspaceHasActiveRunError,
  type CreateTeamDefinitionInput,
} from "./repository.js";
import {
  TeamSecurityPreviewStaleError,
  TeamRunService,
  TeamRunServiceShuttingDownError,
  type TeamRunWorkspaceRegistry,
} from "./service.js";
import { TeamSupervisorRoleInvalidError } from "./supervision.js";
import { toTeamRunDto } from "./wire.js";

const timestamp = "2026-08-25T12:00:00.000Z";
const firstAgentId = "00000000-0000-4000-8000-000000000401";
const secondAgentId = "00000000-0000-4000-8000-000000000402";
const unusedAgentId = "00000000-0000-4000-8000-000000000403";

function createDefinitionInput(): CreateTeamDefinitionInput {
  return {
    name: "Delivery Team",
    instructions: "Deliver the objective and review the result.",
    roles: [
      {
        id: "role_builder",
        name: "Builder",
        instructions: "Implement the requested change.",
        profileId: "profile_builder",
      },
      {
        id: "role_reviewer",
        name: "Reviewer",
        instructions: "Review the implementation.",
        profileId: "profile_reviewer",
      },
    ],
    workflow: [
      { id: "step_build", roleId: "role_builder", instructions: null },
      { id: "step_review", roleId: "role_reviewer", instructions: "Report defects only." },
    ],
  };
}

function createWorkspace(workspaceId = "wks_team_service"): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: "prj_team_service",
    cwd: `/repo/${workspaceId}`,
    kind: "worktree",
    displayName: "feature/teams",
    title: "Team workspace",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

class MemoryWorkspaceRegistry implements TeamRunWorkspaceRegistry {
  private readonly listeners = new Set<(mutation: WorkspaceMutation) => void | Promise<void>>();
  private readonly terminationBoundaryListeners = new Set<
    (boundary: WorkspaceTerminationBoundary) => void | Promise<void>
  >();
  readonly workspaces = new Map<string, PersistedWorkspaceRecord>();
  blockNextGet = false;
  blockMutationWrite = false;
  failMutationWrite = false;
  blockMutationPublication = false;
  private nextTerminationBoundaryId = 1;
  private releaseGet: (() => void) | null = null;
  private releaseMutationWrite: (() => void) | null = null;
  private releaseMutationPublication: (() => void) | null = null;
  private readonly mutationWriteWaiters = new Set<() => void>();
  private readonly mutationCommitWaiters = new Set<() => void>();
  private readonly getWaiters = new Set<() => void>();
  private readonly terminationBoundaryStartWaiters = new Set<() => void>();

  constructor(workspace: PersistedWorkspaceRecord) {
    this.workspaces.set(workspace.workspaceId, workspace);
  }

  async get(workspaceId: string): Promise<PersistedWorkspaceRecord | null> {
    const workspace = this.workspaces.get(workspaceId) ?? null;
    if (!this.blockNextGet) return workspace;
    this.blockNextGet = false;
    for (const waiter of this.getWaiters) waiter();
    this.getWaiters.clear();
    await new Promise<void>((resolve) => {
      this.releaseGet = resolve;
    });
    return workspace;
  }

  async waitForBlockedGet(): Promise<void> {
    await new Promise<void>((resolve) => this.getWaiters.add(resolve));
  }

  unblockGet(): void {
    this.releaseGet?.();
    this.releaseGet = null;
  }

  subscribeToMutations(
    listener: (mutation: WorkspaceMutation) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeToTerminationBoundaries(
    listener: (boundary: WorkspaceTerminationBoundary) => void | Promise<void>,
  ): () => void {
    this.terminationBoundaryListeners.add(listener);
    return () => this.terminationBoundaryListeners.delete(listener);
  }

  async archive(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    const boundaryId = `memory-workspace-termination-${this.nextTerminationBoundaryId++}`;
    await this.notifyTerminationBoundary({
      boundaryId,
      phase: "start",
      kind: "archive",
      workspaceId,
    });
    try {
      for (const waiter of this.mutationWriteWaiters) waiter();
      this.mutationWriteWaiters.clear();
      if (this.blockMutationWrite) {
        await new Promise<void>((resolve) => {
          this.releaseMutationWrite = resolve;
        });
      }
      if (this.failMutationWrite) throw new Error("Workspace archive write failed");
      const archived = { ...workspace, archivedAt: timestamp, updatedAt: timestamp };
      this.workspaces.set(workspaceId, archived);
      await this.notifyTerminationBoundary({
        boundaryId,
        phase: "commit",
        kind: "archive",
        workspaceId,
      });
      for (const waiter of this.mutationCommitWaiters) waiter();
      this.mutationCommitWaiters.clear();
      if (this.blockMutationPublication) {
        await new Promise<void>((resolve) => {
          this.releaseMutationPublication = resolve;
        });
      }
      const mutation: WorkspaceMutation = {
        kind: "archive",
        workspaceId,
        workspace: archived,
      };
      await Promise.all([...this.listeners].map((listener) => listener(mutation)));
    } finally {
      await this.notifyTerminationBoundary({
        boundaryId,
        phase: "finish",
        kind: "archive",
        workspaceId,
      });
    }
  }

  async waitForMutationWrite(): Promise<void> {
    await new Promise<void>((resolve) => this.mutationWriteWaiters.add(resolve));
  }

  unblockMutationWrite(): void {
    this.blockMutationWrite = false;
    this.releaseMutationWrite?.();
    this.releaseMutationWrite = null;
  }

  async waitForMutationCommit(): Promise<void> {
    await new Promise<void>((resolve) => this.mutationCommitWaiters.add(resolve));
  }

  unblockMutationPublication(): void {
    this.blockMutationPublication = false;
    this.releaseMutationPublication?.();
    this.releaseMutationPublication = null;
  }

  async waitForTerminationBoundaryStart(): Promise<void> {
    await new Promise<void>((resolve) => this.terminationBoundaryStartWaiters.add(resolve));
  }

  private async notifyTerminationBoundary(boundary: WorkspaceTerminationBoundary): Promise<void> {
    const notifications = [...this.terminationBoundaryListeners].map((listener) =>
      listener(boundary),
    );
    if (boundary.phase === "start") {
      for (const waiter of this.terminationBoundaryStartWaiters) waiter();
      this.terminationBoundaryStartWaiters.clear();
    }
    await Promise.all(notifications);
  }
}

class MemoryProviderCatalog implements TeamProviderCatalog {
  models = [{ provider: "codex", id: "gpt-5.6", label: "GPT-5.6" }];
  nativeDelegationStatus: "enforced" | "unavailable" = "enforced";
  blockRefresh = false;
  private releaseRefresh: (() => void) | null = null;
  private readonly refreshWaiters = new Set<() => void>();

  async refreshSnapshotForCwd(): Promise<void> {
    for (const waiter of this.refreshWaiters) waiter();
    this.refreshWaiters.clear();
    if (!this.blockRefresh) return;
    await new Promise<void>((resolve) => {
      this.releaseRefresh = resolve;
    });
  }

  async waitForRefresh(): Promise<void> {
    await new Promise<void>((resolve) => this.refreshWaiters.add(resolve));
  }

  unblockRefresh(): void {
    this.blockRefresh = false;
    this.releaseRefresh?.();
    this.releaseRefresh = null;
  }

  async listModels() {
    return this.models;
  }

  async resolveCreateConfig(input: Parameters<TeamProviderCatalog["resolveCreateConfig"]>[0]) {
    return { modeId: input.requestedMode, featureValues: input.featureValues };
  }

  async validateAndNormalizeAgentConfiguration(input: {
    providerOptions?: AgentSessionConfig["providerOptions"];
  }) {
    return { issues: [], providerOptions: input.providerOptions };
  }

  projectSecurityPosture(input: { provider: string }) {
    return {
      source: { provider: input.provider },
      filesystemWrite: { status: "enforced" as const, summary: "Filesystem policy enforced." },
      networkAccess: { status: "unavailable" as const, summary: "Network proof unavailable." },
      toolShell: { status: "policy_only" as const, summary: "Tool policy configured." },
      nativeDelegation: {
        status: this.nativeDelegationStatus,
        summary:
          this.nativeDelegationStatus === "enforced"
            ? "Provider-native delegation is disabled."
            : "Provider-native delegation was not disabled.",
      },
    };
  }
}

class MemoryDaemonConfigStore {
  agentProfiles: AgentProfile[] = [
    {
      id: "profile_builder",
      name: "Builder",
      provider: "codex",
      model: "gpt-5.6",
    },
    {
      id: "profile_reviewer",
      name: "Reviewer",
      provider: "codex",
      model: "gpt-5.6",
    },
  ];

  get() {
    return { agentProfiles: this.agentProfiles };
  }
}

interface QueuedEvent {
  event: AgentStreamEvent | null;
  resolveConsumed: () => void;
}

class MemoryAgentRuntime {
  readonly creations: CreateAgentFromMcpInput[] = [];
  readonly cancellations: string[] = [];
  readonly streams: Array<{ agentId: string; prompt: AgentPromptInput }> = [];
  readonly finalResponses = new Map<string, string | null>();
  cancellation: AgentRunCancellationResult = { status: "settled" };
  blockCreation = false;
  private releaseCreation: (() => void) | null = null;
  private readonly creationWaiters = new Set<() => void>();
  private readonly streamWaiters = new Map<string, Set<() => void>>();
  private readonly eventQueues = new Map<string, QueuedEvent[]>();
  private readonly eventWaiters = new Map<string, Set<() => void>>();

  async createAgent(input: CreateAgentFromMcpInput): Promise<void> {
    this.creations.push(input);
    for (const waiter of this.creationWaiters) waiter();
    this.creationWaiters.clear();
    if (!this.blockCreation) return;
    await new Promise<void>((resolve) => {
      this.releaseCreation = resolve;
    });
  }

  unblockCreation(): void {
    this.blockCreation = false;
    this.releaseCreation?.();
    this.releaseCreation = null;
  }

  async waitForCreations(count: number): Promise<void> {
    if (this.creations.length >= count) return;
    await new Promise<void>((resolve) => this.creationWaiters.add(resolve));
    if (this.creations.length < count) await this.waitForCreations(count);
  }

  async *streamAgent(agentId: string, prompt: AgentPromptInput): AsyncGenerator<AgentStreamEvent> {
    this.streams.push({ agentId, prompt });
    for (const waiter of this.streamWaiters.get(agentId) ?? []) waiter();
    this.streamWaiters.delete(agentId);
    for (;;) {
      const queued = await this.nextEvent(agentId);
      queued.resolveConsumed();
      if (queued.event === null) return;
      yield queued.event;
    }
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    return this.finalResponses.get(agentId) ?? null;
  }

  async listDraftFeatures(_config: AgentSessionConfig): Promise<AgentFeature[]> {
    return [];
  }

  async cancelAgentRun(agentId: string): Promise<AgentRunCancellationResult> {
    this.cancellations.push(agentId);
    if (this.cancellation.status === "settled") {
      void this.pushEvent(agentId, {
        type: "turn_canceled",
        provider: "codex",
        reason: "interrupted",
      });
    }
    return this.cancellation;
  }

  async waitForStream(agentId: string): Promise<void> {
    if (this.streams.some((stream) => stream.agentId === agentId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.streamWaiters.get(agentId) ?? new Set();
      waiters.add(resolve);
      this.streamWaiters.set(agentId, waiters);
    });
  }

  async pushEvent(agentId: string, event: AgentStreamEvent): Promise<void> {
    await new Promise<void>((resolveConsumed) => {
      const queue = this.eventQueues.get(agentId) ?? [];
      queue.push({ event, resolveConsumed });
      this.eventQueues.set(agentId, queue);
      for (const waiter of this.eventWaiters.get(agentId) ?? []) waiter();
      this.eventWaiters.delete(agentId);
    });
  }

  private async nextEvent(agentId: string): Promise<QueuedEvent> {
    const queue = this.eventQueues.get(agentId);
    const queued = queue?.shift();
    if (queued) return queued;
    await new Promise<void>((resolve) => {
      const waiters = this.eventWaiters.get(agentId) ?? new Set();
      waiters.add(resolve);
      this.eventWaiters.set(agentId, waiters);
    });
    return this.nextEvent(agentId);
  }
}

interface Harness {
  repository: TeamRepository;
  assignments: AssignmentRepository;
  definition: PersistedTeamDefinition;
  workspaceRegistry: MemoryWorkspaceRegistry;
  providerCatalog: MemoryProviderCatalog;
  daemonConfigStore: MemoryDaemonConfigStore;
  runtime: MemoryAgentRuntime;
  service: TeamRunService;
}

describe("TeamRunService", () => {
  let paseoHome: string;
  const services: TeamRunService[] = [];

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "team-run-service-test-"));
  });

  afterEach(async () => {
    for (const service of services) await service.shutdown();
    services.length = 0;
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function createHarness(options?: {
    workspace?: PersistedWorkspaceRecord;
    repository?: TeamRepository;
    assignmentRepository?: AssignmentRepository;
    supervisedControlPlaneProtected?: boolean;
    initialize?: boolean;
  }): Promise<Harness> {
    const repository =
      options?.repository ?? new TeamRepository({ paseoHome, now: () => new Date(timestamp) });
    const definitions = await repository.listDefinitions();
    const definition =
      definitions.definitions[0] ?? (await repository.createDefinition(createDefinitionInput()));
    const assignments =
      options?.assignmentRepository ??
      new AssignmentRepository({
        paseoHome,
        now: () => new Date(timestamp),
        activeRunStore: repository,
      });
    const workspaceRegistry = new MemoryWorkspaceRegistry(options?.workspace ?? createWorkspace());
    const providerCatalog = new MemoryProviderCatalog();
    const daemonConfigStore = new MemoryDaemonConfigStore();
    const runtime = new MemoryAgentRuntime();
    const ids = [firstAgentId, secondAgentId, unusedAgentId];
    const service = new TeamRunService({
      repository,
      assignmentRepository: assignments,
      supervisedControlPlaneProtected: options?.supervisedControlPlaneProtected ?? true,
      workspaceRegistry,
      providerCatalog,
      daemonConfigStore,
      createAgent: (input) => runtime.createAgent(input),
      agentManager: runtime,
      cancelAgentRun: (agentId) => runtime.cancelAgentRun(agentId),
      logger: createTestLogger(),
      now: () => new Date(timestamp),
      createAgentId: () => {
        const id = ids.shift();
        if (!id) throw new Error("Test exhausted planned agent IDs");
        return id;
      },
    });
    services.push(service);
    if (options?.initialize !== false) await service.initialize();
    return {
      repository,
      assignments,
      definition,
      workspaceRegistry,
      providerCatalog,
      daemonConfigStore,
      runtime,
      service,
    };
  }

  async function startRun(harness: Harness, idempotencyKey = "start-1") {
    return harness.service.startRun({
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      idempotencyKey,
      objective: "Ship the sequential Team Run coordinator.",
      workspaceId: "wks_team_service",
    });
  }

  test("accepts Assignment repositories only from its configured persistence boundary", async () => {
    const harness = await createHarness();
    const peer = new AssignmentRepository({
      paseoHome,
      activeRunStore: harness.repository,
    });
    expect(harness.service.supportsAssignmentRepository(harness.assignments)).toBe(true);
    expect(harness.service.supportsAssignmentRepository(peer)).toBe(true);

    const otherPaseoHome = await mkdtemp(join(tmpdir(), "team-run-service-other-boundary-"));
    try {
      const otherTeamRepository = new TeamRepository({ paseoHome: otherPaseoHome });
      const otherAssignmentRepository = new AssignmentRepository({
        paseoHome: otherPaseoHome,
        activeRunStore: otherTeamRepository,
      });
      expect(harness.service.supportsAssignmentRepository(otherAssignmentRepository)).toBe(false);
    } finally {
      await rm(otherPaseoHome, { recursive: true, force: true });
    }
  });

  async function startAssignmentRun(
    harness: Harness,
    assignment: { id: string; revision: number },
    idempotencyKey = "assignment-start-1",
  ) {
    return harness.service.startAssignmentRun({
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      idempotencyKey,
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
    });
  }

  test("admits a dark supervised snapshot without launching the sequential executor", async () => {
    const harness = await createHarness();
    harness.daemonConfigStore.agentProfiles.push({
      id: "profile_supervisor",
      name: "Supervisor",
      provider: "codex",
      model: "gpt-5.6",
      modeId: "workspace-write",
      providerOptions: {
        sandbox_mode: "workspace-write",
        approval_policy: "never",
        features: { multi_agent_v2: false },
      },
    });
    const definition = await harness.repository.updateDefinition({
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      patch: {
        roles: [
          ...harness.definition.roles,
          {
            id: "role_supervisor",
            name: "Supervisor",
            instructions: "Coordinate bounded work and escalate exceptions.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Supervised service admission",
      objective: "Freeze all launch facts before execution exists.",
      workItem: null,
    });
    const input = {
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "supervised-start-1",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
      supervisorRoleId: "role_supervisor",
    };

    const run = await harness.service.admitSupervisedAssignmentRun(input);

    expect(run).toMatchObject({
      steps: [],
      state: { status: "queued" },
      supervision: {
        revision: 1,
        phase: "queued",
        supervisor: {
          roleId: "role_supervisor",
          agentId: firstAgentId,
          resolvedLaunch: {
            profileId: "profile_supervisor",
            providerOptions: {
              sandbox_mode: "workspace-write",
              approval_policy: "never",
              features: { multi_agent_v2: false },
            },
          },
        },
      },
    });
    expect(harness.runtime.creations).toEqual([]);
    expect(toTeamRunDto(run).supervision).toEqual({
      status: "queued",
      supervisorRoleId: "role_supervisor",
      supervisorAgentId: firstAgentId,
      completedWorkItems: 0,
      totalWorkItems: 0,
      updatedAt: timestamp,
    });
    expect(JSON.stringify(toTeamRunDto(run))).not.toContain("sandbox_mode");
    await expect(harness.service.admitSupervisedAssignmentRun(input)).resolves.toEqual(run);
    await expect(
      harness.service.admitSupervisedAssignmentRun({
        ...input,
        supervisorRoleId: "role_builder",
      }),
    ).rejects.toMatchObject({ code: "team_run_idempotency_conflict" });

    const secondAssignment = await harness.assignments.createAssignment({
      title: "Invalid supervisor role",
      objective: "Do not let a worker role become the supervisor.",
      workItem: null,
    });
    await expect(
      harness.service.admitSupervisedAssignmentRun({
        ...input,
        idempotencyKey: "supervised-start-2",
        assignmentId: secondAssignment.id,
        expectedAssignmentRevision: secondAssignment.revision,
        supervisorRoleId: "role_builder",
      }),
    ).rejects.toBeInstanceOf(TeamSupervisorRoleInvalidError);
  });

  test("rejects supervised admission on a passwordless control plane", async () => {
    const harness = await createHarness({ supervisedControlPlaneProtected: false });
    harness.daemonConfigStore.agentProfiles.push({
      id: "profile_supervisor",
      name: "Supervisor",
      provider: "codex",
      model: "gpt-5.6",
      providerOptions: { features: { multi_agent_v2: false } },
    });
    const definition = await harness.repository.updateDefinition({
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      patch: {
        roles: [
          ...harness.definition.roles,
          {
            id: "role_supervisor",
            name: "Supervisor",
            instructions: "Coordinate bounded work.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Protected supervised admission",
      objective: "Reject admission before a restricted agent can launch.",
      workItem: null,
    });

    await expect(
      harness.service.admitSupervisedAssignmentRun({
        teamId: definition.id,
        expectedRevision: definition.revision,
        idempotencyKey: "passwordless-supervised-start",
        assignmentId: assignment.id,
        expectedAssignmentRevision: assignment.revision,
        workspaceId: "wks_team_service",
        supervisorRoleId: "role_supervisor",
      }),
    ).rejects.toMatchObject({ code: "team_supervised_run_authentication_required" });
    expect(harness.runtime.creations).toEqual([]);
    await expect(harness.repository.listRuns()).resolves.toMatchObject({ runs: [] });
  });

  test("rejects supervised admission when provider-native delegation is not disabled", async () => {
    const harness = await createHarness();
    harness.providerCatalog.nativeDelegationStatus = "unavailable";
    harness.daemonConfigStore.agentProfiles.push({
      id: "profile_supervisor",
      name: "Supervisor",
      provider: "codex",
      model: "gpt-5.6",
      providerOptions: { features: { multi_agent_v2: false } },
    });
    const definition = await harness.repository.updateDefinition({
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      patch: {
        roles: [
          ...harness.definition.roles,
          {
            id: "role_supervisor",
            name: "Supervisor",
            instructions: "Coordinate bounded work.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Unsafe delegation posture",
      objective: "Reject the run before any agent exists.",
      workItem: null,
    });

    await expect(
      harness.service.admitSupervisedAssignmentRun({
        teamId: definition.id,
        expectedRevision: definition.revision,
        idempotencyKey: "supervised-native-delegation-unavailable",
        assignmentId: assignment.id,
        expectedAssignmentRevision: assignment.revision,
        workspaceId: "wks_team_service",
        supervisorRoleId: "role_supervisor",
      }),
    ).rejects.toMatchObject({
      code: "team_native_delegation_unenforced",
      roleId: "role_supervisor",
      provider: "codex",
    });
    expect(harness.runtime.creations).toEqual([]);
  });

  test("previews every role without exposing provider options and rejects stale admission", async () => {
    const harness = await createHarness();
    harness.daemonConfigStore.agentProfiles.push({
      id: "profile_observer",
      name: "Observer",
      provider: "codex",
      model: "gpt-5.6",
    });
    harness.daemonConfigStore.agentProfiles[0] = {
      ...harness.daemonConfigStore.agentProfiles[0]!,
      providerOptions: {
        sandbox_mode: "workspace-write",
        approval_policy: "never",
        sensitive_path_sentinel: "/private/preview-must-not-leak",
      },
    };
    const definition = await harness.repository.updateDefinition({
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      patch: {
        roles: [
          ...harness.definition.roles,
          {
            id: "role_observer",
            name: "Observer",
            instructions: "Observe without joining the workflow.",
            profileId: "profile_observer",
          },
        ],
      },
    });

    const preview = await harness.service.previewRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      workspaceId: "wks_team_service",
    });
    expect(preview.roles.map((role) => role.roleId)).toEqual([
      "role_builder",
      "role_reviewer",
      "role_observer",
    ]);
    expect(JSON.stringify(preview)).not.toContain("preview-must-not-leak");
    expect(preview.roles[0]?.resolvedLaunch).not.toHaveProperty("providerOptions");

    harness.daemonConfigStore.agentProfiles[0] = {
      ...harness.daemonConfigStore.agentProfiles[0]!,
      providerOptions: {
        sensitive_path_sentinel: "/private/preview-must-not-leak",
        approval_policy: "never",
        sandbox_mode: "workspace-write",
      },
    };
    const reorderedPreview = await harness.service.previewRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      workspaceId: "wks_team_service",
    });
    expect(reorderedPreview.fingerprint).toBe(preview.fingerprint);

    harness.daemonConfigStore.agentProfiles[0] = {
      ...harness.daemonConfigStore.agentProfiles[0]!,
      providerOptions: {
        sandbox_mode: "read-only",
        approval_policy: "never",
        sensitive_path_sentinel: "/private/changed-preview-must-not-leak",
      },
    };
    const admission = harness.service.startRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "stale-preview",
      objective: "Reject stale security controls.",
      workspaceId: "wks_team_service",
      expectedPreviewFingerprint: preview.fingerprint,
    });
    await expect(admission).rejects.toBeInstanceOf(TeamSecurityPreviewStaleError);
    await expect(admission).rejects.not.toThrow(/changed-preview-must-not-leak/u);
    await expect(harness.repository.listRuns()).resolves.toMatchObject({ runs: [] });
  });

  test("returns an idempotent accepted run before checking a later preview fingerprint", async () => {
    const harness = await createHarness();
    const preview = await harness.service.previewRun({
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      workspaceId: "wks_team_service",
    });
    const input = {
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      idempotencyKey: "preview-idempotency",
      objective: "Keep retry identity stable.",
      workspaceId: "wks_team_service",
      expectedPreviewFingerprint: preview.fingerprint,
    };
    const accepted = await harness.service.startRun(input);
    harness.daemonConfigStore.agentProfiles[0] = {
      ...harness.daemonConfigStore.agentProfiles[0]!,
      providerOptions: { sandbox_mode: "read-only" },
    };

    await expect(
      harness.service.startRun({ ...input, expectedPreviewFingerprint: "f".repeat(64) }),
    ).resolves.toEqual(accepted);
  });

  test("returns a concurrently admitted idempotent run before checking a stale retry", async () => {
    const harness = await createHarness();
    const preview = await harness.service.previewRun({
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      workspaceId: "wks_team_service",
    });
    const input = {
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      idempotencyKey: "concurrent-preview-idempotency",
      objective: "Keep a concurrent retry idempotent.",
      workspaceId: "wks_team_service",
      expectedPreviewFingerprint: preview.fingerprint,
    };
    const createRun = harness.repository.createRun.bind(harness.repository);
    let signalCreateRunReached!: () => void;
    const createRunReached = new Promise<void>((resolve) => {
      signalCreateRunReached = resolve;
    });
    let releaseCreateRun!: () => void;
    const createRunReleased = new Promise<void>((resolve) => {
      releaseCreateRun = resolve;
    });
    harness.repository.createRun = async (createInput) => {
      signalCreateRunReached();
      await createRunReleased;
      return createRun(createInput);
    };

    const admission = harness.service.startRun(input);
    await createRunReached;
    harness.daemonConfigStore.agentProfiles[0] = {
      ...harness.daemonConfigStore.agentProfiles[0]!,
      providerOptions: { sandbox_mode: "read-only" },
    };
    const retry = harness.service.startRun(input);
    releaseCreateRun();

    const [accepted, retried] = await Promise.all([admission, retry]);
    expect(retried).toEqual(accepted);
    await expect(harness.repository.listRuns()).resolves.toMatchObject({
      runs: [{ id: accepted.id }],
    });
  });

  test("rejects stale previews before Assignment-backed run persistence", async () => {
    const harness = await createHarness();
    const assignment = await harness.assignments.createAssignment({
      title: "Previewed Assignment admission",
      objective: "Keep Assignment security controls stable.",
      workItem: null,
    });
    const preview = await harness.service.previewRun({
      teamId: harness.definition.id,
      expectedRevision: harness.definition.revision,
      workspaceId: "wks_team_service",
    });
    harness.daemonConfigStore.agentProfiles[0] = {
      ...harness.daemonConfigStore.agentProfiles[0]!,
      providerOptions: { sandbox_mode: "read-only" },
    };

    await expect(
      harness.service.startAssignmentRun({
        teamId: harness.definition.id,
        expectedRevision: harness.definition.revision,
        idempotencyKey: "stale-assignment-preview",
        assignmentId: assignment.id,
        expectedAssignmentRevision: assignment.revision,
        workspaceId: "wks_team_service",
        expectedPreviewFingerprint: preview.fingerprint,
      }),
    ).rejects.toBeInstanceOf(TeamSecurityPreviewStaleError);
    await expect(harness.repository.listRuns()).resolves.toMatchObject({ runs: [] });
  });

  test("admits Assignment intent and launches only after its frozen run is durable", async () => {
    const harness = await createHarness();
    const assignment = await harness.assignments.createAssignment({
      title: "Service admission",
      objective: "Run the Team from durable Assignment intent.",
      workItem: null,
    });

    const run = await startAssignmentRun(harness, assignment);
    await harness.runtime.waitForCreations(1);

    expect(run).toMatchObject({
      objective: assignment.objective,
      assignmentId: assignment.id,
      assignmentRevision: assignment.revision,
      assignmentSnapshot: assignment,
    });
    expect(run.steps[0]!.snapshot.inputArtifactIds).toEqual([]);
    expect(run.steps[1]!.snapshot.inputArtifactIds).toEqual([
      run.steps[0]!.snapshot.outputArtifact!.id,
    ]);

    await harness.assignments.patchAssignment({
      assignmentId: assignment.id,
      expectedRevision: assignment.revision,
      patch: { objective: "Changed after admission." },
    });
    await expect(harness.repository.getRun(run.id)).resolves.toMatchObject({
      objective: assignment.objective,
      assignmentRevision: assignment.revision,
      assignmentSnapshot: assignment,
    });

    harness.runtime.finalResponses.set(firstAgentId, "Builder produced the durable result.");
    await harness.runtime.waitForStream(firstAgentId);
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-builder",
    });
    await harness.runtime.waitForStream(secondAgentId);

    const builderArtifact = await harness.assignments.getArtifact(
      run.steps[0]!.snapshot.outputArtifact!.id,
    );
    expect(builderArtifact).toMatchObject({
      content: "Builder produced the durable result.",
      producer: {
        teamRunId: run.id,
        stepId: "step_build",
        roleId: "role_builder",
        agentId: firstAgentId,
        turnId: "turn-builder",
      },
    });
    expect(harness.runtime.streams[1]?.prompt).toContain("## Input Artifacts");
    expect(harness.runtime.streams[1]?.prompt).toContain(builderArtifact!.id);
    expect(harness.runtime.streams[1]?.prompt).toContain(builderArtifact!.content);
    expect(harness.runtime.streams[1]?.prompt).toContain(assignment.objective);
    expect(harness.runtime.streams[1]?.prompt).not.toContain("Changed after admission.");
    expect(harness.runtime.streams[1]?.prompt).not.toContain("Previous step final response");

    harness.runtime.finalResponses.set(secondAgentId, "Review passed.");
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-reviewer",
    });
    const completed = await harness.service.waitForRun(run.id);
    expect(completed.state.status).toBe("succeeded");
    await expect(
      harness.assignments.listArtifacts({ assignmentId: assignment.id }),
    ).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ id: run.steps[0]!.snapshot.outputArtifact!.id }),
        expect.objectContaining({ id: run.steps[1]!.snapshot.outputArtifact!.id }),
      ]),
      issues: [],
    });
    await expect(harness.assignments.getAssignment(assignment.id)).resolves.toMatchObject({
      revision: 2,
      state: { status: "open" },
    });
  });

  test("fails an Assignment-backed step before advancement when required output is blank", async () => {
    const harness = await createHarness();
    const assignment = await harness.assignments.createAssignment({
      title: "Blank output",
      objective: "Do not create a misleading empty Artifact.",
      workItem: null,
    });
    const run = await startAssignmentRun(harness, assignment);
    harness.runtime.finalResponses.set(firstAgentId, "  \n\t");

    await harness.runtime.waitForStream(firstAgentId);
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-blank",
    });
    const failed = await harness.service.waitForRun(run.id);

    expect(failed.state.status).toBe("failed");
    expect(failed.steps[0]!.state.status).toBe("failed");
    expect(harness.runtime.creations).toHaveLength(1);
    await expect(
      harness.assignments.listArtifacts({ assignmentId: assignment.id }),
    ).resolves.toMatchObject({ artifacts: [], issues: [] });
  });

  test("retains an ambiguously persisted Artifact without advancing or creating a consumer", async () => {
    const repository = new TeamRepository({ paseoHome, now: () => new Date(timestamp) });
    let failAfterArtifactPersistence = false;
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(timestamp),
      activeRunStore: repository,
      writeJson: async (filePath, value) => {
        await writeJsonFileAtomic(filePath, value);
        if (
          failAfterArtifactPersistence &&
          filePath.includes(`${join("assignments", "artifacts")}`)
        ) {
          throw new Error("simulated ambiguous Artifact persistence");
        }
      },
    });
    const harness = await createHarness({ repository, assignmentRepository: assignments });
    const assignment = await assignments.createAssignment({
      title: "Ambiguous persistence",
      objective: "Retain durable output without replaying uncertain advancement.",
      workItem: null,
    });
    const run = await startAssignmentRun(harness, assignment);
    harness.runtime.finalResponses.set(firstAgentId, "Persisted before the error.");
    failAfterArtifactPersistence = true;

    await harness.runtime.waitForStream(firstAgentId);
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-ambiguous",
    });
    const failed = await harness.service.waitForRun(run.id);

    expect(failed.state.status).toBe("failed");
    expect(failed.steps[1]!.state.status).toBe("pending");
    expect(harness.runtime.creations).toHaveLength(1);
    await expect(
      assignments.getArtifact(run.steps[0]!.snapshot.outputArtifact!.id),
    ).resolves.toMatchObject({ content: "Persisted before the error." });
  });

  test("does not advance or create a consumer when Artifact persistence fails", async () => {
    const repository = new TeamRepository({ paseoHome, now: () => new Date(timestamp) });
    let failArtifactWrites = false;
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(timestamp),
      activeRunStore: repository,
      writeJson: async (filePath, value) => {
        if (failArtifactWrites && filePath.includes(join("assignments", "artifacts"))) {
          throw new Error("simulated Artifact persistence failure");
        }
        await writeJsonFileAtomic(filePath, value);
      },
    });
    const harness = await createHarness({ repository, assignmentRepository: assignments });
    const assignment = await assignments.createAssignment({
      title: "Failed persistence",
      objective: "Do not advance without durable output.",
      workItem: null,
    });
    const run = await startAssignmentRun(harness, assignment);
    harness.runtime.finalResponses.set(firstAgentId, "This write will fail.");
    failArtifactWrites = true;

    await harness.runtime.waitForStream(firstAgentId);
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-write-failed",
    });
    const failed = await harness.service.waitForRun(run.id);

    expect(failed.state.status).toBe("failed");
    expect(failed.steps[1]!.state.status).toBe("pending");
    expect(harness.runtime.creations).toHaveLength(1);
    await expect(
      assignments.getArtifact(run.steps[0]!.snapshot.outputArtifact!.id),
    ).resolves.toBeNull();
  });

  test("runs reached steps in order and hands only the previous final response forward", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    harness.runtime.finalResponses.set(firstAgentId, "Builder finished.");
    harness.runtime.finalResponses.set(secondAgentId, "Review passed.");

    await harness.runtime.waitForStream(firstAgentId);
    await harness.repository.updateDefinition({
      teamId: harness.definition.id,
      expectedRevision: 1,
      patch: { name: "Edited after acceptance" },
    });
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    await harness.runtime.waitForStream(secondAgentId);
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
      usage: { inputTokens: 6, outputTokens: 2 },
    });

    const completed = await harness.service.waitForRun(run.id);

    expect(completed.state.status).toBe("succeeded");
    expect(completed.teamSnapshot.name).toBe("Delivery Team");
    expect(completed.steps.map((step) => step.state)).toMatchObject([
      { status: "succeeded", plannedAgentId: firstAgentId, agentId: firstAgentId },
      { status: "succeeded", plannedAgentId: secondAgentId, agentId: secondAgentId },
    ]);
    expect(harness.runtime.creations.map((creation) => creation.agentId)).toEqual([
      firstAgentId,
      secondAgentId,
    ]);
    expect(harness.runtime.streams[0]?.prompt).not.toContain("Previous step final response");
    expect(harness.runtime.streams[1]?.prompt).toContain("Builder finished.");
    expect(harness.runtime.streams[1]?.prompt).not.toContain("Review passed.");
  });

  test("rejects admission when the Workspace archives after the preflight read", async () => {
    const harness = await createHarness();
    harness.providerCatalog.blockRefresh = true;
    const refreshStarted = harness.providerCatalog.waitForRefresh();
    const starting = startRun(harness, "archive-during-admission").catch((error) => error);
    await refreshStarted;

    harness.workspaceRegistry.blockNextGet = true;
    const staleReadStarted = harness.workspaceRegistry.waitForBlockedGet();
    harness.providerCatalog.unblockRefresh();
    await staleReadStarted;
    await harness.workspaceRegistry.archive("wks_team_service");
    harness.workspaceRegistry.unblockGet();

    const error = await starting;
    expect(error).toBeInstanceOf(TeamExecutionPreflightError);
    expect((error as TeamExecutionPreflightError).issues).toEqual([
      { kind: "workspace_archived", workspaceId: "wks_team_service" },
    ]);
    expect(await harness.repository.listActiveRuns()).toEqual([]);
    expect(harness.runtime.creations).toEqual([]);
  });

  test("persists permission wait and resume without launching the later role", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);
    const waiting = waitForRunState(
      harness.repository,
      run.id,
      (current) => current.state.status === "waiting_for_permission",
    );

    await harness.runtime.pushEvent(firstAgentId, {
      type: "permission_requested",
      provider: "codex",
      request: { id: "permission-1", provider: "codex", name: "write_file", kind: "tool" },
    });

    expect((await waiting).steps[0]?.state.status).toBe("waiting_for_permission");
    expect(harness.runtime.creations).toHaveLength(1);
    const resumed = waitForRunState(
      harness.repository,
      run.id,
      (current) => current.state.status === "running",
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "permission_resolved",
      provider: "codex",
      requestId: "permission-1",
      resolution: { behavior: "allow" },
    });

    expect((await resumed).steps[0]?.state.status).toBe("running");
    harness.runtime.finalResponses.set(firstAgentId, "done");
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_failed",
      provider: "codex",
      error: "stop after permission coverage",
    });
    await expect(harness.service.waitForRun(run.id)).resolves.toMatchObject({
      state: { status: "failed" },
    });
  });

  test("fails before creating a later role when its provider model disappears", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);
    harness.providerCatalog.models = [];
    harness.runtime.finalResponses.set(firstAgentId, "first complete");

    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
    });

    const failed = await harness.service.waitForRun(run.id);
    expect(failed.state).toMatchObject({
      status: "failed",
      error: expect.stringContaining("gpt-5.6"),
    });
    expect(failed.steps).toMatchObject([
      { state: { status: "succeeded", agentId: firstAgentId } },
      { state: { status: "failed", plannedAgentId: secondAgentId, agentId: null } },
    ]);
    expect(harness.runtime.creations).toHaveLength(1);
  });

  test("records cancellation refusal, retains the lock, and permits an idempotent retry", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);
    harness.runtime.cancellation = { status: "refused" };

    const refused = await harness.service.cancelRun(run.id);

    expect(refused.state).toMatchObject({ status: "stop_failed" });
    await expect(
      harness.service.startRun({
        teamId: harness.definition.id,
        expectedRevision: 1,
        idempotencyKey: "start-2",
        objective: "Compete for the locked Workspace.",
        workspaceId: "wks_team_service",
      }),
    ).rejects.toBeInstanceOf(TeamWorkspaceHasActiveRunError);

    harness.runtime.cancellation = { status: "settled" };
    const canceled = await harness.service.cancelRun(run.id);

    expect(canceled.state.status).toBe("canceled");
    expect(canceled.steps[1]?.state.status).toBe("pending");
    expect(harness.runtime.creations).toHaveLength(1);
    await expect(harness.service.cancelRun(run.id)).resolves.toEqual(canceled);
  });

  test("cancels before prompt admission when creation is still in flight", async () => {
    const harness = await createHarness();
    harness.runtime.blockCreation = true;
    const run = await startRun(harness);
    await harness.runtime.waitForCreations(1);

    const creating = await harness.repository.getRun(run.id);
    expect(creating?.steps[0]?.state).toEqual({
      status: "creating",
      plannedAgentId: firstAgentId,
      startedAt: timestamp,
    });
    const canceling = harness.service.cancelRun(run.id);
    expect((await harness.repository.getRun(run.id))?.steps[0]?.state).toEqual(
      creating?.steps[0]?.state,
    );
    harness.runtime.unblockCreation();

    const canceled = await canceling;
    expect(canceled.state.status).toBe("canceled");
    expect(harness.runtime.streams).toEqual([]);
    expect(harness.runtime.creations).toHaveLength(1);
    expect(harness.runtime.cancellations).toEqual([firstAgentId]);
  });

  test("retains an unadmitted created agent when cancellation is refused", async () => {
    const harness = await createHarness();
    harness.runtime.blockCreation = true;
    harness.runtime.cancellation = { status: "refused" };
    const run = await startRun(harness);
    await harness.runtime.waitForCreations(1);

    const canceling = harness.service.cancelRun(run.id);
    harness.runtime.unblockCreation();
    const refused = await canceling;

    expect(refused.state.status).toBe("stop_failed");
    expect(refused.steps[0]?.state).toMatchObject({
      status: "stop_failed",
      agentId: firstAgentId,
    });
    expect(harness.runtime.streams).toEqual([]);

    harness.runtime.cancellation = { status: "settled" };
    const canceled = await harness.service.cancelRun(run.id);
    expect(canceled.state.status).toBe("canceled");
    expect(harness.runtime.cancellations).toEqual([firstAgentId, firstAgentId]);
  });

  test("treats Workspace archive as authoritative cancellation", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);

    await harness.workspaceRegistry.archive("wks_team_service");

    const canceled = await harness.service.waitForRun(run.id);
    expect(canceled.state.status).toBe("canceled");
    expect(canceled.steps[1]?.state.status).toBe("pending");
    expect(harness.runtime.creations).toHaveLength(1);
  });

  test("keeps Workspace termination authoritative when final-step cancellation is refused", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);
    harness.runtime.finalResponses.set(firstAgentId, "Builder finished.");
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
    });
    await harness.runtime.waitForStream(secondAgentId);
    harness.runtime.cancellation = { status: "refused" };

    await harness.workspaceRegistry.archive("wks_team_service");
    expect((await harness.repository.getRun(run.id))?.state.status).toBe("stop_failed");

    harness.runtime.finalResponses.set(secondAgentId, "Review finished after termination.");
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
    });

    const canceled = await harness.service.waitForRun(run.id);
    expect(canceled.state.status).toBe("canceled");
    expect(canceled.steps).toMatchObject([
      { state: { status: "succeeded", agentId: firstAgentId } },
      { state: { status: "canceled", agentId: secondAgentId } },
    ]);
  });

  test("fences final completion before the Workspace run lookup settles", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);
    harness.runtime.finalResponses.set(firstAgentId, "Builder finished.");
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
    });
    await harness.runtime.waitForStream(secondAgentId);

    const originalLookup = harness.repository.getActiveRunForWorkspace.bind(harness.repository);
    let reportLookupEntered: (() => void) | undefined;
    let releaseLookup: (() => void) | undefined;
    const lookupEntered = new Promise<void>((resolve) => {
      reportLookupEntered = resolve;
    });
    const lookupReleased = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    harness.repository.getActiveRunForWorkspace = async (workspaceId) => {
      reportLookupEntered?.();
      await lookupReleased;
      return originalLookup(workspaceId);
    };

    const archiving = harness.workspaceRegistry.archive("wks_team_service");
    await lookupEntered;
    harness.runtime.finalResponses.set(secondAgentId, "Review crossed the archive boundary.");
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
    });
    const canceled = await harness.service.waitForRun(run.id);
    releaseLookup?.();
    await archiving;

    expect(canceled.state.status).toBe("canceled");
    expect(canceled.steps[1]?.state).toMatchObject({
      status: "canceled",
      agentId: secondAgentId,
    });
  });

  test("fences final completion before an archived Workspace is published", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);
    harness.runtime.finalResponses.set(firstAgentId, "Builder finished.");
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
    });
    await harness.runtime.waitForStream(secondAgentId);
    harness.workspaceRegistry.blockMutationPublication = true;
    const committed = harness.workspaceRegistry.waitForMutationCommit();

    const archiving = harness.workspaceRegistry.archive("wks_team_service");
    await committed;
    harness.runtime.finalResponses.set(secondAgentId, "Review crossed the commit boundary.");
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
    });
    const canceled = await harness.service.waitForRun(run.id);
    harness.workspaceRegistry.unblockMutationPublication();
    await archiving;

    expect(canceled.state.status).toBe("canceled");
    expect(canceled.steps[1]?.state).toMatchObject({
      status: "canceled",
      agentId: secondAgentId,
    });
  });

  test("does not cancel a run when the Workspace archive write fails", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);
    harness.runtime.finalResponses.set(firstAgentId, "Builder finished.");
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
    });
    await harness.runtime.waitForStream(secondAgentId);
    harness.workspaceRegistry.blockMutationWrite = true;
    harness.workspaceRegistry.failMutationWrite = true;
    const writeStarted = harness.workspaceRegistry.waitForMutationWrite();

    const archiving = harness.workspaceRegistry.archive("wks_team_service").catch((error) => error);
    await writeStarted;
    harness.runtime.finalResponses.set(secondAgentId, "Review finished.");
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
    });
    harness.workspaceRegistry.unblockMutationWrite();

    await expect(archiving).resolves.toBeInstanceOf(Error);
    const completed = await harness.service.waitForRun(run.id);
    expect(completed.state.status).toBe("succeeded");
    expect(harness.workspaceRegistry.workspaces.get("wks_team_service")?.archivedAt).toBeNull();
  });

  test("does not create the next agent after Workspace termination starts during revalidation", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);
    harness.runtime.finalResponses.set(firstAgentId, "Builder finished.");
    harness.providerCatalog.blockRefresh = true;
    const refreshStarted = harness.providerCatalog.waitForRefresh();
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
    });
    await refreshStarted;

    harness.workspaceRegistry.blockNextGet = true;
    const staleReadStarted = harness.workspaceRegistry.waitForBlockedGet();
    harness.providerCatalog.unblockRefresh();
    await staleReadStarted;
    await harness.workspaceRegistry.archive("wks_team_service");
    harness.workspaceRegistry.unblockGet();

    const canceled = await harness.service.waitForRun(run.id);
    expect(canceled.state.status).toBe("canceled");
    expect(canceled.steps[1]?.state).toMatchObject({
      status: "canceled",
      agentId: null,
    });
    expect(harness.runtime.creations).toHaveLength(1);
  });

  test("fences starts and interrupts unsettled work during shutdown", async () => {
    const harness = await createHarness();
    const run = await startRun(harness);
    await harness.runtime.waitForStream(firstAgentId);
    harness.runtime.cancellation = { status: "refused" };

    await harness.service.shutdown();

    const interrupted = await harness.repository.getRun(run.id);
    expect(interrupted?.state.status).toBe("interrupted");
    expect(interrupted?.steps[0]?.state).toMatchObject({
      status: "interrupted",
      agentId: firstAgentId,
    });
    await expect(startRun(harness, "after-shutdown")).rejects.toBeInstanceOf(
      TeamRunServiceShuttingDownError,
    );
  });

  test("does not wait for an archive boundary blocked behind stalled agent creation", async () => {
    const harness = await createHarness();
    harness.runtime.blockCreation = true;
    const run = await startRun(harness);
    await harness.runtime.waitForCreations(1);
    const boundaryStarted = harness.workspaceRegistry.waitForTerminationBoundaryStart();

    const archiving = harness.workspaceRegistry.archive("wks_team_service");
    await boundaryStarted;
    await harness.service.shutdown();

    expect((await harness.repository.getRun(run.id))?.state.status).toBe("interrupted");
    await archiving;
    harness.runtime.unblockCreation();
    await expect(harness.service.waitForRun(run.id)).resolves.toMatchObject({
      state: { status: "interrupted" },
    });
    expect(harness.runtime.streams).toEqual([]);
    expect(harness.runtime.cancellations).toEqual([firstAgentId]);
  });

  test("serializes run persistence with the shutdown fence", async () => {
    const harness = await createHarness();
    const originalCreateRun = harness.repository.createRun.bind(harness.repository);
    let releaseCreateRun: (() => void) | undefined;
    let reportCreateRunEntered: (() => void) | undefined;
    const createRunEntered = new Promise<void>((resolve) => {
      reportCreateRunEntered = resolve;
    });
    const createRunReleased = new Promise<void>((resolve) => {
      releaseCreateRun = resolve;
    });
    harness.repository.createRun = async (input) => {
      reportCreateRunEntered?.();
      await createRunReleased;
      return originalCreateRun(input);
    };

    const starting = startRun(harness, "shutdown-race");
    await createRunEntered;
    const shuttingDown = harness.service.shutdown();
    releaseCreateRun?.();

    const run = await starting;
    await shuttingDown;

    expect((await harness.repository.getRun(run.id))?.state.status).toBe("interrupted");
    await expect(startRun(harness, "after-raced-shutdown")).rejects.toBeInstanceOf(
      TeamRunServiceShuttingDownError,
    );
  });

  test("marks leftover active records interrupted on startup without replaying them", async () => {
    const repository = new TeamRepository({ paseoHome, now: () => new Date(timestamp) });
    const definition = await repository.createDefinition(createDefinitionInput());
    const workspace = createWorkspace();
    const run = await repository.createRun({
      teamId: definition.id,
      expectedRevision: 1,
      idempotencyKey: "crashed-run",
      objective: "Do not replay this prompt.",
      workspace: {
        workspaceId: workspace.workspaceId,
        projectId: workspace.projectId,
        cwd: workspace.cwd,
        displayName: "Team workspace",
      },
      steps: acceptedSteps(definition),
    });
    await repository.updateRun(run.id, markFirstStepCreating);
    const harness = await createHarness({ repository, workspace });

    const recovered = await harness.repository.getRun(run.id);

    expect(recovered?.state.status).toBe("interrupted");
    expect(recovered?.steps[0]?.state).toMatchObject({
      status: "interrupted",
      agentId: null,
    });
    expect(harness.runtime.creations).toEqual([]);
  });

  test("retains a pre-crash Artifact while interrupting uncertain Assignment work", async () => {
    const repository = new TeamRepository({ paseoHome, now: () => new Date(timestamp) });
    const assignments = new AssignmentRepository({
      paseoHome,
      now: () => new Date(timestamp),
      activeRunStore: repository,
    });
    const definition = await repository.createDefinition(createDefinitionInput());
    const assignment = await assignments.createAssignment({
      title: "Crash boundary",
      objective: "Keep durable output without replaying the next step.",
      workItem: null,
    });
    const workspace = createWorkspace();
    const admitted = await repository.createAssignmentRun(
      {
        teamId: definition.id,
        expectedRevision: definition.revision,
        idempotencyKey: "assignment-crash",
        assignmentId: assignment.id,
        expectedAssignmentRevision: assignment.revision,
        workspace: {
          workspaceId: workspace.workspaceId,
          projectId: workspace.projectId,
          cwd: workspace.cwd,
          displayName: "Team workspace",
        },
        steps: acceptedSteps(definition),
      },
      assignments,
    );
    const active = await repository.updateRun(admitted.id, (run) => {
      const steps = run.steps.slice();
      const firstStep = steps[0]!;
      steps[0] = {
        ...firstStep,
        state: {
          status: "running",
          plannedAgentId: firstAgentId,
          agentId: firstAgentId,
          startedAt: timestamp,
        },
      };
      return { steps, state: { status: "running", startedAt: timestamp } };
    });
    const artifact = await materializeTeamStepArtifact(assignments, {
      run: active,
      stepIndex: 0,
      finalResponse: "Durable before the daemon stopped.",
      turnId: "turn-before-crash",
    });

    const harness = await createHarness({
      repository,
      assignmentRepository: assignments,
      workspace,
    });

    await expect(harness.repository.getRun(active.id)).resolves.toMatchObject({
      state: { status: "interrupted" },
    });
    await expect(assignments.getArtifact(artifact.id)).resolves.toEqual(artifact);
    expect(harness.runtime.creations).toEqual([]);
  });
});

function acceptedSteps(definition: PersistedTeamDefinition): PersistedTeamRunRecord["steps"] {
  const roles = new Map(definition.roles.map((role) => [role.id, role]));
  return definition.workflow.map((workflowStep) => {
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
          provider: "codex",
          model: "gpt-5.6",
          modeId: null,
          thinkingOptionId: null,
          featureValues: {},
        },
      },
      state: { status: "pending" },
    };
  });
}

async function waitForRunState(
  repository: TeamRepository,
  runId: string,
  predicate: (run: PersistedTeamRunRecord) => boolean,
): Promise<PersistedTeamRunRecord> {
  const current = await repository.getRun(runId);
  if (current && predicate(current)) return current;
  return new Promise<PersistedTeamRunRecord>((resolve) => {
    const unsubscribe = repository.subscribe((change) => {
      if (change.type !== "run_updated" || change.run.id !== runId) return;
      if (!predicate(change.run)) return;
      unsubscribe();
      resolve(change.run);
    });
  });
}

function markFirstStepCreating(run: PersistedTeamRunRecord) {
  const steps = run.steps.slice();
  const firstStep = steps[0];
  if (!firstStep) throw new Error(`Team Run ${run.id} has no first step`);
  steps[0] = {
    ...firstStep,
    state: { status: "creating", plannedAgentId: firstAgentId, startedAt: timestamp },
  };
  return { steps, state: { status: "running" as const, startedAt: timestamp } };
}
