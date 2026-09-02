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
  canTransitionTeamRun,
  canTransitionTeamRunStep,
  generateTeamSupervisionEventId,
  generateTeamId,
  generateTeamRunId,
  TEAM_ERROR_MAX_CHARS,
  PersistedTeamDefinitionSchema,
  PersistedTeamEntityIdSchema,
  PersistedTeamRunRecordSchema,
  type PersistedTeamDefinition,
  type PersistedTeamRunRecord,
  type PersistedTeamRunSupervision,
  isActiveTeamRunStatus,
  isActiveTeamRunStepStatus,
  isTerminalTeamRunStepStatus,
  isTeamRunSupervisionDecisionBoundary,
} from "./model.js";
import { requireSupervisionNativeDelegationDisabled } from "./supervision.js";
import {
  resolveSupervisedTeamAgentAuthority,
  type SupervisedTeamAgentAuthority,
} from "./agent-authority.js";

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
export type TeamRunSupervisionEvent = NonNullable<PersistedTeamRunSupervision["events"]>[number];
type TeamRunSupervisionCommitDecision = TeamRunSupervisionDecision extends infer Decision
  ? Decision extends { kind: "dispatch" }
    ? Omit<Decision, "inputArtifactIds"> & { inputArtifactIds: string[] }
    : Decision
  : never;
type WithoutRequiredDecisionTimestamp<T> = T extends TeamRunSupervisionCommitDecision
  ? Omit<T, "createdAt"> & { createdAt?: string }
  : never;
export type TeamRunSupervisionDecisionCandidate =
  WithoutRequiredDecisionTimestamp<TeamRunSupervisionCommitDecision>;
export interface CommitTeamRunSupervisionDecisionInput {
  runId: string;
  expectedSupervisionRevision: number;
  decision: TeamRunSupervisionDecisionCandidate;
}
export type TeamRunSupervisionUpdate = Pick<
  PersistedTeamRunRecord,
  "steps" | "state" | "supervision"
> & { supervision: PersistedTeamRunSupervision };
export type TeamRunSupervisionUpdater = (
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  context: TeamRunSupervisionDecisionCommitContext,
) => TeamRunSupervisionUpdate | Promise<TeamRunSupervisionUpdate>;

export interface TeamRunSupervisionDecisionCommitContext {
  outputArtifactId: string | null;
  committedAt: string;
  decision: TeamRunSupervisionCommitDecision;
}

export interface BeginTeamRunSupervisionTurnInput {
  runId: string;
  expectedSupervisionRevision: number;
  decisionId: string;
}

export interface ResolveTeamRunSupervisionHumanRequestInput {
  runId: string;
  requestId: string;
  expectedRequestRevision: number;
  actionId: string;
  note: string | null;
  idempotencyKey: string;
}

export interface SettleTeamRunSupervisedWorkerInput {
  runId: string;
  expectedSupervisionRevision: number;
  attemptId: string;
  outcome: { status: "succeeded" } | { status: "failed"; error: string };
}

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

export interface ListTeamRunSupervisionEventsInput {
  runId: string;
  cursor?: string;
  limit?: number;
}

export interface TeamRunSupervisionEventPage {
  events: NonNullable<PersistedTeamRunSupervision["events"]>;
  nextCursor: string | null;
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
  generateSupervisionEventId?: () => string;
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

const TeamRunSupervisionEventCursorSchema = z
  .object({
    runId: PersistedTeamEntityIdSchema,
    sequence: z.number().int().positive(),
  })
  .strict();

type TeamRunSupervisionEventCursor = z.infer<typeof TeamRunSupervisionEventCursorSchema>;

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

export class TeamRunSupervisionHumanRequestConflictError extends Error {
  readonly code = "team_run_supervision_human_request_conflict";

  constructor(
    readonly runId: string,
    readonly requestId: string,
  ) {
    super(`Human request ${requestId} for Team Run ${runId} conflicts with durable state`);
    this.name = "TeamRunSupervisionHumanRequestConflictError";
  }
}

export class TeamRunSupervisionHumanRequestRevisionConflictError extends Error {
  readonly code = "team_run_supervision_human_request_revision_conflict";

  constructor(
    readonly runId: string,
    readonly requestId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Human request revision conflict for ${requestId} in Team Run ${runId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "TeamRunSupervisionHumanRequestRevisionConflictError";
  }
}

export class TeamRunPageError extends Error {
  readonly code = "invalid_team_run_page";

  constructor(message: string) {
    super(message);
    this.name = "TeamRunPageError";
  }
}

export class TeamRunSupervisionEventPageError extends Error {
  readonly code = "invalid_team_supervision_event_page";

  constructor(message: string) {
    super(message);
    this.name = "TeamRunSupervisionEventPageError";
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
  private readonly generateSupervisionEventId: () => string;
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
    this.generateSupervisionEventId =
      options.generateSupervisionEventId ?? generateTeamSupervisionEventId;
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

  async listSupervisionEvents(
    input: ListTeamRunSupervisionEventsInput,
  ): Promise<TeamRunSupervisionEventPage> {
    requireRepositoryId(input.runId);
    const limit = normalizeSupervisionEventPageLimit(input.limit);
    const run = await this.requireRun(input.runId);
    if (!run.supervision) throw new TeamRunNotSupervisedError(input.runId);
    const cursor = input.cursor ? decodeSupervisionEventCursor(input.cursor, input.runId) : null;
    const events = (run.supervision.events ?? [])
      .filter((event) => cursor === null || event.sequence < cursor.sequence)
      .toReversed();
    const hasNextPage = events.length > limit;
    const page = events.slice(0, limit);
    const lastEvent = page.at(-1);
    return {
      events: page,
      nextCursor:
        hasNextPage && lastEvent
          ? encodeSupervisionEventCursor(input.runId, lastEvent.sequence)
          : null,
    };
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

  async resolveSupervisedAgentAuthority(
    agentId: string,
  ): Promise<SupervisedTeamAgentAuthority | null> {
    const collection = await this.readRuns();
    this.requireHealthyCollection(collection.issues);
    return resolveSupervisedTeamAgentAuthority(collection.records, agentId);
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
        if (existing.supervision) {
          requireSupervisionNativeDelegationDisabled(existing.supervision);
        }
        return existing;
      }
      this.requireHealthyCollection(collection.issues);
      if (input.supervision) {
        requireSupervisionNativeDelegationDisabled(input.supervision);
      }

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
      const mutableStateChanged =
        !equal(update.state, preserved.state) ||
        !equal(
          update.steps.map((step) => step.state),
          preserved.steps.map((step) => step.state),
        );
      if (!mutableStateChanged) return preserved;

      const updatedAt = this.now().toISOString();
      const supervisionPhase = terminalSupervisionPhase(update.state.status);
      const supervision =
        preserved.supervision && isActiveTeamRunStatus(preserved.state.status) && supervisionPhase
          ? terminalizeSupervision(
              preserved.supervision,
              supervisionPhase,
              updatedAt,
              this.generateAvailableSupervisionEventId(preserved.supervision),
            )
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

  async beginSupervisionTurn(
    input: BeginTeamRunSupervisionTurnInput,
  ): Promise<PersistedTeamRunRecord> {
    return this.serializeMutation(async () => {
      const current = await this.requireRun(input.runId);
      if (!current.supervision) throw new TeamRunNotSupervisedError(input.runId);
      if (!isTeamRunSupervisionDecisionBoundary(current)) {
        throw new TeamRunSupervisionActionConflictError(input.runId, input.decisionId);
      }
      if (current.supervision.revision !== input.expectedSupervisionRevision) {
        throw new TeamRunSupervisionRevisionConflictError(
          input.runId,
          input.expectedSupervisionRevision,
          current.supervision.revision,
        );
      }
      PersistedTeamEntityIdSchema.parse(input.decisionId);
      if (
        current.supervision.decisions.length >= current.supervision.limits.maxSupervisorActions ||
        current.supervision.decisions.some((decision) => decision.id === input.decisionId) ||
        current.steps.some((step) => {
          const metadata = step.snapshot.supervision;
          return metadata?.kind === "supervisor" && metadata.decisionId === input.decisionId;
        })
      ) {
        throw new TeamRunSupervisionActionConflictError(input.runId, input.decisionId);
      }

      const timestamp = this.now().toISOString();
      const supervisor = current.supervision.supervisor;
      const turn =
        current.steps.filter((step) => step.snapshot.supervision?.kind === "supervisor").length + 1;
      const hasCreatedSupervisor = current.steps.some(
        (step) =>
          step.snapshot.supervision?.kind === "supervisor" &&
          "agentId" in step.state &&
          step.state.agentId === supervisor.agentId,
      );
      const startedAt = "startedAt" in current.state ? current.state.startedAt : timestamp;
      const run = PersistedTeamRunRecordSchema.parse({
        ...current,
        steps: [
          ...current.steps,
          {
            snapshot: {
              stepId: `supervisor_turn_${turn}`,
              roleId: supervisor.roleId,
              roleName: supervisor.roleName,
              roleInstructions: supervisor.roleInstructions,
              stepInstructions: null,
              resolvedLaunch: supervisor.resolvedLaunch,
              supervision: { kind: "supervisor", turn, decisionId: input.decisionId },
            },
            state: hasCreatedSupervisor
              ? {
                  status: "running",
                  plannedAgentId: supervisor.agentId,
                  agentId: supervisor.agentId,
                  startedAt: timestamp,
                }
              : {
                  status: "creating",
                  plannedAgentId: supervisor.agentId,
                  startedAt: timestamp,
                },
          },
        ],
        supervision: {
          ...current.supervision,
          revision: current.supervision.revision + 1,
          phase: "planning",
          updatedAt: timestamp,
        },
        state: { status: "running", startedAt },
        updatedAt: timestamp,
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
        if (decisionMatchesCandidate(current, existingDecision, input.decision)) return current;
        throw new TeamRunSupervisionActionConflictError(input.runId, input.decision.actionId);
      }
      if (current.supervision.revision !== input.expectedSupervisionRevision) {
        throw new TeamRunSupervisionRevisionConflictError(
          input.runId,
          input.expectedSupervisionRevision,
          current.supervision.revision,
        );
      }
      if (!isSupervisionDecisionCommitBoundary(current, input.decision.id)) {
        throw new TeamRunSupervisionActionConflictError(input.runId, input.decision.actionId);
      }

      const preserved = PersistedTeamRunRecordSchema.parse(current);
      const supervisedCurrent = PersistedTeamRunRecordSchema.parse(
        current,
      ) as PersistedTeamRunRecord & {
        supervision: PersistedTeamRunSupervision;
      };
      const launchesWorker =
        input.decision.kind === "dispatch" || input.decision.kind === "request_revision";
      const reservedArtifactIds = launchesWorker
        ? await this.readReservedTeamRunArtifactIds()
        : new Set<string>();
      const outputArtifactId = launchesWorker
        ? this.generateAvailableArtifactId(reservedArtifactIds)
        : null;
      const committedAt = this.now().toISOString();
      const decision = {
        ...input.decision,
        createdAt: committedAt,
      } as TeamRunSupervisionCommitDecision;
      const update = await updater(supervisedCurrent, {
        outputArtifactId,
        committedAt,
        decision,
      });
      if (
        !supervisionDecisionUpdateMatches(
          preserved,
          update,
          {
            expectedSupervisionRevision: input.expectedSupervisionRevision,
            decision,
          },
          reservedArtifactIds,
        )
      ) {
        throw new TeamRunSupervisionActionConflictError(input.runId, input.decision.actionId);
      }
      if (!preservedStepsFollowDecisionTransitions(preserved, update)) {
        throw new TeamRunSupervisionActionConflictError(input.runId, input.decision.actionId);
      }

      const run = PersistedTeamRunRecordSchema.parse({
        ...preserved,
        steps: update.steps,
        state: update.state,
        supervision: appendSupervisionEvent(
          { ...update.supervision, updatedAt: committedAt },
          createDecisionSupervisionEvent(
            update,
            decision,
            this.generateAvailableSupervisionEventId(update.supervision),
          ),
        ),
        updatedAt: committedAt,
      });
      await this.writeJson(this.runPath(run.id), run);
      this.publish({ type: "run_updated", run });
      return run;
    });
  }

  async resolveSupervisionHumanRequest(
    input: ResolveTeamRunSupervisionHumanRequestInput,
  ): Promise<PersistedTeamRunRecord> {
    return this.serializeMutation(async () => {
      const current = await this.requireRun(input.runId);
      if (!current.supervision) throw new TeamRunNotSupervisedError(input.runId);
      PersistedTeamEntityIdSchema.parse(input.requestId);
      PersistedTeamEntityIdSchema.parse(input.actionId);
      const request = current.supervision.humanRequest;
      if (!request || request.id !== input.requestId) {
        throw new TeamRunSupervisionHumanRequestConflictError(input.runId, input.requestId);
      }
      if (request.resolution) {
        if (
          request.resolution.idempotencyKey === input.idempotencyKey &&
          request.resolution.actionId === input.actionId &&
          request.resolution.note === input.note
        ) {
          return current;
        }
        throw new TeamRunSupervisionHumanRequestConflictError(input.runId, input.requestId);
      }
      if (request.revision !== input.expectedRequestRevision) {
        throw new TeamRunSupervisionHumanRequestRevisionConflictError(
          input.runId,
          input.requestId,
          input.expectedRequestRevision,
          request.revision,
        );
      }
      const action = request.actions.find((candidate) => candidate.id === input.actionId);
      if (
        !action ||
        (action.requiresNote && input.note === null) ||
        current.state.status !== "running" ||
        current.supervision.phase !== "awaiting_human" ||
        current.steps.some((step) => isActiveTeamRunStepStatus(step.state.status))
      ) {
        throw new TeamRunSupervisionHumanRequestConflictError(input.runId, input.requestId);
      }

      const updatedAt = this.now().toISOString();
      const eventId = this.generateAvailableSupervisionEventId(current.supervision);
      const run = PersistedTeamRunRecordSchema.parse({
        ...current,
        supervision: appendSupervisionEvent(
          {
            ...current.supervision,
            revision: current.supervision.revision + 1,
            phase: "planning",
            humanRequest: {
              ...request,
              revision: request.revision + 1,
              resolution: {
                actionId: input.actionId,
                note: input.note,
                idempotencyKey: input.idempotencyKey,
                resolvedAt: updatedAt,
              },
            },
            updatedAt,
          },
          {
            id: eventId,
            kind: "human_request.resolved",
            title: `Human response: ${action.label}`,
            ...(input.note ? { detail: input.note } : {}),
            decisionId: null,
            actionId: input.actionId,
            workItemId: null,
            attemptId: null,
            humanRequestId: request.id,
            roleIds: request.roleIds,
            agentIds: request.agentIds,
            stepIds: request.stepIds,
            artifactIds: request.artifactIds,
            createdAt: updatedAt,
          },
        ),
        updatedAt,
      });
      await this.writeJson(this.runPath(run.id), run);
      this.publish({ type: "run_updated", run });
      return run;
    });
  }

  async settleSupervisedWorker(
    input: SettleTeamRunSupervisedWorkerInput,
  ): Promise<PersistedTeamRunRecord> {
    return this.serializeMutation(async () => {
      const current = await this.requireRun(input.runId);
      if (!current.supervision) throw new TeamRunNotSupervisedError(input.runId);
      const stepIndex = current.steps.findIndex(
        (step) =>
          step.snapshot.supervision?.kind === "worker" &&
          step.snapshot.supervision.attemptId === input.attemptId,
      );
      const step = current.steps[stepIndex];
      const metadata = step?.snapshot.supervision;
      const workItemIndex = current.supervision.workItems.findIndex(
        (workItem) => metadata?.kind === "worker" && workItem.id === metadata.workItemId,
      );
      const workItem = current.supervision.workItems[workItemIndex];
      if (settledWorkerOutcomeMatches(step, workItem, input)) return current;
      if (current.supervision.revision !== input.expectedSupervisionRevision) {
        throw new TeamRunSupervisionRevisionConflictError(
          input.runId,
          input.expectedSupervisionRevision,
          current.supervision.revision,
        );
      }
      const active = requireActiveWorkerSettlementTarget(
        current as PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
        input,
        {
          stepIndex,
          step,
          metadata,
          workItemIndex,
          workItem,
        },
      );

      const timestamp = this.now().toISOString();
      const steps = current.steps.slice();
      steps[active.stepIndex] = {
        ...active.step,
        state:
          input.outcome.status === "succeeded"
            ? {
                status: "succeeded",
                plannedAgentId: active.step.state.plannedAgentId,
                agentId: active.agentId!,
                startedAt: active.step.state.startedAt,
                endedAt: timestamp,
              }
            : {
                status: "failed",
                plannedAgentId: active.step.state.plannedAgentId,
                agentId: active.agentId,
                startedAt: active.step.state.startedAt,
                endedAt: timestamp,
                error: boundedTeamRunError(input.outcome.error),
              },
      };
      const workItems = current.supervision.workItems.slice();
      workItems[active.workItemIndex] = {
        ...active.workItem,
        acceptedAttemptId: input.outcome.status === "succeeded" ? input.attemptId : null,
        status: input.outcome.status,
      };
      const startedAt = "startedAt" in current.state ? current.state.startedAt : timestamp;
      const outputArtifactId =
        input.outcome.status === "succeeded" ? active.step.snapshot.outputArtifact?.id : undefined;
      const dispatchDecisionId =
        current.supervision.decisions.find((decision) => decision.attemptId === input.attemptId)
          ?.id ?? null;
      const run = PersistedTeamRunRecordSchema.parse({
        ...current,
        steps,
        supervision: appendSupervisionEvent(
          {
            ...current.supervision,
            revision: current.supervision.revision + 1,
            phase: "planning",
            workItems,
            updatedAt: timestamp,
          },
          {
            id: this.generateAvailableSupervisionEventId(current.supervision),
            kind: `worker.${input.outcome.status}`,
            title: `Worker ${input.outcome.status}`,
            ...(input.outcome.status === "failed"
              ? { detail: boundedTeamRunError(input.outcome.error) }
              : {}),
            decisionId: dispatchDecisionId,
            actionId: null,
            workItemId: active.workItem.id,
            attemptId: input.attemptId,
            humanRequestId: null,
            roleIds: [active.step.snapshot.roleId],
            agentIds: [active.step.state.plannedAgentId],
            stepIds: [active.step.snapshot.stepId],
            artifactIds: outputArtifactId ? [outputArtifactId] : [],
            createdAt: timestamp,
          },
        ),
        state: { status: "running", startedAt },
        updatedAt: timestamp,
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
    const reservedArtifactIds = collectTeamRunOutputArtifactIds(existingRuns);
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

  private generateAvailableArtifactId(reservedArtifactIds: ReadonlySet<string>): string {
    let artifactId = this.generateArtifactId();
    while (reservedArtifactIds.has(artifactId)) artifactId = this.generateArtifactId();
    return artifactId;
  }

  private generateAvailableSupervisionEventId(supervision: PersistedTeamRunSupervision): string {
    const existingIds = new Set((supervision.events ?? []).map((event) => event.id));
    let eventId = this.generateSupervisionEventId();
    while (existingIds.has(eventId)) eventId = this.generateSupervisionEventId();
    return eventId;
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

  private async readReservedTeamRunArtifactIds(): Promise<Set<string>> {
    const collection = await this.readRuns();
    this.requireHealthyCollection(collection.issues);
    return collectTeamRunOutputArtifactIds(collection.records);
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

function isSupervisionDecisionCommitBoundary(
  run: PersistedTeamRunRecord,
  decisionId: string,
): boolean {
  if (!run.supervision || run.state.status !== "running" || run.supervision.phase !== "planning") {
    return false;
  }
  const activeSteps = run.steps.filter((step) => isActiveTeamRunStepStatus(step.state.status));
  if (activeSteps.length !== 1) return false;
  const activeStep = activeSteps[0]!;
  const metadata = activeStep.snapshot.supervision;
  return (
    activeStep.state.status === "running" &&
    metadata?.kind === "supervisor" &&
    metadata.decisionId === decisionId
  );
}

function boundedTeamRunError(message: string): string {
  const normalized = message.trim() || "Unknown supervised worker failure";
  return normalized.slice(0, TEAM_ERROR_MAX_CHARS);
}

interface WorkerSettlementCandidate {
  stepIndex: number;
  step: PersistedTeamRunRecord["steps"][number] | undefined;
  metadata: PersistedTeamRunRecord["steps"][number]["snapshot"]["supervision"] | undefined;
  workItemIndex: number;
  workItem: PersistedTeamRunSupervision["workItems"][number] | undefined;
}

interface ActiveWorkerSettlementTarget {
  stepIndex: number;
  step: PersistedTeamRunRecord["steps"][number] & {
    state: Exclude<PersistedTeamRunRecord["steps"][number]["state"], { status: "pending" }>;
  };
  workItemIndex: number;
  workItem: PersistedTeamRunSupervision["workItems"][number];
  agentId: string | null;
}

function requireActiveWorkerSettlementTarget(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  input: SettleTeamRunSupervisedWorkerInput,
  candidate: WorkerSettlementCandidate,
): ActiveWorkerSettlementTarget {
  const { step, metadata, workItem } = candidate;
  if (
    !step ||
    metadata?.kind !== "worker" ||
    !isActiveTeamRunStepStatus(step.state.status) ||
    !("plannedAgentId" in step.state) ||
    run.state.status === "stopping" ||
    run.state.status === "stop_failed" ||
    !workItem ||
    workItem.status !== "active" ||
    !workItem.attemptIds.includes(input.attemptId)
  ) {
    throw new TeamRunSupervisionActionConflictError(input.runId, input.attemptId);
  }
  const agentId = "agentId" in step.state ? step.state.agentId : null;
  if (input.outcome.status === "succeeded" && agentId === null) {
    throw new TeamRunSupervisionActionConflictError(input.runId, input.attemptId);
  }
  return {
    stepIndex: candidate.stepIndex,
    step: step as ActiveWorkerSettlementTarget["step"],
    workItemIndex: candidate.workItemIndex,
    workItem,
    agentId,
  };
}

function settledWorkerOutcomeMatches(
  step: PersistedTeamRunRecord["steps"][number] | undefined,
  workItem: PersistedTeamRunSupervision["workItems"][number] | undefined,
  input: SettleTeamRunSupervisedWorkerInput,
): boolean {
  if (!step || !workItem) return false;
  if (input.outcome.status === "succeeded") {
    return (
      step.state.status === "succeeded" &&
      workItem.status === "succeeded" &&
      workItem.acceptedAttemptId === input.attemptId
    );
  }
  return (
    step.state.status === "failed" &&
    step.state.error === boundedTeamRunError(input.outcome.error) &&
    workItem.status === "failed" &&
    workItem.acceptedAttemptId === null
  );
}

function supervisionDecisionUpdateMatches(
  preserved: PersistedTeamRunRecord,
  update: TeamRunSupervisionUpdate,
  input: {
    expectedSupervisionRevision: number;
    decision: TeamRunSupervisionCommitDecision;
  },
  reservedArtifactIds: ReadonlySet<string>,
): boolean {
  const expectedDecisions = [...preserved.supervision!.decisions, input.decision];
  const immutableSnapshotMatches =
    equal(update.supervision.supervisor, preserved.supervision!.supervisor) &&
    equal(update.supervision.workerTemplates, preserved.supervision!.workerTemplates) &&
    equal(update.supervision.limits, preserved.supervision!.limits) &&
    equal(update.supervision.events, preserved.supervision!.events);
  return (
    immutableSnapshotMatches &&
    decisionPreservesWorkItemLedger(preserved, update, input.decision) &&
    decisionPreservesHumanRequest(preserved, update, input.decision) &&
    equal(update.supervision.decisions, expectedDecisions) &&
    update.supervision.revision === input.expectedSupervisionRevision + 1 &&
    canTransitionTeamRun(preserved.state.status, update.state.status) &&
    decisionPreservesRunStateProvenance(preserved.state, update.state) &&
    decisionProducesRequiredSupervisionEffect(update, input.decision) &&
    decisionAppendsExpectedWorkerAttempt(preserved, update, input.decision, reservedArtifactIds)
  );
}

function decisionMatchesCandidate(
  run: PersistedTeamRunRecord,
  decision: TeamRunSupervisionDecision,
  candidate: TeamRunSupervisionDecisionCandidate,
): boolean {
  const { createdAt: _createdAt, ...persisted } = decision;
  const { createdAt: _candidateCreatedAt, ...requested } = candidate;
  if (persisted.kind !== "dispatch" || persisted.inputArtifactIds !== undefined) {
    return equal(persisted, requested);
  }
  const attempt = run.steps.find(
    (step) =>
      step.snapshot.supervision?.kind === "worker" &&
      step.snapshot.supervision.attemptId === persisted.attemptId,
  );
  return equal(
    { ...persisted, inputArtifactIds: attempt?.snapshot.inputArtifactIds ?? [] },
    requested,
  );
}

function decisionPreservesWorkItemLedger(
  preserved: PersistedTeamRunRecord,
  update: TeamRunSupervisionUpdate,
  decision: TeamRunSupervisionCommitDecision,
): boolean {
  const preservedWorkItems = preserved.supervision!.workItems;
  if (
    !canSupervisionDecisionChangeWorkItemCount(
      preservedWorkItems.length,
      update.supervision.workItems.length,
      decision.kind,
    )
  ) {
    return false;
  }
  return preservedWorkItems.every((workItem, index) => {
    const updatedWorkItem = update.supervision.workItems[index];
    if (!updatedWorkItem) return false;
    const launchesThisWorkItem =
      (decision.kind === "dispatch" || decision.kind === "request_revision") &&
      decision.workItemId === workItem.id;
    if (!launchesThisWorkItem) return equal(updatedWorkItem, workItem);
    const identityMatches =
      updatedWorkItem.id === workItem.id &&
      updatedWorkItem.templateStepId === workItem.templateStepId &&
      equal(updatedWorkItem.inputArtifactIds, decision.inputArtifactIds);
    const attemptHistoryMatches = workItem.attemptIds.every(
      (attemptId, attemptIndex) => updatedWorkItem.attemptIds[attemptIndex] === attemptId,
    );
    return identityMatches && attemptHistoryMatches && updatedWorkItem.acceptedAttemptId === null;
  });
}

export function canSupervisionDecisionChangeWorkItemCount(
  preservedCount: number,
  updatedCount: number,
  decisionKind: TeamRunSupervisionDecision["kind"],
): boolean {
  return (
    updatedCount >= preservedCount && (decisionKind === "plan" || updatedCount === preservedCount)
  );
}

function resolvePrecedingAcceptedArtifactIds(
  run: PersistedTeamRunRecord,
  workItemId: string,
): string[] | null {
  const workItems = run.supervision!.workItems;
  const workItemIndex = workItems.findIndex((workItem) => workItem.id === workItemId);
  if (workItemIndex < 0) return null;
  const artifactIds: string[] = [];
  for (const workItem of workItems.slice(0, workItemIndex)) {
    if (workItem.status !== "succeeded" || workItem.acceptedAttemptId === null) return null;
    const acceptedStep = run.steps.find(
      (step) =>
        step.snapshot.supervision?.kind === "worker" &&
        step.snapshot.supervision.attemptId === workItem.acceptedAttemptId,
    );
    const artifactId = acceptedStep?.snapshot.outputArtifact?.id;
    if (acceptedStep?.state.status !== "succeeded" || !artifactId) return null;
    artifactIds.push(artifactId);
  }
  return artifactIds;
}

function decisionPreservesHumanRequest(
  preserved: PersistedTeamRunRecord,
  update: TeamRunSupervisionUpdate,
  decision: TeamRunSupervisionCommitDecision,
): boolean {
  const preservedRequest = preserved.supervision!.humanRequest;
  if (decision.kind === "escalate" && preservedRequest === null) return true;
  return equal(update.supervision.humanRequest, preservedRequest);
}

function preservedStepsFollowDecisionTransitions(
  preserved: PersistedTeamRunRecord,
  update: TeamRunSupervisionUpdate,
): boolean {
  return preserved.steps.every((step, index) => {
    const updatedStep = update.steps[index];
    if (!updatedStep || !equal(step.snapshot, updatedStep.snapshot)) return false;
    if (!canTransitionTeamRunStep(step.state.status, updatedStep.state.status)) return false;
    return !isTerminalTeamRunStepStatus(step.state.status) || equal(step.state, updatedStep.state);
  });
}

function decisionPreservesRunStateProvenance(
  preserved: PersistedTeamRunRecord["state"],
  update: PersistedTeamRunRecord["state"],
): boolean {
  if (preserved.status === update.status) return equal(preserved, update);
  if (!("startedAt" in preserved)) return true;
  return "startedAt" in update && update.startedAt === preserved.startedAt;
}

function decisionProducesRequiredSupervisionEffect(
  update: TeamRunSupervisionUpdate,
  decision: TeamRunSupervisionCommitDecision,
): boolean {
  const request = update.supervision.humanRequest;
  const completesRun =
    update.state.status === "succeeded" && update.supervision.phase === "completed";
  const createsPendingHumanWait =
    update.state.status === "running" &&
    update.supervision.phase === "awaiting_human" &&
    request !== null &&
    !request.resolution &&
    !request.retirement &&
    !update.steps.some((step) => isActiveTeamRunStepStatus(step.state.status));
  return (
    (decision.kind === "complete") === completesRun &&
    (decision.kind === "escalate") === createsPendingHumanWait
  );
}

function decisionAppendsExpectedWorkerAttempt(
  preserved: PersistedTeamRunRecord,
  update: TeamRunSupervisionUpdate,
  decision: TeamRunSupervisionCommitDecision,
  reservedArtifactIds: ReadonlySet<string>,
): boolean {
  const appendedWorkers: PersistedTeamRunRecord["steps"] = [];
  for (const step of update.steps.slice(preserved.steps.length)) {
    if (step.snapshot.supervision?.kind === "worker") appendedWorkers.push(step);
  }
  if (!isWorkerLaunchDecision(decision)) return appendedWorkers.length === 0;
  const attemptAlreadyExists = preserved.steps.some(
    (step) =>
      step.snapshot.supervision?.kind === "worker" &&
      step.snapshot.supervision.attemptId === decision.attemptId,
  );
  if (attemptAlreadyExists || appendedWorkers.length !== 1) return false;
  const worker = appendedWorkers[0]!;
  const metadata = worker.snapshot.supervision;
  const workItem = update.supervision.workItems.find(
    (candidate) => candidate.id === decision.workItemId,
  );
  const preservedWorkItem = preserved.supervision!.workItems.find(
    (candidate) => candidate.id === decision.workItemId,
  );
  if (!workItem || metadata?.kind !== "worker") return false;
  if (decision.kind === "request_revision" && !preservedWorkItem) return false;
  const preservedAttemptIds = preservedWorkItem?.attemptIds ?? [];
  const expectedRevisionParent =
    decision.kind === "request_revision" ? (preservedWorkItem?.acceptedAttemptId ?? null) : null;
  const context = {
    preserved,
    update,
    decision,
    worker,
    metadata,
    workItem,
    preservedWorkItem,
    preservedAttemptIds,
    expectedRevisionParent,
  };
  if (!workerLaunchBaseMatches(context, reservedArtifactIds)) return false;
  return decision.kind === "dispatch"
    ? workerDispatchMatches(context)
    : workerRevisionMatches(context);
}

type WorkerLaunchDecision = Extract<
  TeamRunSupervisionCommitDecision,
  { kind: "dispatch" | "request_revision" }
>;

interface WorkerLaunchValidationContext {
  preserved: PersistedTeamRunRecord;
  update: TeamRunSupervisionUpdate;
  decision: WorkerLaunchDecision;
  worker: PersistedTeamRunRecord["steps"][number];
  metadata: Extract<
    NonNullable<PersistedTeamRunRecord["steps"][number]["snapshot"]["supervision"]>,
    { kind: "worker" }
  >;
  workItem: PersistedTeamRunSupervision["workItems"][number];
  preservedWorkItem: PersistedTeamRunSupervision["workItems"][number] | undefined;
  preservedAttemptIds: string[];
  expectedRevisionParent: string | null;
}

function isWorkerLaunchDecision(
  decision: TeamRunSupervisionCommitDecision,
): decision is WorkerLaunchDecision {
  return decision.kind === "dispatch" || decision.kind === "request_revision";
}

function workerLaunchBaseMatches(
  context: WorkerLaunchValidationContext,
  reservedArtifactIds: ReadonlySet<string>,
): boolean {
  const {
    decision,
    expectedRevisionParent,
    metadata,
    preservedAttemptIds,
    update,
    workItem,
    worker,
  } = context;
  const outputArtifactId = worker.snapshot.outputArtifact?.id;
  const acceptedArtifactIds = collectAcceptedArtifactIds(context.preserved);
  const inputsAreAcceptedOutputs = (worker.snapshot.inputArtifactIds ?? []).every((artifactId) =>
    acceptedArtifactIds.has(artifactId),
  );
  return [
    metadata.workItemId === decision.workItemId,
    metadata.attemptId === decision.attemptId,
    metadata.attemptNumber === preservedAttemptIds.length + 1,
    metadata.revisionParentAttemptId === expectedRevisionParent,
    worker.state.status === "creating",
    workItem.status === "active",
    workItem.acceptedAttemptId === null,
    equal(workItem.attemptIds, [...preservedAttemptIds, decision.attemptId]),
    update.supervision.phase === "working",
    outputArtifactId !== undefined,
    equal(worker.snapshot.inputArtifactIds, workItem.inputArtifactIds),
    equal(worker.snapshot.inputArtifactIds, decision.inputArtifactIds),
    inputsAreAcceptedOutputs,
    outputArtifactId !== undefined && !reservedArtifactIds.has(outputArtifactId),
  ].every(Boolean);
}

function workerDispatchMatches(context: WorkerLaunchValidationContext): boolean {
  const { decision, preserved, preservedAttemptIds, preservedWorkItem, worker } = context;
  let expectedInputs: string[] | null = [];
  if (preservedWorkItem) {
    expectedInputs = resolvePrecedingAcceptedArtifactIds(preserved, decision.workItemId);
  }
  return [
    preservedAttemptIds.length === 0,
    preservedWorkItem === undefined || preservedWorkItem.status === "planned",
    expectedInputs !== null,
    expectedInputs !== null && equal(worker.snapshot.inputArtifactIds, expectedInputs),
  ].every(Boolean);
}

function workerRevisionMatches(context: WorkerLaunchValidationContext): boolean {
  const {
    decision,
    expectedRevisionParent,
    preserved,
    preservedAttemptIds,
    preservedWorkItem,
    worker,
  } = context;
  if (!preservedWorkItem || expectedRevisionParent === null) return false;
  const parentArtifactId = findAttemptOutputArtifactId(preserved, expectedRevisionParent);
  return [
    preservedWorkItem.status === "succeeded",
    preservedAttemptIds.length < preserved.supervision!.limits.maxAttemptsPerWorkItem,
    parentArtifactId !== null,
    parentArtifactId !== null && worker.snapshot.inputArtifactIds?.includes(parentArtifactId),
    equal(worker.snapshot.inputArtifactIds, decision.inputArtifactIds),
  ].every(Boolean);
}

function collectAcceptedArtifactIds(run: PersistedTeamRunRecord): Set<string> {
  return new Set(
    run.supervision!.workItems.flatMap((workItem) => {
      if (!workItem.acceptedAttemptId) return [];
      const artifactId = findAttemptOutputArtifactId(run, workItem.acceptedAttemptId);
      return artifactId ? [artifactId] : [];
    }),
  );
}

function findAttemptOutputArtifactId(
  run: PersistedTeamRunRecord,
  attemptId: string,
): string | null {
  return (
    run.steps.find(
      (step) =>
        step.snapshot.supervision?.kind === "worker" &&
        step.snapshot.supervision.attemptId === attemptId,
    )?.snapshot.outputArtifact?.id ?? null
  );
}

function collectTeamRunOutputArtifactIds(runs: readonly PersistedTeamRunRecord[]): Set<string> {
  return new Set(
    runs.flatMap((run) =>
      run.steps.flatMap((step) =>
        step.snapshot.outputArtifact ? [step.snapshot.outputArtifact.id] : [],
      ),
    ),
  );
}

type TeamRunSupervisionEventDraft = Omit<TeamRunSupervisionEvent, "sequence">;

function appendSupervisionEvent(
  supervision: PersistedTeamRunSupervision,
  event: TeamRunSupervisionEventDraft,
): PersistedTeamRunSupervision {
  const events = supervision.events ?? [];
  return {
    ...supervision,
    events: [...events, { ...event, sequence: events.length + 1 }],
  };
}

function createDecisionSupervisionEvent(
  update: TeamRunSupervisionUpdate,
  decision: TeamRunSupervisionCommitDecision,
  eventId: string,
): TeamRunSupervisionEventDraft {
  const supervisorStep = update.steps.find(
    (step) =>
      step.snapshot.supervision?.kind === "supervisor" &&
      step.snapshot.supervision.decisionId === decision.id,
  );
  const workerStep =
    decision.attemptId === null
      ? null
      : update.steps.find(
          (step) =>
            step.snapshot.supervision?.kind === "worker" &&
            step.snapshot.supervision.attemptId === decision.attemptId,
        );
  const artifactIds =
    decision.kind === "dispatch" || decision.kind === "request_revision"
      ? [
          ...decision.inputArtifactIds,
          ...(workerStep?.snapshot.outputArtifact ? [workerStep.snapshot.outputArtifact.id] : []),
        ]
      : [];
  const humanRequest = decision.kind === "escalate" ? update.supervision.humanRequest : null;
  const roleIds = [
    update.supervision.supervisor.roleId,
    ...(workerStep ? [workerStep.snapshot.roleId] : []),
  ];
  const stepIds = [
    ...(supervisorStep ? [supervisorStep.snapshot.stepId] : []),
    ...(workerStep ? [workerStep.snapshot.stepId] : []),
  ];
  const agentIds = [
    update.supervision.supervisor.agentId,
    ...(workerStep && "plannedAgentId" in workerStep.state
      ? [workerStep.state.plannedAgentId]
      : []),
  ];
  return {
    id: eventId,
    kind: `decision.${decision.kind}`,
    title: decisionTitle(decision.kind),
    detail: decision.summary,
    decisionId: decision.id,
    actionId: decision.actionId,
    workItemId: decision.workItemId,
    attemptId: decision.attemptId,
    humanRequestId: humanRequest?.id ?? null,
    roleIds: [...new Set(roleIds)],
    agentIds: [...new Set(agentIds)],
    stepIds: [...new Set(stepIds)],
    artifactIds: [...new Set(artifactIds)],
    createdAt: decision.createdAt,
  };
}

function decisionTitle(kind: TeamRunSupervisionCommitDecision["kind"]): string {
  switch (kind) {
    case "plan":
      return "Supervisor planned work";
    case "dispatch":
      return "Supervisor dispatched work";
    case "request_revision":
      return "Supervisor requested a revision";
    case "escalate":
      return "Supervisor requested human input";
    case "complete":
      return "Supervisor completed the run";
  }
}

function terminalizeSupervision(
  supervision: PersistedTeamRunSupervision,
  phase: PersistedTeamRunSupervision["phase"],
  updatedAt: string,
  eventId: string,
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
  const terminalized = {
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
  return appendSupervisionEvent(
    terminalized,
    isPendingRequest && retirementReason
      ? {
          id: eventId,
          kind: "human_request.retired",
          title: "Human request retired",
          detail: `The Team Run was ${retirementReason}`,
          decisionId: null,
          actionId: null,
          workItemId: null,
          attemptId: null,
          humanRequestId: humanRequest.id,
          roleIds: humanRequest.roleIds,
          agentIds: humanRequest.agentIds,
          stepIds: humanRequest.stepIds,
          artifactIds: humanRequest.artifactIds,
          createdAt: updatedAt,
        }
      : {
          id: eventId,
          kind: `run.${phase}`,
          title: `Team Run ${phase}`,
          decisionId: null,
          actionId: null,
          workItemId: null,
          attemptId: null,
          humanRequestId: null,
          roleIds: [supervision.supervisor.roleId],
          agentIds: [supervision.supervisor.agentId],
          stepIds: [],
          artifactIds: [],
          createdAt: updatedAt,
        },
  );
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

function normalizeSupervisionEventPageLimit(limit: number | undefined): number {
  if (limit === undefined) return TEAM_RUN_PAGE_DEFAULT_LIMIT;
  const isValid = Number.isInteger(limit) && limit > 0 && limit <= TEAM_RUN_PAGE_MAX_LIMIT;
  if (!isValid) {
    throw new TeamRunSupervisionEventPageError(
      `Supervision event page limit must be between 1 and ${TEAM_RUN_PAGE_MAX_LIMIT}`,
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

function encodeSupervisionEventCursor(runId: string, sequence: number): string {
  const cursor: TeamRunSupervisionEventCursor = { runId, sequence };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSupervisionEventCursor(token: string, runId: string): TeamRunSupervisionEventCursor {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const cursor = TeamRunSupervisionEventCursorSchema.parse(JSON.parse(decoded));
    if (cursor.runId !== runId) {
      throw new TeamRunSupervisionEventPageError(
        "Supervision event cursor does not match the Team Run",
      );
    }
    return cursor;
  } catch (error) {
    if (error instanceof TeamRunSupervisionEventPageError) throw error;
    throw new TeamRunSupervisionEventPageError("Invalid supervision event cursor");
  }
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
