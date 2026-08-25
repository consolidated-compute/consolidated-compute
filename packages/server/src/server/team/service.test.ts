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
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceMutation,
} from "../workspace-registry.js";
import type { TeamProviderCatalog } from "./execution.js";
import type { PersistedTeamDefinition, PersistedTeamRunRecord } from "./model.js";
import {
  TeamRepository,
  TeamWorkspaceHasActiveRunError,
  type CreateTeamDefinitionInput,
} from "./repository.js";
import {
  TeamRunService,
  TeamRunServiceShuttingDownError,
  type TeamRunWorkspaceRegistry,
} from "./service.js";

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
  readonly workspaces = new Map<string, PersistedWorkspaceRecord>();

  constructor(workspace: PersistedWorkspaceRecord) {
    this.workspaces.set(workspace.workspaceId, workspace);
  }

  async get(workspaceId: string): Promise<PersistedWorkspaceRecord | null> {
    return this.workspaces.get(workspaceId) ?? null;
  }

  subscribeToMutations(
    listener: (mutation: WorkspaceMutation) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async archive(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    const archived = { ...workspace, archivedAt: timestamp, updatedAt: timestamp };
    this.workspaces.set(workspaceId, archived);
    const mutation: WorkspaceMutation = {
      kind: "archive",
      workspaceId,
      workspace: archived,
    };
    await Promise.all([...this.listeners].map((listener) => listener(mutation)));
  }
}

class MemoryProviderCatalog implements TeamProviderCatalog {
  models = [{ provider: "codex", id: "gpt-5.6", label: "GPT-5.6" }];

  async refreshSnapshotForCwd(): Promise<void> {}

  async listModels() {
    return this.models;
  }

  async resolveCreateConfig(input: Parameters<TeamProviderCatalog["resolveCreateConfig"]>[0]) {
    return { modeId: input.requestedMode, featureValues: input.featureValues };
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
    initialize?: boolean;
  }): Promise<Harness> {
    const repository =
      options?.repository ?? new TeamRepository({ paseoHome, now: () => new Date(timestamp) });
    const definitions = await repository.listDefinitions();
    const definition =
      definitions.definitions[0] ?? (await repository.createDefinition(createDefinitionInput()));
    const workspaceRegistry = new MemoryWorkspaceRegistry(options?.workspace ?? createWorkspace());
    const providerCatalog = new MemoryProviderCatalog();
    const daemonConfigStore = new MemoryDaemonConfigStore();
    const runtime = new MemoryAgentRuntime();
    const ids = [firstAgentId, secondAgentId, unusedAgentId];
    const service = new TeamRunService({
      repository,
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
    const stopping = await harness.service.cancelRun(run.id);
    expect(stopping.state.status).toBe("stopping");
    expect(stopping.steps[0]?.state).toMatchObject({ status: "stopping", agentId: null });
    harness.runtime.unblockCreation();

    const canceled = await harness.service.waitForRun(run.id);
    expect(canceled.state.status).toBe("canceled");
    expect(harness.runtime.streams).toEqual([]);
    expect(harness.runtime.creations).toHaveLength(1);
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
