import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AgentRunCancellationResult } from "../agent/agent-manager.js";
import type { CreateAgentFromMcpInput } from "../agent/create-agent/create.js";
import type { WorkspaceMutation, WorkspaceTerminationBoundary } from "../workspace-registry.js";
import {
  executeTeamStep,
  preflightTeamRun,
  TeamExecutionPreflightError,
  type TeamAgentProfileConfigStore,
  type TeamAgentStream,
  type TeamFeatureCatalog,
  type TeamProviderCatalog,
  type TeamStepExecutionEvent,
  type TeamWorkspaceStore,
} from "./execution.js";
import {
  isTerminalTeamRunStatus,
  TEAM_ERROR_MAX_CHARS,
  type PersistedTeamRunRecord,
  type PersistedTeamRunState,
  type PersistedTeamRunStepState,
  type TeamRunStepStatus,
} from "./model.js";
import {
  TeamNotFoundError,
  TeamRepository,
  TeamRevisionConflictError,
  TeamRunNotFoundError,
  type TeamRunUpdate,
} from "./repository.js";

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
    listener: (boundary: WorkspaceTerminationBoundary) => void,
  ): () => void;
}

export interface StartTeamRunInput {
  teamId: string;
  expectedRevision: number;
  idempotencyKey: string;
  objective: string;
  workspaceId: string;
}

export interface TeamRunServiceOptions {
  repository: TeamRepository;
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

export class TeamRunServiceShuttingDownError extends Error {
  readonly code = "team_run_service_shutting_down";

  constructor() {
    super("Team Runs cannot start while the daemon is shutting down");
    this.name = "TeamRunServiceShuttingDownError";
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

export class TeamRunService {
  private readonly repository: TeamRepository;
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
  private readonly workspaceTerminationFences = new Map<string, number>();
  private admissionTail: Promise<unknown> = Promise.resolve();
  private unsubscribeWorkspaceMutations: (() => void) | null = null;
  private unsubscribeWorkspaceTerminationBoundaries: (() => void) | null = null;
  private acceptingStarts = false;
  private initialized = false;

  constructor(options: TeamRunServiceOptions) {
    this.repository = options.repository;
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

  async startRun(input: StartTeamRunInput): Promise<PersistedTeamRunRecord> {
    const existing = await this.repository.getRunByIdempotency(input.teamId, input.idempotencyKey);
    if (existing) return existing;
    this.requireAcceptingStarts();

    const definition = await this.repository.getDefinition(input.teamId);
    if (!definition) throw new TeamNotFoundError(input.teamId);
    if (definition.revision !== input.expectedRevision) {
      throw new TeamRevisionConflictError(
        input.teamId,
        input.expectedRevision,
        definition.revision,
      );
    }
    const accepted = await preflightTeamRun(
      {
        workspaceRegistry: this.workspaceRegistry,
        providerCatalog: this.providerCatalog,
        featureCatalog: this.agentManager,
        daemonConfigStore: this.daemonConfigStore,
      },
      { definition, workspaceId: input.workspaceId },
    );
    return this.serializeAdmission(async () => {
      const acceptedExisting = await this.repository.getRunByIdempotency(
        input.teamId,
        input.idempotencyKey,
      );
      if (acceptedExisting) return acceptedExisting;
      this.requireAcceptingStarts();

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
    });
  }

  async cancelRun(runId: string): Promise<PersistedTeamRunRecord> {
    const run = await this.requireRun(runId);
    if (isTerminalTeamRunStatus(run.state.status)) return run;
    this.requestTermination(runId, "cancel");
    return this.stopActiveRun(runId);
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
    this.unsubscribeWorkspaceTerminationBoundaries?.();
    this.unsubscribeWorkspaceTerminationBoundaries = null;

    const activeRuns = await this.repository.listActiveRuns();
    for (const run of activeRuns) this.requestTermination(run.id, "shutdown");
    await Promise.allSettled(activeRuns.map((run) => this.stopActiveRun(run.id)));

    const unsettledRuns = await this.repository.listActiveRuns();
    for (const run of unsettledRuns) {
      await this.finishTermination(run.id, "shutdown", "Daemon shut down during Team Run");
    }
  }

  private requireAcceptingStarts(): void {
    if (!this.acceptingStarts) throw new TeamRunServiceShuttingDownError();
  }

  private serializeAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.admissionTail.then(operation, operation);
    this.admissionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
      const outcome = await this.executeStep(run, active, previousFinalResponse);
      if (outcome.status === "terminal") return;
      previousFinalResponse = outcome.finalResponse;
      run = await this.requireRun(runId);
    }
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
        createAgent: this.createAgent,
        agentManager: this.agentManager,
      },
      {
        run,
        stepId: active.step.snapshot.stepId,
        plannedAgentId: active.step.state.plannedAgentId,
        previousFinalResponse,
      },
    )[Symbol.asyncIterator]();
    let agentCreated = false;
    let streamAdmitted = false;

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
        const handled = await this.handleStepEvent(run.id, active.index, next.value);
        agentCreated ||= handled.agentCreated;
        if (!handled.outcome) continue;
        await events.return?.(undefined);
        return handled.outcome;
      }
    } catch (error) {
      await events.return?.(undefined);
      return this.handleStepExecutionError(run.id, error);
    }
  }

  private async stopBeforeStreamAdmission(
    runId: string,
    events: AsyncGenerator<TeamStepExecutionEvent, void, void>,
  ): Promise<boolean> {
    const current = await this.requireRun(runId);
    const isTerminal = isTerminalTeamRunStatus(current.state.status);
    const reason = this.requestedTerminationReason(current);
    if (!isTerminal && !reason) return false;
    await events.return(undefined);
    if (!isTerminal) await this.finishTermination(runId, reason ?? "cancel");
    return true;
  }

  private async handleStepEvent(
    runId: string,
    stepIndex: number,
    event: TeamStepExecutionEvent,
  ): Promise<StepEventResult> {
    if (event.type === "agent_created") {
      const persisted = await this.persistAgentCreated(runId, stepIndex, event.agentId);
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
      const outcome = await this.completeStep(runId, stepIndex, event.finalResponse);
      return { agentCreated: false, outcome };
    }
    if (event.type === "turn_failed") {
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
    error: unknown,
  ): Promise<StepExecutionOutcome> {
    const current = await this.requireRun(runId);
    if (isTerminalTeamRunStatus(current.state.status)) return { status: "terminal" };
    const requestedReason = this.requestedTerminationReason(current);
    if (requestedReason) {
      await this.finishTermination(runId, requestedReason);
      return { status: "terminal" };
    }
    if (!isWorkspaceFailure(error)) throw error;
    this.requestTermination(runId, "workspace");
    await this.finishTermination(runId, "workspace");
    return { status: "terminal" };
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
  ): Promise<StepExecutionOutcome> {
    const nextPlannedAgentId = this.createAgentId();
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
    return advanced ? { status: "next", finalResponse } : { status: "terminal" };
  }

  private async stopActiveRun(runId: string): Promise<PersistedTeamRunRecord> {
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

    if (reason !== "shutdown") await this.executions.get(runId);
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
    const timestamp = this.timestamp();
    const message = boundedError(errorMessage(error));
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
    return (
      this.terminationRequests.get(run.id) ??
      (this.workspaceTerminationFences.has(run.workspace.workspaceId) ? "workspace" : undefined)
    );
  }

  private async handleWorkspaceMutation(mutation: WorkspaceMutation): Promise<void> {
    if (mutation.kind !== "archive" && mutation.kind !== "remove") return;
    const run = await this.repository.getActiveRunForWorkspace(mutation.workspaceId);
    if (!run) return;
    this.requestTermination(run.id, "workspace");
    await this.stopActiveRun(run.id);
  }

  private handleWorkspaceTerminationBoundary(boundary: WorkspaceTerminationBoundary): void {
    const current = this.workspaceTerminationFences.get(boundary.workspaceId) ?? 0;
    if (boundary.phase === "start") {
      this.workspaceTerminationFences.set(boundary.workspaceId, current + 1);
      return;
    }
    if (current <= 1) this.workspaceTerminationFences.delete(boundary.workspaceId);
    else this.workspaceTerminationFences.set(boundary.workspaceId, current - 1);
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
