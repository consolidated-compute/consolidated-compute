import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";
import equal from "fast-deep-equal";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { generateAssignmentArtifactId } from "../assignment/model.js";
import type { AssignmentRepository } from "../assignment/repository.js";
import {
  AssignmentNotFoundError,
  AssignmentRevisionConflictError,
  AssignmentStateConflictError,
  AssignmentPersistenceBoundaryError,
} from "../assignment/repository.js";
import {
  hostPersistenceBoundaryKey,
  serializeHostPersistenceMutation,
} from "../persistence-mutation.js";
import {
  generateTeamId,
  generateTeamRunId,
  PersistedTeamDefinitionSchema,
  PersistedTeamEntityIdSchema,
  PersistedTeamRunRecordSchema,
  type PersistedTeamDefinition,
  type PersistedTeamRunRecord,
  type PersistedTeamRunSupervision,
  isActiveTeamRunStatus,
} from "./model.js";

export const TEAM_RUN_PAGE_DEFAULT_LIMIT = 50;
export const TEAM_RUN_PAGE_MAX_LIMIT = 100;

export type CreateTeamDefinitionInput = Pick<
  PersistedTeamDefinition,
  "name" | "instructions" | "roles" | "workflow"
>;

export type TeamDefinitionPatch = Partial<CreateTeamDefinitionInput>;

export interface UpdateTeamDefinitionInput {
  teamId: string;
  expectedRevision: number;
  patch: TeamDefinitionPatch;
}

export interface DeleteTeamDefinitionInput {
  teamId: string;
  expectedRevision: number;
}

export interface CreateTeamRunInput extends Pick<
  PersistedTeamRunRecord,
  "teamId" | "idempotencyKey" | "objective" | "workspace" | "steps"
> {
  expectedRevision: number;
}

export interface CreateAssignmentTeamRunInput extends Pick<
  PersistedTeamRunRecord,
  "teamId" | "idempotencyKey" | "workspace" | "steps"
> {
  expectedRevision: number;
  assignmentId: string;
  expectedAssignmentRevision: number;
}

export interface CreateSupervisedAssignmentTeamRunInput extends Omit<
  CreateAssignmentTeamRunInput,
  "steps"
> {
  supervision: PersistedTeamRunSupervision;
}

export type TeamRunAdmissionIdentity =
  | {
      kind: "objective";
      teamId: string;
      expectedRevision: number;
      idempotencyKey: string;
      objective: string;
      workspaceId: string;
    }
  | {
      kind: "assignment";
      teamId: string;
      expectedRevision: number;
      idempotencyKey: string;
      assignmentId: string;
      expectedAssignmentRevision: number;
      workspaceId: string;
      supervisorRoleId?: string;
    };

export type TeamRunUpdate = Pick<PersistedTeamRunRecord, "steps" | "state">;
export type TeamRunUpdater = (
  run: PersistedTeamRunRecord,
) => TeamRunUpdate | Promise<TeamRunUpdate>;

export type TeamRunSupervisionDecision = PersistedTeamRunSupervision["decisions"][number];
export interface CommitTeamRunSupervisionDecisionInput {
  runId: string;
  expectedSupervisionRevision: number;
  decision: TeamRunSupervisionDecision;
}
export type TeamRunSupervisionUpdate = Pick<
  PersistedTeamRunRecord,
  "steps" | "state" | "supervision"
> & { supervision: PersistedTeamRunSupervision };
export type TeamRunSupervisionUpdater = (
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
) => TeamRunSupervisionUpdate | Promise<TeamRunSupervisionUpdate>;

export interface ListTeamRunsInput {
  teamId?: string;
  cursor?: string;
  limit?: number;
}

export interface TeamRunPage {
  runs: PersistedTeamRunRecord[];
  nextCursor: string | null;
  issues: TeamRepositoryFileIssue[];
}

export type TeamRepositoryCollection = "definitions" | "runs";
export type TeamRepositoryFileIssueKind = "unknown_file" | "invalid_record";

export interface TeamRepositoryFileIssue {
  collection: TeamRepositoryCollection;
  fileName: string;
  kind: TeamRepositoryFileIssueKind;
  message: string;
}

export interface TeamDefinitionList {
  definitions: PersistedTeamDefinition[];
  issues: TeamRepositoryFileIssue[];
}

export type TeamRepositoryChange =
  | { type: "definition_created"; definition: PersistedTeamDefinition }
  | { type: "definition_updated"; definition: PersistedTeamDefinition }
  | { type: "definition_deleted"; teamId: string; revision: number }
  | { type: "run_created"; run: PersistedTeamRunRecord }
  | { type: "run_updated"; run: PersistedTeamRunRecord };

export type TeamRepositoryListener = (change: TeamRepositoryChange) => void;

export interface TeamRepositoryOptions {
  paseoHome: string;
  now?: () => Date;
  writeJson?: (filePath: string, value: unknown) => Promise<void>;
  generateArtifactId?: () => string;
}

interface CollectionRead<TRecord> {
  records: TRecord[];
  issues: TeamRepositoryFileIssue[];
}

const TeamRunCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.string(),
    teamId: z.string().nullable(),
  })
  .strict();

type TeamRunCursor = z.infer<typeof TeamRunCursorSchema>;

export class TeamNotFoundError extends Error {
  readonly code = "team_not_found";

  constructor(readonly teamId: string) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}

export class TeamRevisionConflictError extends Error {
  readonly code = "team_revision_conflict";

  constructor(
    readonly teamId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Team revision conflict for ${teamId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "TeamRevisionConflictError";
  }
}

export class TeamHasActiveRunError extends Error {
  readonly code = "team_has_active_run";

  constructor(
    readonly teamId: string,
    readonly runId: string,
  ) {
    super(`Team ${teamId} has an active run: ${runId}`);
    this.name = "TeamHasActiveRunError";
  }
}

export class TeamWorkspaceHasActiveRunError extends Error {
  readonly code = "team_workspace_has_active_run";

  constructor(
    readonly workspaceId: string,
    readonly runId: string,
  ) {
    super(`Workspace ${workspaceId} already has an active Team Run: ${runId}`);
    this.name = "TeamWorkspaceHasActiveRunError";
  }
}

export class TeamAssignmentHasActiveRunError extends Error {
  readonly code = "team_assignment_has_active_run";

  constructor(
    readonly assignmentId: string,
    readonly runId: string,
  ) {
    super(`Assignment ${assignmentId} already has an active Team Run: ${runId}`);
    this.name = "TeamAssignmentHasActiveRunError";
  }
}

export class TeamRunIdempotencyConflictError extends Error {
  readonly code = "team_run_idempotency_conflict";

  constructor(
    readonly teamId: string,
    readonly idempotencyKey: string,
    readonly runId: string,
  ) {
    super(
      `Team Run idempotency key ${idempotencyKey} for ${teamId} is already bound to different admission inputs`,
    );
    this.name = "TeamRunIdempotencyConflictError";
  }
}

export class TeamRunNotFoundError extends Error {
  readonly code = "team_run_not_found";

  constructor(readonly runId: string) {
    super(`Team Run not found: ${runId}`);
    this.name = "TeamRunNotFoundError";
  }
}

export class TeamRunNotSupervisedError extends Error {
  readonly code = "team_run_not_supervised";

  constructor(readonly runId: string) {
    super(`Team Run is not supervised: ${runId}`);
    this.name = "TeamRunNotSupervisedError";
  }
}

export class TeamRunSupervisionRevisionConflictError extends Error {
  readonly code = "team_run_supervision_revision_conflict";

  constructor(
    readonly runId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Team Run supervision revision conflict for ${runId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "TeamRunSupervisionRevisionConflictError";
  }
}

export class TeamRunSupervisionActionConflictError extends Error {
  readonly code = "team_run_supervision_action_conflict";

  constructor(
    readonly runId: string,
    readonly actionId: string,
  ) {
    super(`Supervisor action ${actionId} for Team Run ${runId} conflicts with durable state`);
    this.name = "TeamRunSupervisionActionConflictError";
  }
}

export class TeamRunPageError extends Error {
  readonly code = "invalid_team_run_page";

  constructor(message: string) {
    super(message);
    this.name = "TeamRunPageError";
  }
}

export class TeamRepositoryIdError extends Error {
  readonly code = "invalid_team_repository_id";

  constructor(readonly entityId: string) {
    super("Team repository IDs must be safe entity identifiers");
    this.name = "TeamRepositoryIdError";
  }
}

export class TeamStorageCorruptError extends Error {
  readonly code = "team_storage_corrupt";

  constructor(readonly issues: TeamRepositoryFileIssue[]) {
    super("Team storage contains unreadable records");
    this.name = "TeamStorageCorruptError";
  }
}

export class TeamRepository {
  private readonly definitionsDir: string;
  private readonly runsDir: string;
  private readonly now: () => Date;
  private readonly writeJson: (filePath: string, value: unknown) => Promise<void>;
  private readonly generateArtifactId: () => string;
  private readonly listeners = new Set<TeamRepositoryListener>();
  readonly persistenceBoundaryKey: string;

  constructor(options: TeamRepositoryOptions) {
    const teamsDir = resolve(options.paseoHome, "teams");
    this.definitionsDir = join(teamsDir, "definitions");
    this.runsDir = join(teamsDir, "runs");
    this.persistenceBoundaryKey = hostPersistenceBoundaryKey(options.paseoHome);
    this.now = options.now ?? (() => new Date());
    this.writeJson = options.writeJson ?? writeJsonFileAtomic;
    this.generateArtifactId = options.generateArtifactId ?? generateAssignmentArtifactId;
  }

  subscribe(listener: TeamRepositoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listDefinitions(): Promise<TeamDefinitionList> {
    const { records, issues } = await this.readCollection(
      this.definitionsDir,
      "definitions",
      PersistedTeamDefinitionSchema,
    );
    records.sort(compareDefinitionsNewestFirst);
    return { definitions: records, issues };
  }

  async getDefinition(teamId: string): Promise<PersistedTeamDefinition | null> {
    return this.readRecord(
      this.definitionPath(teamId),
      teamId,
      "definitions",
      PersistedTeamDefinitionSchema,
    );
  }

  async listRuns(input: ListTeamRunsInput = {}): Promise<TeamRunPage> {
    if (input.teamId !== undefined) requireRepositoryId(input.teamId);
    const limit = normalizeRunPageLimit(input.limit);
    const { records, issues } = await this.readRuns();
    const teamRuns = input.teamId ? records.filter((run) => run.teamId === input.teamId) : records;
    teamRuns.sort(compareRunsNewestFirst);
    const cursor = input.cursor ? decodeRunCursor(input.cursor, input.teamId ?? null) : null;
    const remainingRuns = cursor
      ? teamRuns.filter((run) => isRunAfterCursor(run, cursor))
      : teamRuns;
    const hasNextPage = remainingRuns.length > limit;
    const runs = remainingRuns.slice(0, limit);
    const lastRun = runs[runs.length - 1];
    return {
      runs,
      nextCursor: hasNextPage && lastRun ? encodeRunCursor(lastRun, input.teamId ?? null) : null,
      issues,
    };
  }

  async getRun(runId: string): Promise<PersistedTeamRunRecord | null> {
    return this.readRecord(this.runPath(runId), runId, "runs", PersistedTeamRunRecordSchema);
  }

  async getRunByIdempotency(
    teamId: string,
    idempotencyKey: string,
  ): Promise<PersistedTeamRunRecord | null> {
    requireRepositoryId(teamId);
    const collection = await this.readRuns();
    this.requireHealthyCollection(collection.issues);
    return (
      collection.records.find(
        (run) => run.teamId === teamId && run.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async getRunByAdmissionIdentity(
    identity: TeamRunAdmissionIdentity,
  ): Promise<PersistedTeamRunRecord | null> {
    const existing = await this.getRunByIdempotency(identity.teamId, identity.idempotencyKey);
    if (!existing) return null;
    this.requireMatchingAdmissionIdentity(existing, identity);
    return existing;
  }

  async listActiveRuns(): Promise<PersistedTeamRunRecord[]> {
    const collection = await this.readRuns();
    this.requireHealthyCollection(collection.issues);
    return collection.records.filter((run) => isActiveTeamRunStatus(run.state.status));
  }

  async getActiveRunForWorkspace(workspaceId: string): Promise<PersistedTeamRunRecord | null> {
    const collection = await this.readRuns();
    this.requireHealthyCollection(collection.issues);
    return (
      collection.records.find(
        (run) =>
          run.workspace.workspaceId === workspaceId && isActiveTeamRunStatus(run.state.status),
      ) ?? null
    );
  }

  async getActiveRunForAssignment(assignmentId: string): Promise<PersistedTeamRunRecord | null> {
    const collection = await this.readRuns();
    this.requireHealthyCollection(collection.issues);
    return (
      collection.records.find(
        (run) => run.assignmentId === assignmentId && isActiveTeamRunStatus(run.state.status),
      ) ?? null
    );
  }

  async createDefinition(input: CreateTeamDefinitionInput): Promise<PersistedTeamDefinition> {
    return this.serializeMutation(async () => {
      let teamId = generateTeamId();
      while (await this.getDefinition(teamId)) {
        teamId = generateTeamId();
      }
      const timestamp = this.now().toISOString();
      const definition = PersistedTeamDefinitionSchema.parse({
        ...input,
        id: teamId,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.writeJson(this.definitionPath(teamId), definition);
      this.publish({ type: "definition_created", definition });
      return definition;
    });
  }

  async updateDefinition(input: UpdateTeamDefinitionInput): Promise<PersistedTeamDefinition> {
    return this.serializeMutation(async () => {
      const current = await this.requireDefinition(input.teamId);
      this.requireRevision(current, input.expectedRevision);
      const definition = PersistedTeamDefinitionSchema.parse({
        ...current,
        ...input.patch,
        id: current.id,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: this.now().toISOString(),
      });
      await this.writeJson(this.definitionPath(current.id), definition);
      this.publish({ type: "definition_updated", definition });
      return definition;
    });
  }

  async createRun(input: CreateTeamRunInput): Promise<PersistedTeamRunRecord> {
    return this.serializeMutation(async () => {
      const collection = await this.readRuns();
      const existing = collection.records.find(
        (run) => run.teamId === input.teamId && run.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        this.requireMatchingAdmissionIdentity(existing, {
          kind: "objective",
          teamId: input.teamId,
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          objective: input.objective,
          workspaceId: input.workspace.workspaceId,
        });
        return existing;
      }
      this.requireHealthyCollection(collection.issues);

      const workspaceRun = collection.records.find(
        (run) =>
          run.workspace.workspaceId === input.workspace.workspaceId &&
          isActiveTeamRunStatus(run.state.status),
      );
      if (workspaceRun) {
        throw new TeamWorkspaceHasActiveRunError(input.workspace.workspaceId, workspaceRun.id);
      }

      const definition = await this.requireDefinition(input.teamId);
      this.requireRevision(definition, input.expectedRevision);
      let runId = generateTeamRunId();
      const existingIds = new Set(collection.records.map((run) => run.id));
      while (existingIds.has(runId)) {
        runId = generateTeamRunId();
      }
      const timestamp = this.now().toISOString();
      const run = PersistedTeamRunRecordSchema.parse({
        teamId: input.teamId,
        idempotencyKey: input.idempotencyKey,
        objective: input.objective,
        workspace: input.workspace,
        steps: input.steps,
        id: runId,
        teamRevision: definition.revision,
        teamSnapshot: definition,
        state: { status: "queued" },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.writeJson(this.runPath(run.id), run);
      this.publish({ type: "run_created", run });
      return run;
    });
  }

  async createAssignmentRun(
    input: CreateAssignmentTeamRunInput,
    assignments: AssignmentRepository,
  ): Promise<PersistedTeamRunRecord> {
    return this.createAssignmentRunRecord(input, assignments);
  }

  async createSupervisedAssignmentRun(
    input: CreateSupervisedAssignmentTeamRunInput,
    assignments: AssignmentRepository,
  ): Promise<PersistedTeamRunRecord> {
    return this.createAssignmentRunRecord({ ...input, steps: [] }, assignments);
  }

  private async createAssignmentRunRecord(
    input: CreateAssignmentTeamRunInput & { supervision?: PersistedTeamRunSupervision },
    assignments: AssignmentRepository,
  ): Promise<PersistedTeamRunRecord> {
    if (assignments.persistenceBoundaryKey !== this.persistenceBoundaryKey) {
      throw new AssignmentPersistenceBoundaryError();
    }
    return this.serializeMutation(async () => {
      const identity: TeamRunAdmissionIdentity = {
        kind: "assignment",
        teamId: input.teamId,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        assignmentId: input.assignmentId,
        expectedAssignmentRevision: input.expectedAssignmentRevision,
        workspaceId: input.workspace.workspaceId,
        ...(input.supervision ? { supervisorRoleId: input.supervision.supervisor.roleId } : {}),
      };
      const collection = await this.readRuns();
      const existing = collection.records.find(
        (run) => run.teamId === input.teamId && run.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        this.requireMatchingAdmissionIdentity(existing, identity);
        return existing;
      }
      this.requireHealthyCollection(collection.issues);

      const workspaceRun = collection.records.find(
        (run) =>
          run.workspace.workspaceId === input.workspace.workspaceId &&
          isActiveTeamRunStatus(run.state.status),
      );
      if (workspaceRun) {
        throw new TeamWorkspaceHasActiveRunError(input.workspace.workspaceId, workspaceRun.id);
      }
      const assignmentRun = collection.records.find(
        (run) => run.assignmentId === input.assignmentId && isActiveTeamRunStatus(run.state.status),
      );
      if (assignmentRun) {
        throw new TeamAssignmentHasActiveRunError(input.assignmentId, assignmentRun.id);
      }

      const definition = await this.requireDefinition(input.teamId);
      this.requireRevision(definition, input.expectedRevision);
      const assignment = await assignments.getAssignment(input.assignmentId);
      if (!assignment) throw new AssignmentNotFoundError(input.assignmentId);
      if (assignment.revision !== input.expectedAssignmentRevision) {
        throw new AssignmentRevisionConflictError(
          assignment.id,
          input.expectedAssignmentRevision,
          assignment.revision,
        );
      }
      if (assignment.state.status !== "open") {
        throw new AssignmentStateConflictError(assignment.id, assignment.state.status);
      }

      const existingRunIds = new Set(collection.records.map((run) => run.id));
      let runId = generateTeamRunId();
      while (existingRunIds.has(runId)) {
        runId = generateTeamRunId();
      }
      const steps = input.supervision
        ? []
        : this.createAssignmentArtifactPlan(input.steps, collection.records);
      const timestamp = this.now().toISOString();
      const supervision = input.supervision
        ? { ...input.supervision, updatedAt: timestamp }
        : undefined;
      const run = PersistedTeamRunRecordSchema.parse({
        id: runId,
        teamId: input.teamId,
        teamRevision: definition.revision,
        idempotencyKey: input.idempotencyKey,
        teamSnapshot: definition,
        objective: assignment.objective,
        assignmentId: assignment.id,
        assignmentRevision: assignment.revision,
        assignmentSnapshot: assignment,
        workspace: input.workspace,
        steps,
        ...(supervision ? { supervision } : {}),
        state: { status: "queued" },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.writeJson(this.runPath(run.id), run);
      this.publish({ type: "run_created", run });
      return run;
    });
  }

  async updateRun(runId: string, updater: TeamRunUpdater): Promise<PersistedTeamRunRecord> {
    return this.serializeMutation(async () => {
      const current = await this.requireRun(runId);
      const preserved = PersistedTeamRunRecordSchema.parse(current);
      const update = await updater(current);
      const updatedAt = this.now().toISOString();
      const supervisionPhase = terminalSupervisionPhase(update.state.status);
      const supervision =
        preserved.supervision && supervisionPhase
          ? terminalizeSupervision(preserved.supervision, supervisionPhase, updatedAt)
          : preserved.supervision;
      const run = PersistedTeamRunRecordSchema.parse({
        ...preserved,
        ...update,
        id: preserved.id,
        teamId: preserved.teamId,
        teamRevision: preserved.teamRevision,
        idempotencyKey: preserved.idempotencyKey,
        teamSnapshot: preserved.teamSnapshot,
        objective: preserved.objective,
        workspace: preserved.workspace,
        steps: update.steps.map((step, index) => ({
          snapshot: preserved.steps[index]?.snapshot,
          state: step.state,
        })),
        ...(supervision ? { supervision } : {}),
        createdAt: preserved.createdAt,
        updatedAt,
      });
      await this.writeJson(this.runPath(run.id), run);
      this.publish({ type: "run_updated", run });
      return run;
    });
  }

  async commitSupervisionDecision(
    input: CommitTeamRunSupervisionDecisionInput,
    updater: TeamRunSupervisionUpdater,
  ): Promise<PersistedTeamRunRecord> {
    return this.serializeMutation(async () => {
      const current = await this.requireRun(input.runId);
      if (!current.supervision) throw new TeamRunNotSupervisedError(input.runId);
      const existingDecision = current.supervision.decisions.find(
        (decision) => decision.actionId === input.decision.actionId,
      );
      if (existingDecision) {
        if (equal(existingDecision, input.decision)) return current;
        throw new TeamRunSupervisionActionConflictError(input.runId, input.decision.actionId);
      }
      if (current.supervision.revision !== input.expectedSupervisionRevision) {
        throw new TeamRunSupervisionRevisionConflictError(
          input.runId,
          input.expectedSupervisionRevision,
          current.supervision.revision,
        );
      }

      const preserved = PersistedTeamRunRecordSchema.parse(current);
      const supervisedCurrent = PersistedTeamRunRecordSchema.parse(
        current,
      ) as PersistedTeamRunRecord & {
        supervision: PersistedTeamRunSupervision;
      };
      const update = await updater(supervisedCurrent);
      const expectedDecisions = [...preserved.supervision!.decisions, input.decision];
      const immutableSnapshotMatches =
        equal(update.supervision.supervisor, preserved.supervision!.supervisor) &&
        equal(update.supervision.workerTemplates, preserved.supervision!.workerTemplates) &&
        equal(update.supervision.limits, preserved.supervision!.limits);
      const appendMatches = equal(update.supervision.decisions, expectedDecisions);
      const revisionMatches = update.supervision.revision === input.expectedSupervisionRevision + 1;
      if (!immutableSnapshotMatches || !appendMatches || !revisionMatches) {
        throw new TeamRunSupervisionActionConflictError(input.runId, input.decision.actionId);
      }
      for (const [index, step] of preserved.steps.entries()) {
        if (!equal(step.snapshot, update.steps[index]?.snapshot)) {
          throw new TeamRunSupervisionActionConflictError(input.runId, input.decision.actionId);
        }
      }

      const run = PersistedTeamRunRecordSchema.parse({
        ...preserved,
        steps: update.steps,
        state: update.state,
        supervision: update.supervision,
        updatedAt: this.now().toISOString(),
      });
      await this.writeJson(this.runPath(run.id), run);
      this.publish({ type: "run_updated", run });
      return run;
    });
  }

  async deleteDefinition(input: DeleteTeamDefinitionInput): Promise<void> {
    await this.serializeMutation(async () => {
      const current = await this.requireDefinition(input.teamId);
      this.requireRevision(current, input.expectedRevision);
      const runs = await this.readRuns();
      this.requireHealthyCollection(runs.issues);
      const activeRun = runs.records.find(
        (run) => run.teamId === current.id && isActiveTeamRunStatus(run.state.status),
      );
      if (activeRun) throw new TeamHasActiveRunError(current.id, activeRun.id);
      await rm(this.definitionPath(current.id));
      this.publish({
        type: "definition_deleted",
        teamId: current.id,
        revision: current.revision,
      });
    });
  }

  private createAssignmentArtifactPlan(
    steps: PersistedTeamRunRecord["steps"],
    existingRuns: PersistedTeamRunRecord[],
  ): PersistedTeamRunRecord["steps"] {
    const reservedArtifactIds = new Set(
      existingRuns.flatMap((run) =>
        run.steps.flatMap((step) =>
          step.snapshot.outputArtifact ? [step.snapshot.outputArtifact.id] : [],
        ),
      ),
    );
    let precedingOutputId: string | null = null;
    return steps.map((step) => {
      let outputArtifactId = this.generateArtifactId();
      while (reservedArtifactIds.has(outputArtifactId)) {
        outputArtifactId = this.generateArtifactId();
      }
      reservedArtifactIds.add(outputArtifactId);
      const inputArtifactIds = precedingOutputId === null ? [] : [precedingOutputId];
      precedingOutputId = outputArtifactId;
      return {
        ...step,
        snapshot: {
          ...step.snapshot,
          inputArtifactIds,
          outputArtifact: {
            id: outputArtifactId,
            kind: "team_step_output",
            title: `${step.snapshot.roleName} output`,
            mediaType: "text/markdown",
          },
        },
      };
    });
  }

  private requireMatchingAdmissionIdentity(
    run: PersistedTeamRunRecord,
    identity: TeamRunAdmissionIdentity,
  ): void {
    const commonMatches =
      run.teamRevision === identity.expectedRevision &&
      run.workspace.workspaceId === identity.workspaceId;
    const kindMatches =
      identity.kind === "objective"
        ? run.assignmentId === undefined && run.objective === identity.objective
        : run.assignmentId === identity.assignmentId &&
          run.assignmentRevision === identity.expectedAssignmentRevision &&
          run.supervision?.supervisor.roleId === identity.supervisorRoleId;
    if (commonMatches && kindMatches) return;
    throw new TeamRunIdempotencyConflictError(identity.teamId, identity.idempotencyKey, run.id);
  }

  private definitionPath(teamId: string): string {
    requireRepositoryId(teamId);
    return join(this.definitionsDir, `${teamId}.json`);
  }

  private runPath(runId: string): string {
    requireRepositoryId(runId);
    return join(this.runsDir, `${runId}.json`);
  }

  private readRuns(): Promise<CollectionRead<PersistedTeamRunRecord>> {
    return this.readCollection(this.runsDir, "runs", PersistedTeamRunRecordSchema);
  }

  private async requireDefinition(teamId: string): Promise<PersistedTeamDefinition> {
    const definition = await this.getDefinition(teamId);
    if (!definition) throw new TeamNotFoundError(teamId);
    return definition;
  }

  private async requireRun(runId: string): Promise<PersistedTeamRunRecord> {
    const run = await this.getRun(runId);
    if (!run) throw new TeamRunNotFoundError(runId);
    return run;
  }

  private requireHealthyCollection(issues: TeamRepositoryFileIssue[]): void {
    const invalidRecords = issues.filter((issue) => issue.kind === "invalid_record");
    if (invalidRecords.length > 0) throw new TeamStorageCorruptError(invalidRecords);
  }

  private requireRevision(definition: PersistedTeamDefinition, expectedRevision: number): void {
    if (definition.revision === expectedRevision) return;
    throw new TeamRevisionConflictError(definition.id, expectedRevision, definition.revision);
  }

  private async readCollection<TRecord extends { id: string }>(
    dir: string,
    collection: TeamRepositoryCollection,
    schema: z.ZodType<TRecord>,
  ): Promise<CollectionRead<TRecord>> {
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const records: TRecord[] = [];
    const issues: TeamRepositoryFileIssue[] = [];
    for (const entry of entries) {
      const isJsonFile = entry.isFile() && entry.name.endsWith(".json");
      if (!isJsonFile) {
        issues.push({
          collection,
          fileName: entry.name,
          kind: "unknown_file",
          message: "Expected one JSON record per file",
        });
        continue;
      }
      try {
        const record = await this.requireRecord(join(dir, entry.name), schema);
        if (entry.name !== `${record.id}.json`) {
          issues.push({
            collection,
            fileName: entry.name,
            kind: "invalid_record",
            message: `Record ID ${record.id} does not match its file name`,
          });
          continue;
        }
        records.push(record);
      } catch (error) {
        issues.push({
          collection,
          fileName: entry.name,
          kind: "invalid_record",
          message: errorMessage(error),
        });
      }
    }
    return { records, issues };
  }

  private async readRecord<TRecord extends { id: string }>(
    filePath: string,
    expectedId: string,
    collection: TeamRepositoryCollection,
    schema: z.ZodType<TRecord>,
  ): Promise<TRecord | null> {
    try {
      const record = await this.requireRecord(filePath, schema);
      if (record.id !== expectedId) {
        throw new Error(`Record ID ${record.id} does not match ${expectedId}`);
      }
      return record;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw new TeamStorageCorruptError([
        {
          collection,
          fileName: `${expectedId}.json`,
          kind: "invalid_record",
          message: errorMessage(error),
        },
      ]);
    }
  }

  private async requireRecord<TRecord>(
    filePath: string,
    schema: z.ZodType<TRecord>,
  ): Promise<TRecord> {
    const content = await readFile(filePath, "utf8");
    return schema.parse(JSON.parse(content));
  }

  private async serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    return serializeHostPersistenceMutation(this.persistenceBoundaryKey, mutation);
  }

  private publish(change: TeamRepositoryChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        const warning = error instanceof Error ? error : new Error(String(error));
        process.emitWarning(warning);
      }
    }
  }
}

function compareDefinitionsNewestFirst(
  left: PersistedTeamDefinition,
  right: PersistedTeamDefinition,
): number {
  const createdAtOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return createdAtOrder || right.id.localeCompare(left.id);
}

function terminalSupervisionPhase(
  status: PersistedTeamRunRecord["state"]["status"],
): PersistedTeamRunSupervision["phase"] | null {
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  if (status === "interrupted") return "interrupted";
  return null;
}

function terminalizeSupervision(
  supervision: PersistedTeamRunSupervision,
  phase: PersistedTeamRunSupervision["phase"],
  updatedAt: string,
): PersistedTeamRunSupervision {
  const humanRequest = supervision.humanRequest;
  const isPendingRequest = humanRequest && !humanRequest.resolution && !humanRequest.retirement;
  const retirementReason =
    phase === "failed" || phase === "canceled" || phase === "interrupted" ? phase : null;
  const workItems = retirementReason
    ? supervision.workItems.map((workItem) =>
        workItem.status === "planned" || workItem.status === "active"
          ? { ...workItem, status: retirementReason }
          : workItem,
      )
    : supervision.workItems;
  return {
    ...supervision,
    revision: supervision.revision + 1,
    phase,
    workItems,
    ...(isPendingRequest && retirementReason
      ? {
          humanRequest: {
            ...humanRequest,
            retirement: { reason: retirementReason, retiredAt: updatedAt },
          },
        }
      : {}),
    updatedAt,
  };
}

function compareRunsNewestFirst(
  left: PersistedTeamRunRecord,
  right: PersistedTeamRunRecord,
): number {
  const createdAtOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return createdAtOrder || right.id.localeCompare(left.id);
}

function normalizeRunPageLimit(limit: number | undefined): number {
  if (limit === undefined) return TEAM_RUN_PAGE_DEFAULT_LIMIT;
  const isValid = Number.isInteger(limit) && limit > 0 && limit <= TEAM_RUN_PAGE_MAX_LIMIT;
  if (!isValid) {
    throw new TeamRunPageError(
      `Team Run page limit must be between 1 and ${TEAM_RUN_PAGE_MAX_LIMIT}`,
    );
  }
  return limit;
}

function encodeRunCursor(run: PersistedTeamRunRecord, teamId: string | null): string {
  const cursor: TeamRunCursor = { createdAt: run.createdAt, id: run.id, teamId };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeRunCursor(token: string, teamId: string | null): TeamRunCursor {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const cursor = TeamRunCursorSchema.parse(JSON.parse(decoded));
    if (cursor.teamId !== teamId) {
      throw new TeamRunPageError("Team Run cursor does not match the Team filter");
    }
    return cursor;
  } catch (error) {
    if (error instanceof TeamRunPageError) throw error;
    throw new TeamRunPageError("Invalid Team Run cursor");
  }
}

function isRunAfterCursor(run: PersistedTeamRunRecord, cursor: TeamRunCursor): boolean {
  const runCreatedAt = Date.parse(run.createdAt);
  const cursorCreatedAt = Date.parse(cursor.createdAt);
  if (runCreatedAt < cursorCreatedAt) return true;
  if (runCreatedAt > cursorCreatedAt) return false;
  return run.id < cursor.id;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireRepositoryId(entityId: string): void {
  const parsed = PersistedTeamEntityIdSchema.safeParse(entityId);
  if (!parsed.success) throw new TeamRepositoryIdError(entityId);
}
