import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import type { TeamRunPreviewDto } from "@getpaseo/protocol/team/types";

import type { AgentRunCancellationResult } from "../agent/agent-manager.js";
import {
  buildStructuredAgentResponsePrompt,
  getStructuredAgentResponse,
} from "../agent/agent-response-loop.js";
import type { CreateAgentFromMcpInput } from "../agent/create-agent/create.js";
import type { AssignmentRepository } from "../assignment/repository.js";
import type { PersistedAssignmentArtifactRecord } from "../assignment/model.js";
import type { WorkspaceMutation, WorkspaceTerminationBoundary } from "../workspace-registry.js";
import {
  executeTeamStep,
  buildTeamAgentCreateInput,
  preflightTeamRun,
  revalidateTeamRunStep,
  revalidateTeamRunWorkspace,
  TeamExecutionPreflightError,
  type TeamAgentProfileConfigStore,
  type TeamAgentStream,
  type AcceptedTeamRunFacts,
  type TeamFeatureCatalog,
  type TeamProviderCatalog,
  type TeamStepExecutionEvent,
  type TeamWorkspaceStore,
  TeamStepStreamEndedError,
} from "./execution.js";
import {
  isTerminalTeamRunStatus,
  TEAM_ERROR_MAX_CHARS,
  type PersistedTeamRunRecord,
  type PersistedTeamRunState,
  type PersistedTeamRunStepState,
  type PersistedTeamRunSupervision,
  type PersistedTeamDefinition,
  type TeamRunStepStatus,
} from "./model.js";
import {
  TeamNotFoundError,
  TeamRepository,
  TeamRevisionConflictError,
  TeamRunNotFoundError,
  type ResolveTeamRunSupervisionHumanRequestInput,
  type TeamRunUpdate,
} from "./repository.js";
import {
  materializeTeamStepArtifact,
  resolveTeamRunArtifactInputs,
  resolveTeamStepInputArtifacts,
} from "./artifacts.js";
import { buildTeamRunPreview, createTeamRunPreviewFingerprint } from "./security-preview.js";
import { createInitialTeamRunSupervision } from "./supervision.js";
import {
  buildTeamSupervisionDecisionUpdate,
  canContinueTeamSupervision,
  composeSupervisedWorkerContext,
  composeTeamSupervisorPrompt,
  createTeamSupervisorActionSchema,
  normalizeTeamSupervisorDecision,
  resolveSupervisedWorkItemInputArtifactIds,
  TEAM_SUPERVISOR_PROMPT_MAX_BYTES,
  type TeamSupervisorAction,
} from "./supervised-execution.js";

type TeamRunStep = PersistedTeamRunRecord["steps"][number];
type TeamRunTerminationReason = "cancel" | "workspace" | "shutdown";

const ACTIVE_STEP_STATUSES: ReadonlySet<TeamRunStepStatus> = new Set([
  "creating",
  "running",
  "waiting_for_permission",
  "stopping",
  "stop_failed",
] as const);

export interface TeamRunWorkspaceRegistry extends TeamWorkspaceStore {
  subscribeToMutations(listener: (mutation: WorkspaceMutation) => void | Promise<void>): () => void;
  subscribeToTerminationBoundaries(
    listener: (boundary: WorkspaceTerminationBoundary) => void | Promise<void>,
  ): () => void;
}

export interface StartTeamRunInput {
  teamId: string;
  expectedRevision: number;
  idempotencyKey: string;
  objective: string;
  workspaceId: string;
  expectedPreviewFingerprint?: string;
}

export interface PreviewTeamRunInput {
  teamId: string;
  expectedRevision: number;
  workspaceId: string;
}

export interface StartAssignmentTeamRunInput {
  teamId: string;
  expectedRevision: number;
  idempotencyKey: string;
  assignmentId: string;
  expectedAssignmentRevision: number;
  workspaceId: string;
  expectedPreviewFingerprint?: string;
}

export interface AdmitSupervisedAssignmentTeamRunInput extends StartAssignmentTeamRunInput {
  supervisorRoleId: string;
}

export type RespondToTeamRunSupervisionHumanRequestInput =
  ResolveTeamRunSupervisionHumanRequestInput;

export interface TeamRunServiceOptions {
  repository: TeamRepository;
  assignmentRepository?: AssignmentRepository;
  supervisedControlPlaneProtection: TeamSupervisedControlPlaneProtection;
  workspaceRegistry: TeamRunWorkspaceRegistry;
  providerCatalog: TeamProviderCatalog;
  daemonConfigStore: TeamAgentProfileConfigStore;
  createAgent(input: CreateAgentFromMcpInput): Promise<unknown>;
  agentManager: TeamAgentStream & TeamFeatureCatalog;
  cancelAgentRun(agentId: string): Promise<AgentRunCancellationResult>;
  logger: Pick<Logger, "error">;
  now?: () => Date;
  createAgentId?: () => string;
}

export type TeamSupervisedControlPlaneProtection =
  | "authenticated"
  | "passwordless"
  | "environment_password";

export class TeamRunServiceShuttingDownError extends Error {
  readonly code = "team_run_service_shutting_down";

  constructor() {
    super("Team Runs cannot start while the daemon is shutting down");
    this.name = "TeamRunServiceShuttingDownError";
  }
}

export class TeamAssignmentRepositoryUnavailableError extends Error {
  readonly code = "team_assignment_repository_unavailable";

  constructor() {
    super("Assignment-backed Team Runs require an Assignment repository");
    this.name = "TeamAssignmentRepositoryUnavailableError";
  }
}

export class TeamSecurityPreviewStaleError extends Error {
  readonly code = "team_security_preview_stale";

  constructor() {
    super("Team Run security preview is stale. Refresh it and try again.");
    this.name = "TeamSecurityPreviewStaleError";
  }
}

export class TeamSupervisedRunAuthenticationRequiredError extends Error {
  readonly code = "team_supervised_run_authentication_required";

  constructor() {
    super("Supervised Team Runs require daemon password authentication before admission");
    this.name = "TeamSupervisedRunAuthenticationRequiredError";
  }
}

export class TeamSupervisedRunEnvironmentPasswordUnsupportedError extends Error {
  readonly code = "team_supervised_run_environment_password_unsupported";

  constructor() {
    super(
      "Supervised Team Runs require a persisted daemon password; PASEO_PASSWORD is readable by same-user provider processes",
    );
    this.name = "TeamSupervisedRunEnvironmentPasswordUnsupportedError";
  }
}

interface ActiveStep {
  index: number;
  step: TeamRunStep;
}

interface StepExecutionOutcome {
  status: "next" | "terminal";
  finalResponse?: string;
}

interface StepEventResult {
  agentCreated: boolean;
  outcome: StepExecutionOutcome | null;
}

type WorkspaceTerminationOutcome = "committed" | "failed";

interface WorkspaceTerminationFence {
  status: "pending" | "committed";
  outcome: Promise<WorkspaceTerminationOutcome>;
  resolveOutcome: (outcome: WorkspaceTerminationOutcome) => void;
  detached: Promise<void>;
  resolveDetached: () => void;
  isDetached: boolean;
  releaseOperation: (() => void) | null;
}

export class TeamRunService {
  private readonly repository: TeamRepository;
  private readonly assignmentRepository: AssignmentRepository | null;
  private readonly supervisedControlPlaneProtection: TeamSupervisedControlPlaneProtection;
  private readonly workspaceRegistry: TeamRunWorkspaceRegistry;
  private readonly providerCatalog: TeamProviderCatalog;
  private readonly daemonConfigStore: TeamAgentProfileConfigStore;
  private readonly createAgent: TeamRunServiceOptions["createAgent"];
  private readonly agentManager: TeamAgentStream & TeamFeatureCatalog;
  private readonly cancelAgentRun: TeamRunServiceOptions["cancelAgentRun"];
  private readonly logger: Pick<Logger, "error">;
  private readonly now: () => Date;
  private readonly createAgentId: () => string;
  private readonly executions = new Map<string, Promise<void>>();
  private readonly terminationRequests = new Map<string, TeamRunTerminationReason>();
  private readonly workspaceTerminationFences = new Map<
    string,
    Map<string, WorkspaceTerminationFence>
  >();
  private readonly workspaceOperationTails = new Map<string, Promise<void>>();
  private admissionTail: Promise<unknown> = Promise.resolve();
  private unsubscribeWorkspaceMutations: (() => void) | null = null;
  private unsubscribeWorkspaceTerminationBoundaries: (() => void) | null = null;
  private acceptingStarts = false;
  private initialized = false;

  constructor(options: TeamRunServiceOptions) {
    this.repository = options.repository;
    this.assignmentRepository = options.assignmentRepository ?? null;
    this.supervisedControlPlaneProtection = options.supervisedControlPlaneProtection;
    this.workspaceRegistry = options.workspaceRegistry;
    this.providerCatalog = options.providerCatalog;
    this.daemonConfigStore = options.daemonConfigStore;
    this.createAgent = options.createAgent;
    this.agentManager = options.agentManager;
    this.cancelAgentRun = options.cancelAgentRun;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.createAgentId = options.createAgentId ?? randomUUID;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const activeRuns = await this.repository.listActiveRuns();
    for (const run of activeRuns) {
      await this.finishTermination(
        run.id,
        "shutdown",
        "Daemon restarted before the Team Run reached a durable terminal state",
      );
    }
    this.unsubscribeWorkspaceTerminationBoundaries =
      this.workspaceRegistry.subscribeToTerminationBoundaries((boundary) =>
        this.handleWorkspaceTerminationBoundary(boundary),
      );
    this.unsubscribeWorkspaceMutations = this.workspaceRegistry.subscribeToMutations((mutation) =>
      this.handleWorkspaceMutation(mutation),
    );
    this.initialized = true;
    this.acceptingStarts = true;
  }

  supportsAssignmentRepository(repository: AssignmentRepository): boolean {
    return this.assignmentRepository?.persistenceBoundaryKey === repository.persistenceBoundaryKey;
  }

  async previewRun(input: PreviewTeamRunInput): Promise<TeamRunPreviewDto> {
    this.requireAcceptingStarts();
    const definition = await this.requireDefinition(input.teamId, input.expectedRevision);
    const accepted = await this.preflight(definition, input.workspaceId);
    return buildTeamRunPreview(accepted);
  }

  async startRun(input: StartTeamRunInput): Promise<PersistedTeamRunRecord> {
    const identity = {
      kind: "objective" as const,
      teamId: input.teamId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      objective: input.objective,
      workspaceId: input.workspaceId,
    };
    const existing = await this.repository.getRunByAdmissionIdentity(identity);
    if (existing) return existing;
    this.requireAcceptingStarts();

    const definition = await this.requireDefinition(input.teamId, input.expectedRevision);
    const accepted = await this.preflight(definition, input.workspaceId);
    return this.withWorkspaceOperation(input.workspaceId, () =>
      this.serializeAdmission(async () => {
        const acceptedExisting = await this.repository.getRunByAdmissionIdentity(identity);
        if (acceptedExisting) return acceptedExisting;
        this.requireAcceptingStarts();
        this.requireMatchingPreview(input.expectedPreviewFingerprint, accepted);
        await revalidateTeamRunWorkspace(this.workspaceRegistry, accepted.workspace);
        const run = await this.repository.createRun({
          teamId: input.teamId,
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          objective: input.objective,
          workspace: accepted.workspace,
          steps: accepted.steps,
        });
        this.launchExecution(run.id);
        return run;
      }),
    );
  }

  async startAssignmentRun(input: StartAssignmentTeamRunInput): Promise<PersistedTeamRunRecord> {
    const assignments = this.assignmentRepository;
    if (!assignments) throw new TeamAssignmentRepositoryUnavailableError();
    const identity = {
      kind: "assignment" as const,
      teamId: input.teamId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      assignmentId: input.assignmentId,
      expectedAssignmentRevision: input.expectedAssignmentRevision,
      workspaceId: input.workspaceId,
    };
    const existing = await this.repository.getRunByAdmissionIdentity(identity);
    if (existing) return existing;
    this.requireAcceptingStarts();

    const definition = await this.requireDefinition(input.teamId, input.expectedRevision);
    const accepted = await this.preflight(definition, input.workspaceId);
    return this.withWorkspaceOperation(input.workspaceId, () =>
      this.serializeAdmission(async () => {
        const acceptedExisting = await this.repository.getRunByAdmissionIdentity(identity);
        if (acceptedExisting) return acceptedExisting;
        this.requireAcceptingStarts();
        this.requireMatchingPreview(input.expectedPreviewFingerprint, accepted);
        await revalidateTeamRunWorkspace(this.workspaceRegistry, accepted.workspace);
        const run = await this.repository.createAssignmentRun(
          {
            teamId: input.teamId,
            expectedRevision: input.expectedRevision,
            idempotencyKey: input.idempotencyKey,
            assignmentId: input.assignmentId,
            expectedAssignmentRevision: input.expectedAssignmentRevision,
            workspace: accepted.workspace,
            steps: accepted.steps,
          },
          assignments,
        );
        this.launchExecution(run.id);
        return run;
      }),
    );
  }

  async admitSupervisedAssignmentRun(
    input: AdmitSupervisedAssignmentTeamRunInput,
  ): Promise<PersistedTeamRunRecord> {
    const assignments = this.assignmentRepository;
    if (!assignments) throw new TeamAssignmentRepositoryUnavailableError();
    if (this.supervisedControlPlaneProtection === "environment_password") {
      throw new TeamSupervisedRunEnvironmentPasswordUnsupportedError();
    }
    if (this.supervisedControlPlaneProtection === "passwordless") {
      throw new TeamSupervisedRunAuthenticationRequiredError();
    }
    const identity = {
      kind: "assignment" as const,
      teamId: input.teamId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      assignmentId: input.assignmentId,
      expectedAssignmentRevision: input.expectedAssignmentRevision,
      workspaceId: input.workspaceId,
      supervisorRoleId: input.supervisorRoleId,
    };
    const existing = await this.repository.getRunByAdmissionIdentity(identity);
    if (existing) return existing;
    this.requireAcceptingStarts();

    const definition = await this.requireDefinition(input.teamId, input.expectedRevision);
    const accepted = await this.preflight(definition, input.workspaceId);
    const supervision = createInitialTeamRunSupervision({
      definition,
      accepted,
      supervisorRoleId: input.supervisorRoleId,
      supervisorAgentId: this.createAgentId(),
      timestamp: this.now().toISOString(),
    });
    return this.withWorkspaceOperation(input.workspaceId, () =>
      this.serializeAdmission(async () => {
        const acceptedExisting = await this.repository.getRunByAdmissionIdentity(identity);
        if (acceptedExisting) return acceptedExisting;
        this.requireAcceptingStarts();
        this.requireMatchingPreview(input.expectedPreviewFingerprint, accepted);
        await revalidateTeamRunWorkspace(this.workspaceRegistry, accepted.workspace);
        const run = await this.repository.createSupervisedAssignmentRun(
          {
            teamId: input.teamId,
            expectedRevision: input.expectedRevision,
            idempotencyKey: input.idempotencyKey,
            assignmentId: input.assignmentId,
            expectedAssignmentRevision: input.expectedAssignmentRevision,
            workspace: accepted.workspace,
            supervision,
          },
          assignments,
        );
        this.launchExecution(run.id);
        return run;
      }),
    );
  }

  async cancelRun(runId: string): Promise<PersistedTeamRunRecord> {
    const run = await this.requireRun(runId);
    if (isTerminalTeamRunStatus(run.state.status)) return run;
    const stopped = await this.withWorkspaceOperation(run.workspace.workspaceId, async () => {
      const current = await this.requireRun(runId);
      if (isTerminalTeamRunStatus(current.state.status)) return current;
      this.requestTermination(runId, "cancel");
      return this.stopActiveRun(runId, false);
    });
    if (stopped.state.status === "stop_failed" || isTerminalTeamRunStatus(stopped.state.status)) {
      return stopped;
    }
    await this.executions.get(runId);
    const settled = await this.requireRun(runId);
    if (!isTerminalTeamRunStatus(settled.state.status) && settled.state.status !== "stop_failed") {
      return this.finishTermination(runId, this.terminationRequests.get(runId) ?? "cancel");
    }
    return settled;
  }

  async respondToSupervisionHumanRequest(
    input: RespondToTeamRunSupervisionHumanRequestInput,
  ): Promise<PersistedTeamRunRecord> {
    const current = await this.requireRun(input.runId);
    if (!current.supervision?.humanRequest?.resolution) {
      await this.executions.get(input.runId);
    }
    return this.serializeAdmission(async () => {
      this.requireAcceptingStarts();
      const resolved = await this.repository.resolveSupervisionHumanRequest(input);
      if (input.actionId === "cancel") return this.cancelRun(input.runId);
      this.launchExecution(input.runId);
      return resolved;
    });
  }

  async waitForRun(runId: string): Promise<PersistedTeamRunRecord> {
    await this.executions.get(runId);
    return this.requireRun(runId);
  }

  async shutdown(): Promise<void> {
    await this.serializeAdmission(async () => {
      this.acceptingStarts = false;
    });
    this.unsubscribeWorkspaceMutations?.();
    this.unsubscribeWorkspaceMutations = null;
    const activeRuns = await this.repository.listActiveRuns();
    for (const run of activeRuns) this.requestTermination(run.id, "shutdown");
    await Promise.allSettled(activeRuns.map((run) => this.stopActiveRun(run.id)));

    const unsettledRuns = await this.repository.listActiveRuns();
    for (const run of unsettledRuns) {
      await this.finishTermination(run.id, "shutdown", "Daemon shut down during Team Run");
    }
    this.unsubscribeWorkspaceTerminationBoundaries?.();
    this.unsubscribeWorkspaceTerminationBoundaries = null;
    this.releaseWorkspaceTerminationFences();
  }

  private requireAcceptingStarts(): void {
    if (!this.acceptingStarts) throw new TeamRunServiceShuttingDownError();
  }

  private async requireDefinition(
    teamId: string,
    expectedRevision: number,
  ): Promise<PersistedTeamDefinition> {
    const definition = await this.repository.getDefinition(teamId);
    if (!definition) throw new TeamNotFoundError(teamId);
    if (definition.revision !== expectedRevision) {
      throw new TeamRevisionConflictError(teamId, expectedRevision, definition.revision);
    }
    return definition;
  }

  private preflight(
    definition: PersistedTeamDefinition,
    workspaceId: string,
  ): Promise<AcceptedTeamRunFacts> {
    return preflightTeamRun(
      {
        workspaceRegistry: this.workspaceRegistry,
        providerCatalog: this.providerCatalog,
        featureCatalog: this.agentManager,
        daemonConfigStore: this.daemonConfigStore,
      },
      { definition, workspaceId },
    );
  }

  private requireMatchingPreview(
    expectedFingerprint: string | undefined,
    accepted: AcceptedTeamRunFacts,
  ): void {
    if (
      expectedFingerprint !== undefined &&
      expectedFingerprint !== createTeamRunPreviewFingerprint(accepted)
    ) {
      throw new TeamSecurityPreviewStaleError();
    }
  }

  private requireAssignmentRepository(): AssignmentRepository {
    if (!this.assignmentRepository) throw new TeamAssignmentRepositoryUnavailableError();
    return this.assignmentRepository;
  }

  private serializeAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.admissionTail.then(operation, operation);
    this.admissionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async acquireWorkspaceOperation(workspaceId: string): Promise<() => void> {
    const previous = this.workspaceOperationTails.get(workspaceId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.workspaceOperationTails.set(workspaceId, current);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      void current.then(() => {
        if (this.workspaceOperationTails.get(workspaceId) === current) {
          this.workspaceOperationTails.delete(workspaceId);
        }
        return undefined;
      });
    };
  }

  private pendingWorkspaceTerminationOutcomes(
    workspaceId: string,
  ): Promise<WorkspaceTerminationOutcome>[] {
    const fences = this.workspaceTerminationFences.get(workspaceId);
    return [...(fences?.values() ?? [])]
      .filter((fence) => fence.status === "pending")
      .map((fence) => fence.outcome);
  }

  private async withWorkspaceOperation<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const pendingBeforeLock = this.pendingWorkspaceTerminationOutcomes(workspaceId);
      if (pendingBeforeLock.length > 0) {
        await Promise.all(pendingBeforeLock);
        continue;
      }

      const release = await this.acquireWorkspaceOperation(workspaceId);
      const pendingAfterLock = this.pendingWorkspaceTerminationOutcomes(workspaceId);
      if (pendingAfterLock.length > 0) {
        release();
        await Promise.all(pendingAfterLock);
        continue;
      }

      try {
        return await operation();
      } finally {
        release();
      }
    }
  }

  private releaseWorkspaceTerminationFences(): void {
    for (const fences of this.workspaceTerminationFences.values()) {
      for (const fence of fences.values()) {
        fence.isDetached = true;
        fence.resolveDetached();
        if (fence.status === "pending") fence.resolveOutcome("failed");
        fence.releaseOperation?.();
      }
    }
    this.workspaceTerminationFences.clear();
  }

  private launchExecution(runId: string): void {
    if (this.executions.has(runId)) return;
    const execution = this.executeRun(runId)
      .catch(async (error) => {
        try {
          await this.failRun(runId, error);
        } catch (persistenceError) {
          this.logger.error(
            { err: persistenceError, runId, originalError: error },
            "Failed to persist Team Run execution failure",
          );
        }
      })
      .finally(() => {
        this.executions.delete(runId);
        void this.clearTerminationRequestIfTerminal(runId);
      });
    this.executions.set(runId, execution);
  }

  private async executeRun(runId: string): Promise<void> {
    let run = await this.requireRun(runId);
    if (run.supervision) {
      await this.executeSupervisedRun(runId);
      return;
    }
    if (run.state.status === "queued") {
      const reason = this.requestedTerminationReason(run);
      if (reason) {
        await this.finishTermination(runId, reason);
        return;
      }
      run = await this.beginFirstStep(runId);
    }

    let previousFinalResponse: string | undefined;
    while (!isTerminalTeamRunStatus(run.state.status)) {
      const active = findActiveStep(run);
      if (!active) {
        throw new Error(`Active Team Run ${run.id} has no active workflow step`);
      }
      const inputArtifacts =
        run.assignmentId === undefined
          ? undefined
          : await resolveTeamStepInputArtifacts(
              this.requireAssignmentRepository(),
              run,
              active.index,
            );
      const outcome = await this.executeStep(
        run,
        active,
        run.assignmentId === undefined ? previousFinalResponse : undefined,
        inputArtifacts,
      );
      if (outcome.status === "terminal") return;
      if (run.assignmentId === undefined) previousFinalResponse = outcome.finalResponse;
      run = await this.requireRun(runId);
    }
  }

  private async executeSupervisedRun(runId: string): Promise<void> {
    let run = requireSupervisedRun(await this.requireRun(runId));
    while (!isTerminalTeamRunStatus(run.state.status)) {
      if (run.supervision.phase === "awaiting_human") return;
      const active = findActiveStep(run);
      if (active?.step.snapshot.supervision?.kind === "worker") {
        const inputArtifacts = await resolveTeamStepInputArtifacts(
          this.requireAssignmentRepository(),
          run,
          active.index,
        );
        const workItemId = active.step.snapshot.supervision.workItemId;
        const outcome = await this.executeStep(run, active, undefined, inputArtifacts, {
          supervisionContext: composeSupervisedWorkerContext(run, workItemId),
        });
        if (outcome.status === "terminal") return;
        run = requireSupervisedRun(await this.requireRun(runId));
        continue;
      }
      if (active) {
        throw new Error(`Supervised Team Run ${run.id} has an unexpected active step`);
      }
      run = await this.executeSupervisorDecision(runId, run);
    }
  }

  private async executeSupervisorDecision(
    runId: string,
    boundary: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  ): Promise<PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision }> {
    const decisionId = randomUUID();
    const started = requireSupervisedRun(
      await this.repository.beginSupervisionTurn({
        runId,
        expectedSupervisionRevision: boundary.supervision.revision,
        decisionId,
      }),
    );
    const supervisor = findActiveStep(started);
    if (supervisor?.step.snapshot.supervision?.kind !== "supervisor") {
      throw new Error(`Supervised Team Run ${started.id} did not persist its supervisor turn`);
    }
    const workspace = await revalidateTeamRunStep(
      {
        workspaceRegistry: this.workspaceRegistry,
        providerCatalog: this.providerCatalog,
        featureCatalog: this.agentManager,
      },
      started.workspace,
      supervisor.step.snapshot,
    );
    if (supervisor.step.state.status === "creating") {
      await this.createStepAgent(
        started,
        supervisor.index,
        buildTeamAgentCreateInput({
          run: started,
          step: supervisor.step.snapshot,
          plannedAgentId: started.supervision.supervisor.agentId,
          workspace,
        }),
      );
    }
    const ready = requireSupervisedRun(await this.requireRun(runId));
    const readySupervisor = requireActiveSupervisor(ready);
    const dispatchArtifactIssues = await this.resolveSupervisorDispatchArtifactIssues(ready);
    const schema = createTeamSupervisorActionSchema(ready, { dispatchArtifactIssues });
    const prompt = composeTeamSupervisorPrompt(ready, { dispatchArtifactIssues });
    const structuredPrompt = buildStructuredAgentResponsePrompt({
      prompt,
      schema,
      schemaName: "TeamSupervisorAction",
    });
    if (Buffer.byteLength(structuredPrompt, "utf8") > TEAM_SUPERVISOR_PROMPT_MAX_BYTES) {
      throw new Error(
        `Team supervisor prompt exceeds ${TEAM_SUPERVISOR_PROMPT_MAX_BYTES} UTF-8 bytes`,
      );
    }
    const action = await getStructuredAgentResponse<TeamSupervisorAction>({
      caller: (attemptPrompt) =>
        this.runSupervisorPrompt(
          runId,
          readySupervisor.index,
          readySupervisor.agentId,
          attemptPrompt,
        ),
      prompt,
      schema,
      maxRetries: 2,
      schemaName: "TeamSupervisorAction",
    });
    return this.commitSupervisorAction(
      runId,
      decisionId,
      action,
      canContinueTeamSupervision(ready, { dispatchArtifactIssues }),
    );
  }

  private async resolveSupervisorDispatchArtifactIssues(
    run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  ): Promise<ReadonlyMap<string, string>> {
    const issues = new Map<string, string>();
    const workItem = run.supervision.workItems.find((candidate, index, workItems) => {
      return (
        candidate.status === "planned" &&
        workItems.slice(0, index).every((predecessor) => predecessor.status === "succeeded")
      );
    });
    if (!workItem) return issues;
    try {
      const inputArtifactIds = resolveSupervisedWorkItemInputArtifactIds(run, workItem.id);
      await resolveTeamRunArtifactInputs(this.requireAssignmentRepository(), run, inputArtifactIds);
    } catch (error) {
      issues.set(workItem.id, boundedError(errorMessage(error)));
    }
    return issues;
  }

  private async commitSupervisorAction(
    runId: string,
    decisionId: string,
    action: TeamSupervisorAction,
    allowContinueAfterEscalation: boolean,
  ): Promise<PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision }> {
    const beforeCommit = requireSupervisedRun(await this.requireRun(runId));
    const attemptId = action.kind === "dispatch" ? randomUUID() : null;
    const decision = normalizeTeamSupervisorDecision({
      run: beforeCommit,
      action,
      decisionId,
      attemptId,
    });
    const workerAgentId = action.kind === "dispatch" ? this.createAgentId() : null;
    const humanRequestId = action.kind === "escalate" ? randomUUID() : null;
    return requireSupervisedRun(
      await this.repository.commitSupervisionDecision(
        {
          runId,
          expectedSupervisionRevision: beforeCommit.supervision.revision,
          decision,
        },
        (current, context) =>
          buildTeamSupervisionDecisionUpdate({
            run: current,
            action,
            context,
            workerAgentId,
            humanRequestId,
            allowContinueAfterEscalation,
          }),
      ),
    );
  }

  private async beginFirstStep(runId: string): Promise<PersistedTeamRunRecord> {
    const plannedAgentId = this.createAgentId();
    const timestamp = this.timestamp();
    return this.repository.updateRun(runId, (run) => {
      if (run.state.status !== "queued") return unchangedRun(run);
      const firstStep = run.steps[0];
      if (!firstStep) throw new Error(`Team Run ${run.id} has no workflow steps`);
      return {
        steps: replaceStep(run.steps, 0, {
          ...firstStep,
          state: { status: "creating", plannedAgentId, startedAt: timestamp },
        }),
        state: { status: "running", startedAt: timestamp },
      };
    });
  }

  private async executeStep(
    run: PersistedTeamRunRecord,
    active: ActiveStep,
    previousFinalResponse: string | undefined,
    inputArtifacts: PersistedAssignmentArtifactRecord[] | undefined,
    options: { supervisionContext?: string } = {},
  ): Promise<StepExecutionOutcome> {
    if (active.step.state.status === "stopping" && active.step.state.agentId === null) {
      await this.finishTermination(run.id, this.terminationRequests.get(run.id) ?? "cancel");
      return { status: "terminal" };
    }
    if (!("plannedAgentId" in active.step.state)) {
      throw new Error(`Team Run ${run.id} active step has no planned agent ID`);
    }

    const events = executeTeamStep(
      {
        workspaceRegistry: this.workspaceRegistry,
        providerCatalog: this.providerCatalog,
        featureCatalog: this.agentManager,
        createAgent: (input) => this.createStepAgent(run, active.index, input),
        agentManager: this.agentManager,
      },
      {
        run,
        stepId: active.step.snapshot.stepId,
        plannedAgentId: active.step.state.plannedAgentId,
        previousFinalResponse,
        inputArtifacts,
        supervisionContext: options.supervisionContext,
      },
    )[Symbol.asyncIterator]();
    let agentCreated = false;
    let streamAdmitted = false;
    let completionObserved = false;

    try {
      for (;;) {
        if (agentCreated && !streamAdmitted) {
          const stopped = await this.stopBeforeStreamAdmission(run.id, events);
          if (stopped) return { status: "terminal" };
          streamAdmitted = true;
        }

        const next = await events.next();
        if (next.done) {
          throw new Error(
            `Team step ${active.step.snapshot.stepId} ended without a terminal event`,
          );
        }
        completionObserved ||= next.value.type === "turn_completed";
        const handled = await this.handleStepEvent(run.id, active.index, next.value);
        agentCreated ||= handled.agentCreated;
        if (!handled.outcome) continue;
        await events.return?.(undefined);
        return handled.outcome;
      }
    } catch (error) {
      await events.return?.(undefined);
      if (completionObserved) throw error;
      return this.handleStepExecutionError(run.id, active.index, error);
    }
  }

  private async runSupervisorPrompt(
    runId: string,
    stepIndex: number,
    agentId: string,
    prompt: string,
  ): Promise<string> {
    const events = await this.withWorkspaceOperation(
      (await this.requireRun(runId)).workspace.workspaceId,
      async () => {
        const current = await this.requireRun(runId);
        const reason = this.requestedTerminationReason(current);
        if (isTerminalTeamRunStatus(current.state.status) || reason) {
          if (!isTerminalTeamRunStatus(current.state.status)) {
            await this.finishTermination(runId, reason ?? "cancel");
          }
          return null;
        }
        const step = current.steps[stepIndex];
        if (
          step?.snapshot.supervision?.kind !== "supervisor" ||
          !("agentId" in step.state) ||
          step.state.agentId !== agentId
        ) {
          return null;
        }
        // AgentManager registers the pending foreground run synchronously here. Keep that
        // registration under the Workspace fence so cancellation cannot observe an idle agent.
        return this.agentManager.streamAgent(agentId, prompt);
      },
    );
    if (!events) throw new Error(`Supervisor prompt for Team Run ${runId} was not admitted`);

    const pendingPermissions = new Set<string>();
    for await (const event of events) {
      if (event.type === "permission_requested") {
        pendingPermissions.add(event.request.id);
        await this.persistPermissionState(runId, stepIndex, {
          ...event,
          pendingPermissionCount: pendingPermissions.size,
        });
        continue;
      }
      if (event.type === "permission_resolved") {
        pendingPermissions.delete(event.requestId);
        await this.persistPermissionState(runId, stepIndex, {
          ...event,
          pendingPermissionCount: pendingPermissions.size,
        });
        continue;
      }
      if (event.type === "turn_completed") {
        return (await this.agentManager.getLastAssistantMessage(agentId)) ?? "";
      }
      if (event.type === "turn_failed") throw new Error(event.error);
      if (event.type === "turn_canceled") {
        await this.finishTermination(runId, this.terminationRequests.get(runId) ?? "cancel");
        throw new Error(`Supervisor turn for Team Run ${runId} was canceled`);
      }
    }
    throw new TeamStepStreamEndedError(agentId);
  }

  private async stopBeforeStreamAdmission(
    runId: string,
    events: AsyncGenerator<TeamStepExecutionEvent, void, void>,
  ): Promise<boolean> {
    const current = await this.requireRun(runId);
    return this.withWorkspaceOperation(current.workspace.workspaceId, async () => {
      const latest = await this.requireRun(runId);
      const isTerminal = isTerminalTeamRunStatus(latest.state.status);
      const reason = this.requestedTerminationReason(latest);
      if (!isTerminal && !reason) return false;
      await events.return(undefined);
      if (latest.state.status === "stop_failed") return true;
      if (!isTerminal) await this.finishTermination(runId, reason ?? "cancel");
      return true;
    });
  }

  private async handleStepEvent(
    runId: string,
    stepIndex: number,
    event: TeamStepExecutionEvent,
  ): Promise<StepEventResult> {
    if (event.type === "agent_created") {
      const persisted = await this.requireRun(runId);
      const outcome = isTerminalTeamRunStatus(persisted.state.status)
        ? { status: "terminal" as const }
        : null;
      return { agentCreated: true, outcome };
    }
    if (event.type === "permission_requested" || event.type === "permission_resolved") {
      await this.persistPermissionState(runId, stepIndex, event);
      return { agentCreated: false, outcome: null };
    }
    if (event.type === "turn_completed") {
      const outcome = await this.completeStep(
        runId,
        stepIndex,
        event.finalResponse,
        event.turnId ?? null,
      );
      return { agentCreated: false, outcome };
    }
    if (event.type === "turn_failed") {
      const current = await this.requireRun(runId);
      if (current.steps[stepIndex]?.snapshot.supervision?.kind === "worker") {
        await this.settleSupervisedWorkerFailure(runId, stepIndex, event.error);
        return { agentCreated: false, outcome: { status: "next" } };
      }
      await this.failRun(runId, event.error);
      return { agentCreated: false, outcome: { status: "terminal" } };
    }
    if (event.type === "turn_canceled") {
      await this.finishTermination(runId, this.terminationRequests.get(runId) ?? "cancel");
      return { agentCreated: false, outcome: { status: "terminal" } };
    }
    return { agentCreated: false, outcome: null };
  }

  private async handleStepExecutionError(
    runId: string,
    stepIndex: number,
    error: unknown,
  ): Promise<StepExecutionOutcome> {
    const current = await this.requireRun(runId);
    if (isTerminalTeamRunStatus(current.state.status)) return { status: "terminal" };
    const requestedReason = this.requestedTerminationReason(current);
    if (requestedReason) {
      await this.finishTermination(runId, requestedReason);
      return { status: "terminal" };
    }
    if (isWorkspaceFailure(error)) {
      this.requestTermination(runId, "workspace");
      await this.finishTermination(runId, "workspace");
      return { status: "terminal" };
    }
    const step = current.steps[stepIndex];
    if (
      step?.snapshot.supervision?.kind === "worker" &&
      ACTIVE_STEP_STATUSES.has(step.state.status)
    ) {
      await this.settleSupervisedWorkerFailure(runId, stepIndex, errorMessage(error));
      return { status: "next" };
    }
    throw error;
  }

  private async persistAgentCreated(
    runId: string,
    stepIndex: number,
    agentId: string,
  ): Promise<PersistedTeamRunRecord> {
    return this.repository.updateRun(runId, (run) => {
      if (isTerminalTeamRunStatus(run.state.status)) return unchangedRun(run);
      const step = run.steps[stepIndex];
      if (!step || !("plannedAgentId" in step.state)) return unchangedRun(run);
      const startedAt = step.state.startedAt;
      if (step.state.status === "stopping") {
        return {
          steps: replaceStep(run.steps, stepIndex, {
            ...step,
            state: { ...step.state, agentId },
          }),
          state: run.state,
        };
      }
      if (step.state.status !== "creating") return unchangedRun(run);
      return {
        steps: replaceStep(run.steps, stepIndex, {
          ...step,
          state: {
            status: "running",
            plannedAgentId: step.state.plannedAgentId,
            agentId,
            startedAt,
          },
        }),
        state: { status: "running", startedAt: requireRunStartedAt(run) },
      };
    });
  }

  private async createStepAgent(
    run: PersistedTeamRunRecord,
    stepIndex: number,
    input: CreateAgentFromMcpInput,
  ): Promise<unknown> {
    const agentId = input.agentId;
    if (!agentId) throw new Error(`Team Run ${run.id} step has no planned agent ID`);
    return this.withWorkspaceOperation(run.workspace.workspaceId, async () => {
      const current = await this.requireRun(run.id);
      const reason = this.requestedTerminationReason(current);
      if (isTerminalTeamRunStatus(current.state.status) || reason) {
        if (!isTerminalTeamRunStatus(current.state.status)) {
          await this.finishTermination(run.id, reason ?? "cancel");
        }
        throw new Error(`Team Run ${run.id} stopped before agent creation`);
      }
      const created = await this.createAgent(input);
      let persisted: PersistedTeamRunRecord;
      try {
        persisted = await this.persistAgentCreated(run.id, stepIndex, agentId);
      } catch (error) {
        await this.cancelUnadmittedAgent(run.id, agentId);
        throw error;
      }
      if (
        isTerminalTeamRunStatus(persisted.state.status) ||
        this.requestedTerminationReason(persisted)
      ) {
        await this.cancelUnadmittedAgent(run.id, agentId);
      }
      return created;
    });
  }

  private async cancelUnadmittedAgent(runId: string, agentId: string): Promise<void> {
    try {
      const cancellation = await this.cancelAgentRun(agentId);
      if (cancellation.status === "refused") {
        this.logger.error(
          { runId, agentId },
          "Cancellation was refused for an unadmitted Team step agent",
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error, runId, agentId },
        "Failed to cancel an unadmitted Team step agent",
      );
    }
  }

  private async persistPermissionState(
    runId: string,
    stepIndex: number,
    event: Extract<
      TeamStepExecutionEvent,
      { type: "permission_requested" | "permission_resolved" }
    >,
  ): Promise<void> {
    await this.repository.updateRun(runId, (run) => {
      if (isTerminalTeamRunStatus(run.state.status)) return unchangedRun(run);
      if (run.state.status === "stopping" || run.state.status === "stop_failed") {
        return unchangedRun(run);
      }
      const step = run.steps[stepIndex];
      if (!step || !("agentId" in step.state) || step.state.agentId === null) {
        return unchangedRun(run);
      }
      const isWaiting = event.pendingPermissionCount > 0;
      const state: PersistedTeamRunStepState = {
        status: isWaiting ? "waiting_for_permission" : "running",
        plannedAgentId: step.state.plannedAgentId,
        agentId: step.state.agentId,
        startedAt: step.state.startedAt,
      };
      const runState: PersistedTeamRunState = {
        status: isWaiting ? "waiting_for_permission" : "running",
        startedAt: requireRunStartedAt(run),
      };
      return {
        steps: replaceStep(run.steps, stepIndex, { ...step, state }),
        state: runState,
      };
    });
  }

  private async completeStep(
    runId: string,
    stepIndex: number,
    finalResponse: string,
    turnId: string | null,
  ): Promise<StepExecutionOutcome> {
    const current = await this.requireRun(runId);
    return this.withWorkspaceOperation(current.workspace.workspaceId, async () => {
      const beforeCompletion = await this.requireRun(runId);
      if (isTerminalTeamRunStatus(beforeCompletion.state.status)) {
        return { status: "terminal" };
      }
      const currentStep = beforeCompletion.steps[stepIndex];
      if (!currentStep || currentStep.state.status === "succeeded") {
        return { status: "terminal" };
      }
      if (!("agentId" in currentStep.state) || currentStep.state.agentId === null) {
        return { status: "terminal" };
      }
      const requestedReason = this.requestedTerminationReason(beforeCompletion);
      if (requestedReason) {
        const timestamp = this.timestamp();
        await this.repository.updateRun(runId, (run) =>
          terminationRunUpdate(run, requestedReason, timestamp),
        );
        return { status: "terminal" };
      }
      if (beforeCompletion.assignmentId !== undefined) {
        await materializeTeamStepArtifact(this.requireAssignmentRepository(), {
          run: beforeCompletion,
          stepIndex,
          finalResponse,
          turnId,
        });
      }
      if (currentStep.snapshot.supervision?.kind === "worker" && beforeCompletion.supervision) {
        await this.repository.settleSupervisedWorker({
          runId,
          expectedSupervisionRevision: beforeCompletion.supervision.revision,
          attemptId: currentStep.snapshot.supervision.attemptId,
          outcome: { status: "succeeded" },
        });
        return { status: "next" };
      }

      let advanced = false;
      const timestamp = this.timestamp();
      await this.repository.updateRun(runId, (run) => {
        if (isTerminalTeamRunStatus(run.state.status)) return unchangedRun(run);
        const step = run.steps[stepIndex];
        if (!step || !("plannedAgentId" in step.state) || !("agentId" in step.state)) {
          return unchangedRun(run);
        }
        if (step.state.agentId === null) return unchangedRun(run);
        const reason = this.requestedTerminationReason(run);
        if (reason) {
          return terminationRunUpdate(run, reason, timestamp);
        }
        const succeededStep: TeamRunStep = {
          ...step,
          state: {
            status: "succeeded",
            plannedAgentId: step.state.plannedAgentId,
            agentId: step.state.agentId,
            startedAt: step.state.startedAt,
            endedAt: timestamp,
          },
        };
        const nextStep = run.steps[stepIndex + 1];
        if (!nextStep) {
          return {
            steps: replaceStep(run.steps, stepIndex, succeededStep),
            state: {
              status: "succeeded",
              startedAt: requireRunStartedAt(run),
              endedAt: timestamp,
            },
          };
        }

        advanced = true;
        const nextPlannedAgentId = this.createAgentId();
        const steps = replaceStep(run.steps, stepIndex, succeededStep);
        steps[stepIndex + 1] = {
          ...nextStep,
          state: {
            status: "creating",
            plannedAgentId: nextPlannedAgentId,
            startedAt: timestamp,
          },
        };
        return {
          steps,
          state: { status: "running", startedAt: requireRunStartedAt(run) },
        };
      });
      if (!advanced) return { status: "terminal" };
      return beforeCompletion.assignmentId === undefined
        ? { status: "next", finalResponse }
        : { status: "next" };
    });
  }

  private async settleSupervisedWorkerFailure(
    runId: string,
    stepIndex: number,
    error: string,
  ): Promise<PersistedTeamRunRecord> {
    const current = requireSupervisedRun(await this.requireRun(runId));
    const step = current.steps[stepIndex];
    if (step?.snapshot.supervision?.kind !== "worker") {
      throw new Error(`Team Run ${runId} step ${stepIndex} is not a supervised worker`);
    }
    return this.repository.settleSupervisedWorker({
      runId,
      expectedSupervisionRevision: current.supervision.revision,
      attemptId: step.snapshot.supervision.attemptId,
      outcome: { status: "failed", error: boundedError(error) },
    });
  }

  private async stopActiveRun(
    runId: string,
    waitForExecution = true,
  ): Promise<PersistedTeamRunRecord> {
    const reason = this.terminationRequests.get(runId) ?? "cancel";
    const timestamp = this.timestamp();
    let agentIdToCancel: string | null = null;
    let shouldCancel = false;
    let updated = await this.repository.updateRun(runId, (run) => {
      if (isTerminalTeamRunStatus(run.state.status)) return unchangedRun(run);
      const active = findActiveStep(run);
      if (!active) {
        return { steps: run.steps, state: terminalBoundaryState(run, reason, timestamp) };
      }
      if (active.step.state.status === "stopping") return unchangedRun(run);
      if (!("plannedAgentId" in active.step.state)) return unchangedRun(run);
      agentIdToCancel = "agentId" in active.step.state ? active.step.state.agentId : null;
      shouldCancel = agentIdToCancel !== null;
      const state: PersistedTeamRunStepState = {
        status: "stopping",
        plannedAgentId: active.step.state.plannedAgentId,
        agentId: agentIdToCancel,
        startedAt: active.step.state.startedAt,
        stopRequestedAt: timestamp,
      };
      return {
        steps: replaceStep(run.steps, active.index, { ...active.step, state }),
        state: {
          status: "stopping",
          startedAt: requireRunStartedAt(run),
          stopRequestedAt: timestamp,
        },
      };
    });

    if (!shouldCancel || agentIdToCancel === null) return updated;
    const cancellation = await this.cancelAgentRun(agentIdToCancel);
    if (cancellation.status === "refused") {
      const error = boundedError(`Cancellation was refused for Team step agent ${agentIdToCancel}`);
      updated = await this.repository.updateRun(runId, (run) => {
        if (isTerminalTeamRunStatus(run.state.status)) return unchangedRun(run);
        const active = findActiveStep(run);
        if (!active || active.step.state.status !== "stopping") return unchangedRun(run);
        const agentId = active.step.state.agentId;
        if (agentId === null) return unchangedRun(run);
        return {
          steps: replaceStep(run.steps, active.index, {
            ...active.step,
            state: {
              status: "stop_failed",
              plannedAgentId: active.step.state.plannedAgentId,
              agentId,
              startedAt: active.step.state.startedAt,
              stopRequestedAt: active.step.state.stopRequestedAt,
              error,
            },
          }),
          state: {
            status: "stop_failed",
            startedAt: requireRunStartedAt(run),
            stopRequestedAt: active.step.state.stopRequestedAt,
            error,
          },
        };
      });
      return updated;
    }

    if (reason !== "shutdown" && waitForExecution) await this.executions.get(runId);
    return this.requireRun(runId);
  }

  private async finishTermination(
    runId: string,
    reason: TeamRunTerminationReason,
    detail?: string,
  ): Promise<PersistedTeamRunRecord> {
    const timestamp = this.timestamp();
    return this.repository.updateRun(runId, (run) => {
      if (isTerminalTeamRunStatus(run.state.status)) return unchangedRun(run);
      return terminationRunUpdate(run, reason, timestamp, detail);
    });
  }

  private async failRun(runId: string, error: unknown): Promise<PersistedTeamRunRecord> {
    const message = boundedError(errorMessage(error));
    const current = await this.requireRun(runId);
    return this.withWorkspaceOperation(current.workspace.workspaceId, async () => {
      const timestamp = this.timestamp();
      return this.repository.updateRun(runId, (run) => {
        if (isTerminalTeamRunStatus(run.state.status)) return unchangedRun(run);
        const requestedReason = this.requestedTerminationReason(run);
        if (requestedReason) return terminationRunUpdate(run, requestedReason, timestamp);
        const active = findActiveStep(run);
        const startedAt = runStartedAt(run) ?? timestamp;
        if (!active || !("plannedAgentId" in active.step.state)) {
          return {
            steps: run.steps,
            state: { status: "failed", startedAt, endedAt: timestamp, error: message },
          };
        }
        const agentId = "agentId" in active.step.state ? active.step.state.agentId : null;
        const failedStep: TeamRunStep = {
          ...active.step,
          state: {
            status: "failed",
            plannedAgentId: active.step.state.plannedAgentId,
            agentId,
            startedAt: active.step.state.startedAt,
            endedAt: timestamp,
            error: message,
          },
        };
        return {
          steps: replaceStep(run.steps, active.index, failedStep),
          state: { status: "failed", startedAt, endedAt: timestamp, error: message },
        };
      });
    });
  }

  private requestTermination(runId: string, reason: TeamRunTerminationReason): void {
    const current = this.terminationRequests.get(runId);
    if (current === "shutdown") return;
    if (reason === "shutdown" || current === undefined || reason === "workspace") {
      this.terminationRequests.set(runId, reason);
    }
  }

  private requestedTerminationReason(
    run: PersistedTeamRunRecord,
  ): TeamRunTerminationReason | undefined {
    const fences = this.workspaceTerminationFences.get(run.workspace.workspaceId);
    const hasCommittedWorkspaceTermination = [...(fences?.values() ?? [])].some(
      (fence) => fence.status === "committed",
    );
    return (
      this.terminationRequests.get(run.id) ??
      (hasCommittedWorkspaceTermination ? "workspace" : undefined)
    );
  }

  private async handleWorkspaceMutation(mutation: WorkspaceMutation): Promise<void> {
    if (mutation.kind !== "archive" && mutation.kind !== "remove") return;
    const run = await this.repository.getActiveRunForWorkspace(mutation.workspaceId);
    if (!run) return;
    this.requestTermination(run.id, "workspace");
    await this.stopActiveRun(run.id);
  }

  private handleWorkspaceTerminationBoundary(
    boundary: WorkspaceTerminationBoundary,
  ): void | Promise<void> {
    if (boundary.phase === "start") {
      let resolveOutcome!: (outcome: WorkspaceTerminationOutcome) => void;
      const outcome = new Promise<WorkspaceTerminationOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      let resolveDetached!: () => void;
      const detached = new Promise<void>((resolve) => {
        resolveDetached = resolve;
      });
      const fence: WorkspaceTerminationFence = {
        status: "pending",
        outcome,
        resolveOutcome,
        detached,
        resolveDetached,
        isDetached: false,
        releaseOperation: null,
      };
      const fences = this.workspaceTerminationFences.get(boundary.workspaceId) ?? new Map();
      fences.set(boundary.boundaryId, fence);
      this.workspaceTerminationFences.set(boundary.workspaceId, fences);
      const acquisition = this.acquireWorkspaceOperation(boundary.workspaceId).then((release) => {
        if (fence.isDetached) release();
        else fence.releaseOperation = release;
        return undefined;
      });
      return Promise.race([acquisition, detached]);
    }
    const fences = this.workspaceTerminationFences.get(boundary.workspaceId);
    const fence = fences?.get(boundary.boundaryId);
    if (!fence) return;
    if (boundary.phase === "commit") {
      fence.status = "committed";
      fence.resolveOutcome("committed");
      fence.releaseOperation?.();
      fence.releaseOperation = null;
      return;
    }
    if (fence.status === "pending") fence.resolveOutcome("failed");
    fence.releaseOperation?.();
    fences?.delete(boundary.boundaryId);
    if (fences?.size === 0) this.workspaceTerminationFences.delete(boundary.workspaceId);
  }

  private async requireRun(runId: string): Promise<PersistedTeamRunRecord> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new TeamRunNotFoundError(runId);
    return run;
  }

  private async clearTerminationRequestIfTerminal(runId: string): Promise<void> {
    try {
      const run = await this.repository.getRun(runId);
      if (run && isTerminalTeamRunStatus(run.state.status)) {
        this.terminationRequests.delete(runId);
      }
    } catch (error) {
      this.logger.error({ err: error, runId }, "Failed to inspect completed Team Run");
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function findActiveStep(run: PersistedTeamRunRecord): ActiveStep | null {
  const index = run.steps.findIndex((step) => ACTIVE_STEP_STATUSES.has(step.state.status));
  const step = run.steps[index];
  return step ? { index, step } : null;
}

function requireSupervisedRun(
  run: PersistedTeamRunRecord,
): PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision } {
  if (!run.supervision) throw new Error(`Team Run ${run.id} is not supervised`);
  return run as PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision };
}

function requireActiveSupervisor(run: PersistedTeamRunRecord): {
  index: number;
  agentId: string;
} {
  const active = findActiveStep(run);
  if (
    active?.step.snapshot.supervision?.kind !== "supervisor" ||
    !("agentId" in active.step.state) ||
    active.step.state.agentId === null
  ) {
    throw new Error(`Supervised Team Run ${run.id} has no admitted supervisor agent`);
  }
  return { index: active.index, agentId: active.step.state.agentId };
}

function replaceStep(steps: TeamRunStep[], index: number, step: TeamRunStep): TeamRunStep[] {
  const next = steps.slice();
  next[index] = step;
  return next;
}

function unchangedRun(run: PersistedTeamRunRecord) {
  return { steps: run.steps, state: run.state };
}

function runStartedAt(run: PersistedTeamRunRecord): string | null {
  return "startedAt" in run.state ? run.state.startedAt : null;
}

function requireRunStartedAt(run: PersistedTeamRunRecord): string {
  const startedAt = runStartedAt(run);
  if (startedAt === null) throw new Error(`Team Run ${run.id} has no start timestamp`);
  return startedAt;
}

function terminalBoundaryState(
  run: PersistedTeamRunRecord,
  reason: TeamRunTerminationReason,
  endedAt: string,
  detail?: string,
): PersistedTeamRunState {
  const startedAt = runStartedAt(run);
  if (reason === "shutdown") {
    return {
      status: "interrupted",
      startedAt,
      endedAt,
      error: boundedError(detail ?? "Daemon interrupted Team Run execution"),
    };
  }
  return { status: "canceled", startedAt, endedAt };
}

function terminationRunUpdate(
  run: PersistedTeamRunRecord,
  reason: TeamRunTerminationReason,
  endedAt: string,
  detail?: string,
): TeamRunUpdate {
  const active = findActiveStep(run);
  if (!active) {
    return { steps: run.steps, state: terminalBoundaryState(run, reason, endedAt, detail) };
  }
  if (!("plannedAgentId" in active.step.state)) return unchangedRun(run);
  return {
    steps: replaceStep(run.steps, active.index, {
      ...active.step,
      state: terminationStepState(active.step, reason, endedAt, detail),
    }),
    state: terminalBoundaryState(run, reason, endedAt, detail),
  };
}

function terminationStepState(
  step: TeamRunStep,
  reason: TeamRunTerminationReason,
  endedAt: string,
  detail?: string,
): PersistedTeamRunStepState {
  if (!("plannedAgentId" in step.state)) {
    throw new Error(`Team step ${step.snapshot.stepId} has no planned agent ID`);
  }
  const agentId = "agentId" in step.state ? step.state.agentId : null;
  if (reason === "shutdown") {
    return {
      status: "interrupted",
      plannedAgentId: step.state.plannedAgentId,
      agentId,
      startedAt: step.state.startedAt,
      endedAt,
      error: boundedError(detail ?? "Daemon interrupted Team Run execution"),
    };
  }
  return {
    status: "canceled",
    plannedAgentId: step.state.plannedAgentId,
    agentId,
    startedAt: step.state.startedAt,
    endedAt,
  };
}

function boundedError(message: string): string {
  const normalized = message.trim() || "Unknown Team Run failure";
  return normalized.slice(0, TEAM_ERROR_MAX_CHARS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWorkspaceFailure(error: unknown): boolean {
  if (!(error instanceof TeamExecutionPreflightError)) return false;
  return error.issues.every((issue) => issue.kind !== "launch_unavailable");
}
