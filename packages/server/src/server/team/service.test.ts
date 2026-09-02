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
import {
  preflightTeamRun,
  TeamExecutionPreflightError,
  type TeamProviderCatalog,
} from "./execution.js";
import { materializeTeamStepArtifact, TeamArtifactInputError } from "./artifacts.js";
import {
  PersistedTeamRunRecordSchema,
  TEAM_INSTRUCTIONS_MAX_CHARS,
  TEAM_MAX_WORKFLOW_STEPS,
  TEAM_OBJECTIVE_MAX_CHARS,
  type PersistedTeamDefinition,
  type PersistedTeamRunRecord,
} from "./model.js";
import {
  TeamRepository,
  TeamRunSupervisionActionConflictError,
  TeamWorkspaceHasActiveRunError,
  type CreateTeamDefinitionInput,
} from "./repository.js";
import {
  TeamSecurityPreviewStaleError,
  TeamRunService,
  TeamRunServiceShuttingDownError,
  type TeamSupervisedControlPlaneProtection,
  type TeamRunWorkspaceRegistry,
} from "./service.js";
import { createInitialTeamRunSupervision, TeamSupervisorRoleInvalidError } from "./supervision.js";
import { TEAM_SUPERVISOR_PROMPT_MAX_BYTES } from "./supervised-execution.js";
import { toTeamRunDto } from "./wire.js";

const timestamp = "2026-08-25T12:00:00.000Z";
const firstAgentId = "00000000-0000-4000-8000-000000000401";
const secondAgentId = "00000000-0000-4000-8000-000000000402";
const unusedAgentId = "00000000-0000-4000-8000-000000000403";
const revisionAgentId = "00000000-0000-4000-8000-000000000404";

function requireSupervision(run: PersistedTeamRunRecord) {
  if (!run.supervision) throw new Error("Expected supervised Team Run state");
  return run.supervision;
}

function requireWorkerStep(run: PersistedTeamRunRecord, workItemId: string, attemptIndex = 0) {
  const steps = run.steps.filter(
    (step) =>
      step.snapshot.supervision?.kind === "worker" &&
      step.snapshot.supervision.workItemId === workItemId,
  );
  const step = steps[attemptIndex];
  if (!step) throw new Error(`Expected worker attempt ${attemptIndex + 1} for ${workItemId}`);
  return step;
}

function requireWorkerMetadata(step: PersistedTeamRunRecord["steps"][number]) {
  const metadata = step.snapshot.supervision;
  if (metadata?.kind !== "worker") throw new Error("Expected worker attempt lineage");
  return metadata;
}

function requireOutputArtifactId(step: PersistedTeamRunRecord["steps"][number]): string {
  const artifactId = step.snapshot.outputArtifact?.id;
  if (!artifactId) throw new Error("Expected worker output Artifact ID");
  return artifactId;
}

function requireRevisionDecision(run: PersistedTeamRunRecord) {
  const decision = requireSupervision(run).decisions.find(
    (candidate) => candidate.kind === "request_revision",
  );
  if (!decision || decision.kind !== "request_revision") {
    throw new Error("Expected a durable revision decision");
  }
  return decision;
}

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
  requireRegisteredCancellation = false;
  beforeCreate: ((input: CreateAgentFromMcpInput) => Promise<void>) | null = null;
  blockCreation = false;
  private releaseCreation: (() => void) | null = null;
  private readonly creationWaiters = new Set<() => void>();
  private readonly streamWaiters = new Map<string, Set<() => void>>();
  private readonly eventQueues = new Map<string, QueuedEvent[]>();
  private readonly eventWaiters = new Map<string, Set<() => void>>();
  private readonly registeredStreams = new Set<string>();

  async createAgent(input: CreateAgentFromMcpInput): Promise<void> {
    await this.beforeCreate?.(input);
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

  streamAgent(agentId: string, prompt: AgentPromptInput): AsyncGenerator<AgentStreamEvent> {
    this.streams.push({ agentId, prompt });
    this.registeredStreams.add(agentId);
    for (const waiter of this.streamWaiters.get(agentId) ?? []) waiter();
    this.streamWaiters.delete(agentId);
    return this.readRegisteredStream(agentId);
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    return this.finalResponses.get(agentId) ?? null;
  }

  async listDraftFeatures(_config: AgentSessionConfig): Promise<AgentFeature[]> {
    return [];
  }

  async cancelAgentRun(agentId: string): Promise<AgentRunCancellationResult> {
    this.cancellations.push(agentId);
    if (this.requireRegisteredCancellation && !this.registeredStreams.has(agentId)) {
      return { status: "not_running" };
    }
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

  async waitForStreamCount(agentId: string, count: number): Promise<void> {
    if (this.streams.filter((stream) => stream.agentId === agentId).length >= count) return;
    await new Promise<void>((resolve) => {
      const waiters = this.streamWaiters.get(agentId) ?? new Set();
      waiters.add(resolve);
      this.streamWaiters.set(agentId, waiters);
    });
    await this.waitForStreamCount(agentId, count);
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

  private async *readRegisteredStream(agentId: string): AsyncGenerator<AgentStreamEvent> {
    try {
      for (;;) {
        const queued = await this.nextEvent(agentId);
        queued.resolveConsumed();
        if (queued.event === null) return;
        yield queued.event;
      }
    } finally {
      this.registeredStreams.delete(agentId);
    }
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
    supervisedControlPlaneProtection?: TeamSupervisedControlPlaneProtection;
    initialize?: boolean;
    now?: () => Date;
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
    const ids = [firstAgentId, secondAgentId, unusedAgentId, revisionAgentId];
    const service = new TeamRunService({
      repository,
      assignmentRepository: assignments,
      supervisedControlPlaneProtection:
        options?.supervisedControlPlaneProtection ?? "authenticated",
      workspaceRegistry,
      providerCatalog,
      daemonConfigStore,
      createAgent: (input) => runtime.createAgent(input),
      agentManager: runtime,
      cancelAgentRun: (agentId) => runtime.cancelAgentRun(agentId),
      logger: createTestLogger(),
      now: options?.now ?? (() => new Date(timestamp)),
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

  test("rejects a human response without waiting when the run has no request", async () => {
    const harness = await createHarness();
    const run = await startRun(harness, "human-response-without-request");
    await harness.runtime.waitForStream(firstAgentId);
    const executionState = harness.service as unknown as {
      executions: Map<string, Promise<void>>;
    };
    const activeExecution = executionState.executions.get(run.id);
    if (!activeExecution) throw new Error("Expected the Team Run execution to be active");
    const poisonExecution = Promise.reject(
      new Error("Human response waited for an unrelated execution"),
    );
    void poisonExecution.catch(() => undefined);
    executionState.executions.set(run.id, poisonExecution);

    try {
      await expect(
        harness.service.respondToSupervisionHumanRequest({
          runId: run.id,
          requestId: "human_missing",
          expectedRequestRevision: 1,
          actionId: "continue",
          note: null,
          idempotencyKey: "human-response-without-request",
        }),
      ).rejects.toMatchObject({ code: "team_run_not_supervised" });
    } finally {
      executionState.executions.set(run.id, activeExecution);
    }

    await expect(harness.service.cancelRun(run.id)).resolves.toMatchObject({
      state: { status: "canceled" },
    });
  });

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

  async function startSupervisedRun(harness: Harness, idempotencyKey: string) {
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
            instructions: "Coordinate bounded work through durable decisions.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Supervised execution boundary",
      objective: "Preserve authoritative worker and decision outcomes.",
      workItem: null,
    });
    const run = await harness.service.admitSupervisedAssignmentRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey,
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
      supervisorRoleId: "role_supervisor",
    });
    return { assignment, definition, run };
  }

  test("persists supervised admission before launching its frozen supervisor", async () => {
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
    harness.runtime.beforeCreate = async (creation) => {
      const active = (await harness.repository.listRuns()).runs.find(
        (candidate) => candidate.steps[0]?.state.plannedAgentId === creation.agentId,
      );
      expect(active).toMatchObject({
        steps: [{ state: { status: "creating", plannedAgentId: firstAgentId } }],
        supervision: { phase: "planning", revision: 2 },
      });
    };

    const run = await harness.service.admitSupervisedAssignmentRun(input);
    await harness.runtime.waitForCreations(1);

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
    expect(harness.runtime.creations).toMatchObject([
      {
        agentId: firstAgentId,
        labels: {
          "paseo.team-id": definition.id,
          "paseo.team-run-id": run.id,
          "paseo.team-role-id": "role_supervisor",
          "paseo.team-step-id": "supervisor_turn_1",
        },
      },
    ]);
    await expect(harness.repository.getRun(run.id)).resolves.toMatchObject({
      steps: [
        {
          snapshot: { supervision: { kind: "supervisor", decisionId: expect.any(String) } },
          state: { plannedAgentId: firstAgentId },
        },
      ],
      state: { status: "running" },
      supervision: { phase: "planning", revision: 2 },
    });
    expect(toTeamRunDto(run).supervision).toEqual({
      status: "queued",
      supervisorRoleId: "role_supervisor",
      supervisorAgentId: firstAgentId,
      completedWorkItems: 0,
      totalWorkItems: 0,
      updatedAt: timestamp,
    });
    expect(JSON.stringify(toTeamRunDto(run))).not.toContain("sandbox_mode");
    await expect(harness.service.admitSupervisedAssignmentRun(input)).resolves.toMatchObject({
      id: run.id,
      supervision: { supervisor: { agentId: firstAgentId } },
    });
    await expect(
      harness.service.admitSupervisedAssignmentRun({
        ...input,
        supervisorRoleId: "role_builder",
      }),
    ).rejects.toMatchObject({ code: "team_run_idempotency_conflict" });
    const canceled = await harness.service.cancelRun(run.id);
    expect(canceled).toMatchObject({
      state: { status: "canceled" },
      steps: [{ state: { status: "canceled", agentId: firstAgentId } }],
      supervision: { phase: "canceled" },
    });
    expect(harness.runtime.cancellations).toEqual([firstAgentId]);

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

  test("registers a supervisor prompt before releasing its cancellation fence", async () => {
    const harness = await createHarness();
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
      title: "Supervisor prompt cancellation fence",
      objective: "Cancel before the supervisor prompt can escape admission.",
      workItem: null,
    });
    harness.runtime.requireRegisteredCancellation = true;
    const originalGetRun = harness.repository.getRun.bind(harness.repository);
    let activeSupervisorReads = 0;
    let canceling: Promise<PersistedTeamRunRecord> | undefined;
    let reportCancellationStarted: (() => void) | undefined;
    const cancellationStarted = new Promise<void>((resolve) => {
      reportCancellationStarted = resolve;
    });
    harness.repository.getRun = async (runId) => {
      const current = await originalGetRun(runId);
      const activeSupervisor = current?.steps.find(
        (step) =>
          step.snapshot.supervision?.kind === "supervisor" && step.state.status === "running",
      );
      if (activeSupervisor && !canceling && ++activeSupervisorReads === 3) {
        canceling = harness.service.cancelRun(runId);
        reportCancellationStarted?.();
      }
      return current;
    };

    const run = await harness.service.admitSupervisedAssignmentRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "supervisor-prompt-cancel-fence",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
      supervisorRoleId: "role_supervisor",
    });
    await cancellationStarted;
    const canceled = await canceling;

    expect(canceled).toMatchObject({
      id: run.id,
      state: { status: "canceled" },
      supervision: { phase: "canceled", decisions: [] },
    });
    expect(harness.runtime.streams).toHaveLength(1);
    expect(harness.runtime.cancellations).toEqual([firstAgentId]);
  });

  test("uses one repository timestamp for every supervisor decision effect", async () => {
    let repositoryTimestamp = timestamp;
    let serviceTimestamp = "2026-08-25T12:00:05.000Z";
    const committedAt = "2026-08-25T12:00:10.000Z";
    const repository = new TeamRepository({
      paseoHome,
      now: () => new Date(repositoryTimestamp),
    });
    const harness = await createHarness({
      repository,
      now: () => new Date(serviceTimestamp),
    });
    const { run } = await startSupervisedRun(harness, "supervision-commit-timestamp");

    await harness.runtime.waitForStreamCount(firstAgentId, 1);
    repositoryTimestamp = committedAt;
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "escalate",
        actionId: "action_escalate_timestamp",
        summary: "Commit every effect at one repository-owned instant.",
        workItemId: null,
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-escalate-timestamp",
    });

    const waiting = await harness.service.waitForRun(run.id);
    expect(waiting).toMatchObject({
      steps: [{ state: { status: "succeeded", endedAt: committedAt } }],
      supervision: {
        phase: "awaiting_human",
        decisions: [{ actionId: "action_escalate_timestamp", createdAt: committedAt }],
        humanRequest: { createdAt: committedAt },
        updatedAt: committedAt,
      },
      updatedAt: committedAt,
    });
    repositoryTimestamp = "2026-08-25T12:00:15.000Z";
    serviceTimestamp = repositoryTimestamp;
    await harness.service.cancelRun(run.id);
  });

  test("bounds the complete supervisor prompt for a maximum-sized Team", async () => {
    const harness = await createHarness();
    const maximumInstructions = "🙂".repeat(TEAM_INSTRUCTIONS_MAX_CHARS / 2);
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
        instructions: maximumInstructions,
        roles: [
          ...harness.definition.roles.map((role) => ({
            ...role,
            instructions: maximumInstructions,
          })),
          {
            id: "role_supervisor",
            name: "Supervisor",
            instructions: maximumInstructions,
            profileId: "profile_supervisor",
          },
        ],
        workflow: Array.from({ length: TEAM_MAX_WORKFLOW_STEPS }, (_, index) => ({
          id: `step_max_${index + 1}`,
          roleId: index % 2 === 0 ? "role_builder" : "role_reviewer",
          instructions: maximumInstructions,
        })),
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Maximum supervisor prompt",
      objective: "o".repeat(TEAM_OBJECTIVE_MAX_CHARS),
      workItem: null,
    });
    const run = await harness.service.admitSupervisedAssignmentRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "maximum-supervisor-prompt",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
      supervisorRoleId: "role_supervisor",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 1);
    const prompt = harness.runtime.streams[0]!.prompt;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(TEAM_SUPERVISOR_PROMPT_MAX_BYTES);
    expect(prompt).toContain("step_max_24");
    expect(prompt).toContain(
      `[truncated; originalBytes=${Buffer.byteLength(maximumInstructions, "utf8")}]`,
    );
    expect(prompt).not.toContain("�");
    await harness.service.cancelRun(run.id);
  });

  test("executes validated supervisor decisions and one frozen worker at a time", async () => {
    const harness = await createHarness();
    harness.daemonConfigStore.agentProfiles.push({
      id: "profile_supervisor",
      name: "Supervisor",
      provider: "codex",
      model: "gpt-5.6",
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
            instructions: "Plan bounded work, dispatch it, and complete only after success.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Structured supervised execution",
      objective: "Build the change and review it through durable supervisor decisions.",
      workItem: null,
    });
    const run = await harness.service.admitSupervisedAssignmentRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "supervised-execution-1",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
      supervisorRoleId: "role_supervisor",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 1);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "complete",
        actionId: "action_complete_too_early",
        summary: "This must be rejected before work succeeds.",
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-supervisor-invalid",
    });
    await harness.runtime.waitForStreamCount(firstAgentId, 2);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "plan",
        actionId: "action_plan_delivery",
        summary: "Build the requested change, then perform the frozen review step.",
        workItems: [
          { id: "work_build", templateStepId: "step_build" },
          { id: "work_review", templateStepId: "step_review" },
        ],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-supervisor-plan",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 3);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_build",
        summary: "Dispatch the builder from the frozen template.",
        workItemId: "work_build",
        inputArtifactIds: [],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-supervisor-dispatch-build",
    });

    await harness.runtime.waitForStream(secondAgentId);
    harness.runtime.finalResponses.set(secondAgentId, "Builder produced a durable result.");
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-worker-build",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 4);
    const buildArtifactId = (await harness.repository.getRun(run.id))?.steps.find(
      (step) => step.snapshot.supervision?.kind === "worker",
    )?.snapshot.outputArtifact?.id;
    if (!buildArtifactId) throw new Error("Expected the build output Artifact ID");
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_review",
        summary: "Dispatch the reviewer from the frozen template.",
        workItemId: "work_review",
        inputArtifactIds: [buildArtifactId],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-supervisor-dispatch-review",
    });

    await harness.runtime.waitForStream(unusedAgentId);
    harness.runtime.finalResponses.set(unusedAgentId, "Review passed without defects.");
    await harness.runtime.pushEvent(unusedAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-worker-review",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 5);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "complete",
        actionId: "action_complete_delivery",
        summary: "Every planned work item succeeded.",
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-supervisor-complete",
    });

    const completed = await harness.service.waitForRun(run.id);
    expect(completed).toMatchObject({
      state: { status: "succeeded" },
      supervision: {
        phase: "completed",
        workItems: [
          { id: "work_build", status: "succeeded", acceptedAttemptId: expect.any(String) },
          { id: "work_review", status: "succeeded", acceptedAttemptId: expect.any(String) },
        ],
        decisions: [
          { kind: "plan", actionId: "action_plan_delivery" },
          { kind: "dispatch", actionId: "action_dispatch_build" },
          { kind: "dispatch", actionId: "action_dispatch_review" },
          { kind: "complete", actionId: "action_complete_delivery" },
        ],
      },
    });
    expect(completed.steps.map((step) => step.snapshot.supervision?.kind)).toEqual([
      "supervisor",
      "supervisor",
      "worker",
      "supervisor",
      "worker",
      "supervisor",
    ]);
    expect(
      completed.supervision?.events
        ?.filter((event) => event.kind === "worker.succeeded")
        .map((event) => event.agentIds),
    ).toEqual([[secondAgentId], [unusedAgentId]]);
    expect(harness.runtime.creations.map((creation) => creation.agentId)).toEqual([
      firstAgentId,
      secondAgentId,
      unusedAgentId,
    ]);
    expect(
      harness.runtime.streams.filter((stream) => stream.agentId === firstAgentId)[1]?.prompt,
    ).toContain("Complete requires every planned work item to have succeeded");
    expect(
      harness.runtime.streams.find((stream) => stream.agentId === firstAgentId)?.prompt,
    ).toContain('roleInstructions="Implement the requested change."; stepInstructions=null');
    expect(
      harness.runtime.streams.find((stream) => stream.agentId === secondAgentId)?.prompt,
    ).toContain("Work item: work_build");
    const reviewPrompt = harness.runtime.streams.find(
      (stream) => stream.agentId === unusedAgentId,
    )?.prompt;
    expect(reviewPrompt).toContain("Work item: work_review");
    expect(reviewPrompt).toContain("Builder produced a durable result.");
    await expect(
      harness.assignments.listArtifacts({ assignmentId: assignment.id }),
    ).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ content: "Builder produced a durable result." }),
        expect.objectContaining({ content: "Review passed without defects." }),
      ]),
      issues: [],
    });
  });

  test("routes exact immutable Artifacts into a fresh revision attempt", async () => {
    const harness = await createHarness();
    const { assignment, run } = await startSupervisedRun(
      harness,
      "supervised-exact-revision-lineage",
    );

    await harness.runtime.waitForStreamCount(firstAgentId, 1);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "plan",
        actionId: "action_plan_revision",
        summary: "Build the change, review it, then revise the build from exact evidence.",
        workItems: [
          { id: "work_build_revision", templateStepId: "step_build" },
          { id: "work_review_revision", templateStepId: "step_review" },
        ],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-plan-revision",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 2);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_initial_build",
        summary: "Dispatch the initial build without implicit inputs.",
        workItemId: "work_build_revision",
        inputArtifactIds: [],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-dispatch-initial-build",
    });
    await harness.runtime.waitForStream(secondAgentId);
    harness.runtime.finalResponses.set(secondAgentId, "INITIAL_BUILD_ARTIFACT");
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-initial-build",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 3);
    const afterBuild = (await harness.repository.getRun(run.id))!;
    const initialBuildStep = requireWorkerStep(afterBuild, "work_build_revision");
    const initialBuildArtifactId = requireOutputArtifactId(initialBuildStep);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_revision_review",
        summary: "Review the exact initial build Artifact.",
        workItemId: "work_review_revision",
        inputArtifactIds: [initialBuildArtifactId],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-dispatch-revision-review",
    });
    await harness.runtime.waitForStream(unusedAgentId);
    harness.runtime.finalResponses.set(unusedAgentId, "REVIEW_FEEDBACK_ARTIFACT");
    await harness.runtime.pushEvent(unusedAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-revision-review",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 4);
    const afterReview = (await harness.repository.getRun(run.id))!;
    const initialBuildAttemptId = requireWorkerMetadata(initialBuildStep);
    const reviewArtifactId = requireOutputArtifactId(
      requireWorkerStep(afterReview, "work_review_revision"),
    );
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "request_revision",
        actionId: "action_request_build_revision",
        summary: "Revise the build using its prior output and the exact review feedback.",
        workItemId: "work_build_revision",
        inputArtifactIds: [initialBuildArtifactId, reviewArtifactId],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-request-build-revision",
    });

    await harness.runtime.waitForStream(revisionAgentId);
    const revisionPrompt = harness.runtime.streams.find(
      (stream) => stream.agentId === revisionAgentId,
    )?.prompt;
    expect(revisionPrompt).toContain("INITIAL_BUILD_ARTIFACT");
    expect(revisionPrompt).toContain("REVIEW_FEEDBACK_ARTIFACT");
    expect(revisionPrompt).toContain(`Revision parent attempt: ${initialBuildAttemptId.attemptId}`);
    harness.runtime.finalResponses.set(revisionAgentId, "REVISED_BUILD_ARTIFACT");
    await harness.runtime.pushEvent(revisionAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-revised-build",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 5);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "complete",
        actionId: "action_complete_revision",
        summary: "The exact revision completed successfully.",
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-complete-revision",
    });

    const completed = await harness.service.waitForRun(run.id);
    const completedSupervision = requireSupervision(completed);
    const buildWorkItem = completedSupervision.workItems.find(
      (workItem) => workItem.id === "work_build_revision",
    );
    const buildAttempts = completed.steps.filter(
      (step) =>
        step.snapshot.supervision?.kind === "worker" &&
        step.snapshot.supervision.workItemId === "work_build_revision",
    );
    const revisedBuildAttempt = buildAttempts[1]!;
    const revisedBuildMetadata = requireWorkerMetadata(revisedBuildAttempt);
    expect(completed.state.status).toBe("succeeded");
    expect(completedSupervision.decisions.map((decision) => decision.kind)).toEqual([
      "plan",
      "dispatch",
      "dispatch",
      "request_revision",
      "complete",
    ]);
    expect(buildAttempts).toHaveLength(2);
    expect(revisedBuildAttempt).toMatchObject({
      snapshot: {
        inputArtifactIds: [initialBuildArtifactId, reviewArtifactId],
        supervision: {
          attemptNumber: 2,
          revisionParentAttemptId: initialBuildAttemptId.attemptId,
        },
      },
      state: { status: "succeeded", agentId: revisionAgentId },
    });
    expect(requireOutputArtifactId(revisedBuildAttempt)).not.toBe(initialBuildArtifactId);
    expect(buildWorkItem).toMatchObject({
      status: "succeeded",
      attemptIds: [initialBuildAttemptId.attemptId, revisedBuildMetadata.attemptId],
      acceptedAttemptId: revisedBuildMetadata.attemptId,
      inputArtifactIds: [initialBuildArtifactId, reviewArtifactId],
    });
    const revisionDecision = requireRevisionDecision(completed);
    await expect(
      harness.repository.commitSupervisionDecision(
        {
          runId: run.id,
          expectedSupervisionRevision: 1,
          decision: { ...revisionDecision, inputArtifactIds: [reviewArtifactId] },
        },
        () => {
          throw new Error("Conflicting Artifact inputs must not invoke the updater");
        },
      ),
    ).rejects.toBeInstanceOf(TeamRunSupervisionActionConflictError);
    await expect(
      harness.assignments.listArtifacts({ assignmentId: assignment.id }),
    ).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ id: initialBuildArtifactId, content: "INITIAL_BUILD_ARTIFACT" }),
        expect.objectContaining({ id: reviewArtifactId, content: "REVIEW_FEEDBACK_ARTIFACT" }),
        expect.objectContaining({ content: "REVISED_BUILD_ARTIFACT" }),
      ]),
      issues: [],
    });
  });

  test("rejects an over-budget cumulative Artifact handoff before dispatch", async () => {
    const harness = await createHarness();
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
            instructions: "Dispatch only bounded Artifact handoffs.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Bound supervised Artifact inputs",
      objective: "Do not persist a dispatch whose inputs cannot fit in the worker prompt.",
      workItem: null,
    });
    const run = await harness.service.admitSupervisedAssignmentRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "supervised-artifact-budget",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
      supervisorRoleId: "role_supervisor",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 1);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "plan",
        actionId: "action_plan_budget",
        summary: "Build, then review the bounded result.",
        workItems: [
          { id: "work_build_budget", templateStepId: "step_build" },
          { id: "work_review_budget", templateStepId: "step_review" },
        ],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-plan-budget",
    });
    await harness.runtime.waitForStreamCount(firstAgentId, 2);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_build_budget",
        summary: "Dispatch the builder.",
        workItemId: "work_build_budget",
        inputArtifactIds: [],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-dispatch-build-budget",
    });
    await harness.runtime.waitForStream(secondAgentId);
    const budgetBuildArtifactId = (await harness.repository.getRun(run.id))?.steps.find(
      (step) => step.snapshot.supervision?.kind === "worker",
    )?.snapshot.outputArtifact?.id;
    if (!budgetBuildArtifactId) throw new Error("Expected the budget build output Artifact ID");
    const originalGetArtifact = harness.assignments.getArtifact.bind(harness.assignments);
    harness.assignments.getArtifact = async (artifactId) => {
      const artifact = await originalGetArtifact(artifactId);
      if (artifact) {
        throw new TeamArtifactInputError(
          "input_budget_exceeded",
          null,
          "Artifact prompt inputs exceed 32768 UTF-8 bytes",
        );
      }
      return artifact;
    };
    harness.runtime.finalResponses.set(secondAgentId, "Builder output.");
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-worker-build-budget",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 3);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_review_over_budget",
        summary: "Dispatch the reviewer.",
        workItemId: "work_review_budget",
        inputArtifactIds: [budgetBuildArtifactId],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-dispatch-review-over-budget",
    });
    await harness.runtime.waitForStreamCount(firstAgentId, 4);
    expect(
      harness.runtime.streams.filter((stream) => stream.agentId === firstAgentId)[3]?.prompt,
    ).toContain("Artifact prompt inputs exceed 32768 UTF-8 bytes");
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "escalate",
        actionId: "action_escalate_artifact_budget",
        summary: "The frozen Artifact handoff exceeds the prompt budget.",
        workItemId: "work_review_budget",
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-escalate-artifact-budget",
    });

    const waiting = await harness.service.waitForRun(run.id);
    expect(waiting).toMatchObject({
      state: { status: "running" },
      supervision: {
        phase: "awaiting_human",
        decisions: [
          { kind: "plan" },
          { kind: "dispatch", workItemId: "work_build_budget" },
          { kind: "escalate", workItemId: "work_review_budget" },
        ],
        workItems: [
          { id: "work_build_budget", status: "succeeded" },
          { id: "work_review_budget", status: "planned", attemptIds: [] },
        ],
        humanRequest: {
          actions: [{ id: "cancel", label: "Cancel run", requiresNote: false }],
        },
      },
    });
    expect(harness.runtime.creations.map((creation) => creation.agentId)).toEqual([
      firstAgentId,
      secondAgentId,
    ]);
    const request = waiting.supervision!.humanRequest!;
    await expect(
      harness.service.respondToSupervisionHumanRequest({
        runId: run.id,
        requestId: request.id,
        expectedRequestRevision: request.revision,
        actionId: "cancel",
        note: null,
        idempotencyKey: "cancel-artifact-budget",
      }),
    ).resolves.toMatchObject({
      state: { status: "canceled" },
      supervision: { humanRequest: { resolution: { actionId: "cancel" } } },
    });
  });

  test("does not reinterpret a completed worker as failed when success persistence throws", async () => {
    const harness = await createHarness();
    const { assignment, run } = await startSupervisedRun(
      harness,
      "supervised-worker-success-persistence",
    );

    await harness.runtime.waitForStreamCount(firstAgentId, 1);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "plan",
        actionId: "action_plan_success_persistence",
        summary: "Run the frozen builder.",
        workItems: [{ id: "work_success_persistence", templateStepId: "step_build" }],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-plan-success-persistence",
    });
    await harness.runtime.waitForStreamCount(firstAgentId, 2);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_success_persistence",
        summary: "Dispatch the builder.",
        workItemId: "work_success_persistence",
        inputArtifactIds: [],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-dispatch-success-persistence",
    });

    await harness.runtime.waitForStream(secondAgentId);
    const settlementOutcomes: string[] = [];
    const originalSettle = harness.repository.settleSupervisedWorker.bind(harness.repository);
    harness.repository.settleSupervisedWorker = async (input) => {
      settlementOutcomes.push(input.outcome.status);
      if (input.outcome.status === "succeeded") {
        throw new Error("simulated success settlement persistence failure");
      }
      return originalSettle(input);
    };
    harness.runtime.finalResponses.set(secondAgentId, "Authoritative successful worker output.");
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-worker-success-persistence",
    });

    const failed = await harness.service.waitForRun(run.id);
    expect(failed.state).toMatchObject({
      status: "failed",
      error: "simulated success settlement persistence failure",
    });
    expect(settlementOutcomes).toEqual(["succeeded"]);
    await expect(
      harness.assignments.listArtifacts({ assignmentId: assignment.id }),
    ).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ content: "Authoritative successful worker output." })],
      issues: [],
    });
  });

  test("does not reinterpret a failed worker when failure persistence throws", async () => {
    const harness = await createHarness();
    const { run } = await startSupervisedRun(harness, "supervised-worker-failure-persistence");

    await harness.runtime.waitForStreamCount(firstAgentId, 1);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "plan",
        actionId: "action_plan_failure_persistence",
        summary: "Run the frozen builder.",
        workItems: [{ id: "work_failure_persistence", templateStepId: "step_build" }],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-plan-failure-persistence",
    });
    await harness.runtime.waitForStreamCount(firstAgentId, 2);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_failure_persistence",
        summary: "Dispatch the builder.",
        workItemId: "work_failure_persistence",
        inputArtifactIds: [],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-dispatch-failure-persistence",
    });

    await harness.runtime.waitForStream(secondAgentId);
    const settlementOutcomes: string[] = [];
    const originalSettle = harness.repository.settleSupervisedWorker.bind(harness.repository);
    harness.repository.settleSupervisedWorker = async (input) => {
      settlementOutcomes.push(input.outcome.status);
      if (input.outcome.status === "failed") {
        throw new Error("simulated failure settlement persistence failure");
      }
      return originalSettle(input);
    };
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_failed",
      provider: "codex",
      error: "Authoritative provider failure.",
    });

    const failed = await harness.service.waitForRun(run.id);
    expect(failed.state).toMatchObject({
      status: "failed",
      error: "simulated failure settlement persistence failure",
    });
    expect(settlementOutcomes).toEqual(["failed"]);
  });

  test("offers only cancellation when escalation follows failed work", async () => {
    const harness = await createHarness();
    const { run } = await startSupervisedRun(harness, "failed-worker-escalation");

    await harness.runtime.waitForStreamCount(firstAgentId, 1);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "plan",
        actionId: "action_plan_failed_worker",
        summary: "Run the frozen builder.",
        workItems: [{ id: "work_failed_builder", templateStepId: "step_build" }],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-plan-failed-worker",
    });
    await harness.runtime.waitForStreamCount(firstAgentId, 2);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_failed_worker",
        summary: "Dispatch the builder.",
        workItemId: "work_failed_builder",
        inputArtifactIds: [],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-dispatch-failed-worker",
    });
    await harness.runtime.waitForStream(secondAgentId);
    await harness.runtime.pushEvent(secondAgentId, {
      type: "turn_failed",
      provider: "codex",
      error: "Builder could not complete the work.",
    });

    await harness.runtime.waitForStreamCount(firstAgentId, 3);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "escalate",
        actionId: "action_escalate_failed_worker",
        summary: "The first executor cannot retry this failed Work Item.",
        workItemId: "work_failed_builder",
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-escalate-failed-worker",
    });

    const waiting = await harness.service.waitForRun(run.id);
    expect(waiting.supervision).toMatchObject({
      phase: "awaiting_human",
      workItems: [{ id: "work_failed_builder", status: "failed" }],
      humanRequest: {
        actions: [{ id: "cancel", label: "Cancel run", requiresNote: false }],
      },
    });
    const request = waiting.supervision!.humanRequest!;
    await expect(
      harness.service.respondToSupervisionHumanRequest({
        runId: run.id,
        requestId: request.id,
        expectedRequestRevision: request.revision,
        actionId: "continue",
        note: "Retry the failed worker.",
        idempotencyKey: "continue-failed-worker",
      }),
    ).rejects.toMatchObject({ code: "team_run_supervision_human_request_conflict" });
    expect(
      harness.runtime.streams.filter((stream) => stream.agentId === firstAgentId),
    ).toHaveLength(3);

    const canceled = await harness.service.respondToSupervisionHumanRequest({
      runId: run.id,
      requestId: request.id,
      expectedRequestRevision: request.revision,
      actionId: "cancel",
      note: null,
      idempotencyKey: "cancel-failed-worker",
    });
    expect(canceled).toMatchObject({
      state: { status: "canceled" },
      supervision: {
        phase: "canceled",
        humanRequest: { resolution: { actionId: "cancel" } },
      },
    });
  });

  test("preserves an idle human wait across restart and resumes only after a durable response", async () => {
    const harness = await createHarness();
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
            instructions: "Escalate when the objective requires a human decision.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Supervised escalation",
      objective: "Ask a human to choose before any worker starts.",
      workItem: null,
    });
    const run = await harness.service.admitSupervisedAssignmentRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "supervised-escalation-1",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
      supervisorRoleId: "role_supervisor",
    });
    await harness.runtime.waitForStream(firstAgentId);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "escalate",
        actionId: "action_escalate_scope",
        summary: "Choose whether this Assignment should proceed.",
        workItemId: null,
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-supervisor-escalate",
    });

    const waiting = await harness.service.waitForRun(run.id);
    expect(waiting).toMatchObject({
      state: { status: "running" },
      steps: [{ state: { status: "succeeded", agentId: firstAgentId } }],
      supervision: {
        phase: "awaiting_human",
        decisions: [{ kind: "escalate", actionId: "action_escalate_scope" }],
        humanRequest: {
          kind: "supervisor_escalation",
          detail: "Choose whether this Assignment should proceed.",
          actions: [{ id: "continue" }, { id: "cancel" }],
        },
      },
    });
    expect(harness.runtime.creations.map((creation) => creation.agentId)).toEqual([firstAgentId]);

    await harness.service.shutdown();
    const preservedWait = await harness.repository.getRun(run.id);
    expect(preservedWait).toMatchObject({
      state: { status: "running" },
      supervision: { phase: "awaiting_human" },
    });
    expect(preservedWait?.supervision?.humanRequest).not.toHaveProperty("resolution");
    const restarted = await createHarness({
      repository: harness.repository,
      assignmentRepository: harness.assignments,
      workspace: createWorkspace(),
    });
    expect(restarted.runtime.creations).toEqual([]);
    expect(restarted.runtime.streams).toEqual([]);

    const request = (await restarted.repository.getRun(run.id))!.supervision!.humanRequest!;
    const resumed = await restarted.service.respondToSupervisionHumanRequest({
      runId: run.id,
      requestId: request.id,
      expectedRequestRevision: request.revision,
      actionId: "continue",
      note: "Proceed with the bounded plan.",
      idempotencyKey: "continue-supervised-escalation-1",
    });
    expect(resumed.supervision).toMatchObject({
      phase: "planning",
      humanRequest: {
        revision: 2,
        resolution: {
          actionId: "continue",
          note: "Proceed with the bounded plan.",
        },
      },
    });
    await restarted.runtime.waitForStreamCount(firstAgentId, 1);
    expect(
      restarted.runtime.streams.find((stream) => stream.agentId === firstAgentId)?.prompt,
    ).toContain("Proceed with the bounded plan.");
    await expect(
      restarted.service.respondToSupervisionHumanRequest({
        runId: run.id,
        requestId: request.id,
        expectedRequestRevision: request.revision,
        actionId: "continue",
        note: "Proceed with the bounded plan.",
        idempotencyKey: "continue-supervised-escalation-1",
      }),
    ).resolves.toMatchObject({
      supervision: { humanRequest: { resolution: { actionId: "continue" } } },
    });

    const canceled = await restarted.service.cancelRun(run.id);
    expect(canceled).toMatchObject({
      state: { status: "canceled" },
      supervision: {
        phase: "canceled",
        humanRequest: { resolution: { actionId: "continue" } },
      },
    });
  });

  test("observes Workspace archival during safe-wait startup reconciliation", async () => {
    const harness = await createHarness();
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
            instructions: "Escalate when the objective requires a human decision.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Startup reconciliation race",
      objective: "Wait for human input while the daemon restarts.",
      workItem: null,
    });
    const run = await harness.service.admitSupervisedAssignmentRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "supervised-startup-race",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
      supervisorRoleId: "role_supervisor",
    });
    await harness.runtime.waitForStream(firstAgentId);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "escalate",
        actionId: "action_escalate_startup_race",
        summary: "Wait for a human response.",
        workItemId: null,
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-supervisor-startup-race",
    });
    await expect(harness.service.waitForRun(run.id)).resolves.toMatchObject({
      state: { status: "running" },
      supervision: { phase: "awaiting_human" },
    });
    await harness.service.shutdown();

    const restarted = await createHarness({
      repository: harness.repository,
      assignmentRepository: harness.assignments,
      workspace: createWorkspace(),
      initialize: false,
    });
    restarted.workspaceRegistry.blockNextGet = true;
    const staleReadStarted = restarted.workspaceRegistry.waitForBlockedGet();
    const initialization = restarted.service.initialize();
    await staleReadStarted;
    try {
      await restarted.workspaceRegistry.archive("wks_team_service");
    } finally {
      restarted.workspaceRegistry.unblockGet();
    }
    await initialization;

    await expect(restarted.repository.getRun(run.id)).resolves.toMatchObject({
      state: { status: "canceled" },
      supervision: {
        phase: "canceled",
        humanRequest: { retirement: { reason: "canceled" } },
      },
    });
  });

  test("does not launch a worker when its dispatch decision fails to persist", async () => {
    let rejectDispatchWrite = false;
    const repository = new TeamRepository({
      paseoHome,
      now: () => new Date(timestamp),
      writeJson: async (filePath, value) => {
        const run = PersistedTeamRunRecordSchema.safeParse(value);
        if (
          rejectDispatchWrite &&
          run.success &&
          run.data.supervision?.decisions.at(-1)?.kind === "dispatch"
        ) {
          throw new Error("simulated dispatch persistence failure");
        }
        await writeJsonFileAtomic(filePath, value);
      },
    });
    const harness = await createHarness({ repository });
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
            instructions: "Persist every dispatch before its worker starts.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Dispatch failure boundary",
      objective: "Never launch from an uncertain dispatch write.",
      workItem: null,
    });
    const run = await harness.service.admitSupervisedAssignmentRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "supervised-dispatch-failure-1",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: "wks_team_service",
      supervisorRoleId: "role_supervisor",
    });
    await harness.runtime.waitForStreamCount(firstAgentId, 1);
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "plan",
        actionId: "action_plan_before_failure",
        summary: "Run the frozen builder step.",
        workItems: [{ id: "work_build", templateStepId: "step_build" }],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-plan-before-failure",
    });
    await harness.runtime.waitForStreamCount(firstAgentId, 2);
    rejectDispatchWrite = true;
    harness.runtime.finalResponses.set(
      firstAgentId,
      JSON.stringify({
        kind: "dispatch",
        actionId: "action_dispatch_write_fails",
        summary: "Dispatch the frozen builder.",
        workItemId: "work_build",
        inputArtifactIds: [],
      }),
    );
    await harness.runtime.pushEvent(firstAgentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: "turn-dispatch-write-fails",
    });

    const failed = await harness.service.waitForRun(run.id);
    expect(failed).toMatchObject({
      state: { status: "failed", error: "simulated dispatch persistence failure" },
      supervision: {
        phase: "failed",
        decisions: [{ kind: "plan", actionId: "action_plan_before_failure" }],
        workItems: [{ id: "work_build", status: "failed" }],
      },
    });
    expect(harness.runtime.creations.map((creation) => creation.agentId)).toEqual([firstAgentId]);
  });

  test.each([
    {
      protection: "passwordless" as const,
      code: "team_supervised_run_authentication_required",
      admissionStatus: "authentication_required",
    },
    {
      protection: "environment_password" as const,
      code: "team_supervised_run_environment_password_unsupported",
      admissionStatus: "environment_password_unsupported",
    },
  ])(
    "rejects supervised admission with $protection protection",
    async ({ protection, code, admissionStatus }) => {
      const harness = await createHarness({ supervisedControlPlaneProtection: protection });
      expect(harness.service.getSupervisedAdmissionStatus()).toBe(admissionStatus);
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
      ).rejects.toMatchObject({ code });
      expect(harness.runtime.creations).toEqual([]);
      await expect(harness.repository.listRuns()).resolves.toMatchObject({ runs: [] });
    },
  );

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

  test("interrupts a persisted supervisor turn on startup without replaying its prompt", async () => {
    const harness = await createHarness({ initialize: false });
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
            instructions: "Never replay an uncertain prompt after restart.",
            profileId: "profile_supervisor",
          },
        ],
      },
    });
    const assignment = await harness.assignments.createAssignment({
      title: "Supervisor restart boundary",
      objective: "Interrupt the active turn without launching its agent.",
      workItem: null,
    });
    const accepted = await preflightTeamRun(
      {
        workspaceRegistry: harness.workspaceRegistry,
        providerCatalog: harness.providerCatalog,
        featureCatalog: harness.runtime,
        daemonConfigStore: harness.daemonConfigStore,
      },
      { definition, workspaceId: "wks_team_service" },
    );
    const admitted = await harness.repository.createSupervisedAssignmentRun(
      {
        teamId: definition.id,
        expectedRevision: definition.revision,
        idempotencyKey: "supervisor-restart-boundary",
        assignmentId: assignment.id,
        expectedAssignmentRevision: assignment.revision,
        workspace: accepted.workspace,
        supervision: createInitialTeamRunSupervision({
          definition,
          accepted,
          supervisorRoleId: "role_supervisor",
          supervisorAgentId: firstAgentId,
          timestamp,
        }),
      },
      harness.assignments,
    );
    await harness.repository.beginSupervisionTurn({
      runId: admitted.id,
      expectedSupervisionRevision: 1,
      decisionId: "decision_before_restart",
    });

    await harness.service.initialize();

    await expect(harness.repository.getRun(admitted.id)).resolves.toMatchObject({
      state: { status: "interrupted" },
      steps: [
        {
          snapshot: { supervision: { kind: "supervisor" } },
          state: { status: "interrupted", agentId: null },
        },
      ],
      supervision: { phase: "interrupted" },
    });
    expect(harness.runtime.creations).toEqual([]);
    expect(harness.runtime.streams).toEqual([]);
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
