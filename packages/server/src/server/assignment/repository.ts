import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  hostPersistenceBoundaryKey,
  serializeHostPersistenceMutation,
} from "../persistence-mutation.js";
import {
  generateAssignmentId,
  PersistedAssignmentArtifactIdSchema,
  PersistedAssignmentArtifactRecordSchema,
  PersistedAssignmentIdSchema,
  PersistedAssignmentRecordSchema,
  type PersistedAssignmentArtifactRecord,
  type PersistedAssignmentRecord,
} from "./model.js";

export const ASSIGNMENT_ARTIFACT_PAGE_DEFAULT_LIMIT = 50;
export const ASSIGNMENT_ARTIFACT_PAGE_MAX_LIMIT = 100;

export type CreateAssignmentInput = Pick<
  PersistedAssignmentRecord,
  "title" | "objective" | "workItem"
>;

export type AssignmentPatch = Partial<CreateAssignmentInput>;

export interface PatchAssignmentInput {
  assignmentId: string;
  expectedRevision: number;
  patch: AssignmentPatch;
}

export interface TransitionAssignmentInput {
  assignmentId: string;
  expectedRevision: number;
}

export type CreateAssignmentArtifactInput = Omit<PersistedAssignmentArtifactRecord, "createdAt">;

export interface ListAssignmentArtifactsInput {
  assignmentId: string;
  cursor?: string;
  limit?: number;
}

export type AssignmentRepositoryCollection = "records" | "artifacts";
export type AssignmentRepositoryFileIssueKind = "unknown_file" | "invalid_record";

export interface AssignmentRepositoryFileIssue {
  collection: AssignmentRepositoryCollection;
  fileName: string;
  kind: AssignmentRepositoryFileIssueKind;
  message: string;
}

export interface AssignmentList {
  assignments: PersistedAssignmentRecord[];
  issues: AssignmentRepositoryFileIssue[];
}

export interface AssignmentArtifactPage {
  artifacts: PersistedAssignmentArtifactRecord[];
  nextCursor: string | null;
  issues: AssignmentRepositoryFileIssue[];
}

export type AssignmentRepositoryChange =
  | { type: "assignment_created"; assignment: PersistedAssignmentRecord }
  | { type: "assignment_updated"; assignment: PersistedAssignmentRecord }
  | { type: "artifact_created"; artifact: PersistedAssignmentArtifactRecord };

export type AssignmentRepositoryListener = (change: AssignmentRepositoryChange) => void;

export interface AssignmentRepositoryOptions {
  paseoHome: string;
  now?: () => Date;
  writeJson?: (filePath: string, value: unknown) => Promise<void>;
  activeRunStore?: AssignmentActiveRunStore;
}

export interface AssignmentActiveRunStore {
  readonly persistenceBoundaryKey: string;
  getActiveRunForAssignment(assignmentId: string): Promise<{ id: string } | null>;
}

interface CollectionRead<TRecord> {
  records: TRecord[];
  issues: AssignmentRepositoryFileIssue[];
}

const AssignmentArtifactCursorSchema = z
  .object({
    assignmentId: PersistedAssignmentIdSchema,
    createdAt: z.string().datetime({ offset: true }),
    id: PersistedAssignmentArtifactIdSchema,
  })
  .strict();

type AssignmentArtifactCursor = z.infer<typeof AssignmentArtifactCursorSchema>;

export class AssignmentNotFoundError extends Error {
  readonly code = "assignment_not_found";

  constructor(readonly assignmentId: string) {
    super(`Assignment not found: ${assignmentId}`);
    this.name = "AssignmentNotFoundError";
  }
}

export class AssignmentRevisionConflictError extends Error {
  readonly code = "assignment_revision_conflict";

  constructor(
    readonly assignmentId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Assignment revision conflict for ${assignmentId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "AssignmentRevisionConflictError";
  }
}

export class AssignmentStateConflictError extends Error {
  readonly code = "assignment_state_conflict";

  constructor(
    readonly assignmentId: string,
    readonly status: PersistedAssignmentRecord["state"]["status"],
  ) {
    super(`Assignment ${assignmentId} is ${status}; this operation requires an open Assignment`);
    this.name = "AssignmentStateConflictError";
  }
}

export class AssignmentHasActiveRunError extends Error {
  readonly code = "assignment_has_active_run";

  constructor(
    readonly assignmentId: string,
    readonly runId: string,
  ) {
    super(`Assignment ${assignmentId} has an active Team Run: ${runId}`);
    this.name = "AssignmentHasActiveRunError";
  }
}

export class AssignmentPersistenceBoundaryError extends Error {
  readonly code = "assignment_persistence_boundary_mismatch";

  constructor() {
    super("Assignment and Team Run stores must share one host persistence boundary");
    this.name = "AssignmentPersistenceBoundaryError";
  }
}

export class AssignmentPatchEmptyError extends Error {
  readonly code = "assignment_patch_empty";

  constructor() {
    super("Assignment patch must change at least one mutable field");
    this.name = "AssignmentPatchEmptyError";
  }
}

export class AssignmentArtifactConflictError extends Error {
  readonly code = "assignment_artifact_conflict";

  constructor(readonly artifactId: string) {
    super(`Artifact ID ${artifactId} is already bound to different immutable content`);
    this.name = "AssignmentArtifactConflictError";
  }
}

export class AssignmentArtifactRevisionUnavailableError extends Error {
  readonly code = "assignment_artifact_revision_unavailable";

  constructor(
    readonly assignmentId: string,
    readonly assignmentRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Assignment ${assignmentId} has not reached revision ${assignmentRevision}; current revision is ${currentRevision}`,
    );
    this.name = "AssignmentArtifactRevisionUnavailableError";
  }
}

export class AssignmentArtifactPageError extends Error {
  readonly code = "invalid_assignment_artifact_page";

  constructor(message: string) {
    super(message);
    this.name = "AssignmentArtifactPageError";
  }
}

export class AssignmentRepositoryIdError extends Error {
  readonly code = "invalid_assignment_repository_id";

  constructor(readonly entityId: string) {
    super("Assignment repository IDs must be canonical generated identifiers");
    this.name = "AssignmentRepositoryIdError";
  }
}

export class AssignmentStorageCorruptError extends Error {
  readonly code = "assignment_storage_corrupt";

  constructor(readonly issues: AssignmentRepositoryFileIssue[]) {
    super("Assignment storage contains unreadable records");
    this.name = "AssignmentStorageCorruptError";
  }
}

export class AssignmentRepository {
  private readonly recordsDir: string;
  private readonly artifactsDir: string;
  readonly persistenceBoundaryKey: string;
  private readonly now: () => Date;
  private readonly writeJson: (filePath: string, value: unknown) => Promise<void>;
  private readonly activeRunStore: AssignmentActiveRunStore | null;
  private readonly listeners = new Set<AssignmentRepositoryListener>();

  constructor(options: AssignmentRepositoryOptions) {
    const assignmentsDir = resolve(options.paseoHome, "assignments");
    this.recordsDir = join(assignmentsDir, "records");
    this.artifactsDir = join(assignmentsDir, "artifacts");
    this.persistenceBoundaryKey = hostPersistenceBoundaryKey(options.paseoHome);
    this.now = options.now ?? (() => new Date());
    this.writeJson = options.writeJson ?? writeJsonFileAtomic;
    this.activeRunStore = options.activeRunStore ?? null;
    if (
      this.activeRunStore &&
      this.activeRunStore.persistenceBoundaryKey !== this.persistenceBoundaryKey
    ) {
      throw new AssignmentPersistenceBoundaryError();
    }
  }

  subscribe(listener: AssignmentRepositoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listAssignments(): Promise<AssignmentList> {
    const { records, issues } = await this.readAssignments();
    records.sort(compareAssignmentsNewestFirst);
    return { assignments: records, issues };
  }

  async getAssignment(assignmentId: string): Promise<PersistedAssignmentRecord | null> {
    return this.readRecord(
      this.assignmentPath(assignmentId),
      assignmentId,
      "records",
      PersistedAssignmentRecordSchema,
    );
  }

  async createAssignment(input: CreateAssignmentInput): Promise<PersistedAssignmentRecord> {
    return this.serializeMutation(async () => {
      const collection = await this.readAssignments();
      this.requireHealthyCollection(collection.issues);
      const existingIds = new Set(collection.records.map((assignment) => assignment.id));
      let assignmentId = generateAssignmentId();
      while (existingIds.has(assignmentId)) {
        assignmentId = generateAssignmentId();
      }
      const timestamp = this.now().toISOString();
      const assignment = PersistedAssignmentRecordSchema.parse({
        ...input,
        id: assignmentId,
        revision: 1,
        state: { status: "open" },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.writeJson(this.assignmentPath(assignment.id), assignment);
      this.publish({ type: "assignment_created", assignment });
      return assignment;
    });
  }

  async patchAssignment(input: PatchAssignmentInput): Promise<PersistedAssignmentRecord> {
    if (Object.keys(input.patch).length === 0) throw new AssignmentPatchEmptyError();
    return this.updateOpenAssignment(input, false, (current, timestamp) => ({
      ...current,
      ...input.patch,
      id: current.id,
      revision: current.revision + 1,
      state: current.state,
      createdAt: current.createdAt,
      updatedAt: timestamp,
    }));
  }

  async completeAssignment(input: TransitionAssignmentInput): Promise<PersistedAssignmentRecord> {
    return this.updateOpenAssignment(input, true, (current, timestamp) => ({
      ...current,
      revision: current.revision + 1,
      state: { status: "completed", completedAt: timestamp },
      updatedAt: timestamp,
    }));
  }

  async cancelAssignment(input: TransitionAssignmentInput): Promise<PersistedAssignmentRecord> {
    return this.updateOpenAssignment(input, true, (current, timestamp) => ({
      ...current,
      revision: current.revision + 1,
      state: { status: "canceled", canceledAt: timestamp },
      updatedAt: timestamp,
    }));
  }

  async getArtifact(artifactId: string): Promise<PersistedAssignmentArtifactRecord | null> {
    return this.readRecord(
      this.artifactPath(artifactId),
      artifactId,
      "artifacts",
      PersistedAssignmentArtifactRecordSchema,
    );
  }

  async createArtifact(
    input: CreateAssignmentArtifactInput,
  ): Promise<PersistedAssignmentArtifactRecord> {
    return this.serializeMutation(async () => {
      const collection = await this.readArtifacts();
      const existing = collection.records.find((artifact) => artifact.id === input.id);
      if (existing) {
        const retry = PersistedAssignmentArtifactRecordSchema.parse({
          ...input,
          createdAt: existing.createdAt,
        });
        if (isDeepStrictEqual(existing, retry)) return existing;
        throw new AssignmentArtifactConflictError(input.id);
      }
      this.requireHealthyCollection(collection.issues);

      const assignment = await this.requireAssignment(input.assignmentId);
      if (input.assignmentRevision > assignment.revision) {
        throw new AssignmentArtifactRevisionUnavailableError(
          assignment.id,
          input.assignmentRevision,
          assignment.revision,
        );
      }
      const artifact = PersistedAssignmentArtifactRecordSchema.parse({
        ...input,
        createdAt: this.now().toISOString(),
      });
      await this.writeJson(this.artifactPath(artifact.id), artifact);
      this.publish({ type: "artifact_created", artifact });
      return artifact;
    });
  }

  async listArtifacts(input: ListAssignmentArtifactsInput): Promise<AssignmentArtifactPage> {
    requireAssignmentId(input.assignmentId);
    const limit = normalizeArtifactPageLimit(input.limit);
    const { records, issues } = await this.readArtifacts();
    const assignmentArtifacts = records.filter(
      (artifact) => artifact.assignmentId === input.assignmentId,
    );
    assignmentArtifacts.sort(compareArtifactsNewestFirst);
    const cursor = input.cursor ? decodeArtifactCursor(input.cursor, input.assignmentId) : null;
    const remainingArtifacts = cursor
      ? assignmentArtifacts.filter((artifact) => isArtifactAfterCursor(artifact, cursor))
      : assignmentArtifacts;
    const hasNextPage = remainingArtifacts.length > limit;
    const artifacts = remainingArtifacts.slice(0, limit);
    const lastArtifact = artifacts[artifacts.length - 1];
    return {
      artifacts,
      nextCursor: hasNextPage && lastArtifact ? encodeArtifactCursor(lastArtifact) : null,
      issues,
    };
  }

  private async updateOpenAssignment(
    input: TransitionAssignmentInput,
    rejectActiveRun: boolean,
    updater: (current: PersistedAssignmentRecord, timestamp: string) => PersistedAssignmentRecord,
  ): Promise<PersistedAssignmentRecord> {
    return this.serializeMutation(async () => {
      const current = await this.requireAssignment(input.assignmentId);
      this.requireRevision(current, input.expectedRevision);
      if (current.state.status !== "open") {
        throw new AssignmentStateConflictError(current.id, current.state.status);
      }
      if (rejectActiveRun && this.activeRunStore) {
        const activeRun = await this.activeRunStore.getActiveRunForAssignment(current.id);
        if (activeRun) throw new AssignmentHasActiveRunError(current.id, activeRun.id);
      }
      const assignment = PersistedAssignmentRecordSchema.parse(
        updater(current, this.now().toISOString()),
      );
      await this.writeJson(this.assignmentPath(assignment.id), assignment);
      this.publish({ type: "assignment_updated", assignment });
      return assignment;
    });
  }

  private assignmentPath(assignmentId: string): string {
    requireAssignmentId(assignmentId);
    return join(this.recordsDir, `${assignmentId}.json`);
  }

  private artifactPath(artifactId: string): string {
    requireArtifactId(artifactId);
    return join(this.artifactsDir, `${artifactId}.json`);
  }

  private readAssignments(): Promise<CollectionRead<PersistedAssignmentRecord>> {
    return this.readCollection(this.recordsDir, "records", PersistedAssignmentRecordSchema);
  }

  private readArtifacts(): Promise<CollectionRead<PersistedAssignmentArtifactRecord>> {
    return this.readCollection(
      this.artifactsDir,
      "artifacts",
      PersistedAssignmentArtifactRecordSchema,
    );
  }

  private async requireAssignment(assignmentId: string): Promise<PersistedAssignmentRecord> {
    const assignment = await this.getAssignment(assignmentId);
    if (!assignment) throw new AssignmentNotFoundError(assignmentId);
    return assignment;
  }

  private requireRevision(assignment: PersistedAssignmentRecord, expectedRevision: number): void {
    if (assignment.revision === expectedRevision) return;
    throw new AssignmentRevisionConflictError(assignment.id, expectedRevision, assignment.revision);
  }

  private requireHealthyCollection(issues: AssignmentRepositoryFileIssue[]): void {
    const invalidRecords = issues.filter((issue) => issue.kind === "invalid_record");
    if (invalidRecords.length > 0) throw new AssignmentStorageCorruptError(invalidRecords);
  }

  private async readCollection<TRecord extends { id: string }>(
    dir: string,
    collection: AssignmentRepositoryCollection,
    schema: z.ZodType<TRecord>,
  ): Promise<CollectionRead<TRecord>> {
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const records: TRecord[] = [];
    const issues: AssignmentRepositoryFileIssue[] = [];
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
    collection: AssignmentRepositoryCollection,
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
      throw new AssignmentStorageCorruptError([
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

  private publish(change: AssignmentRepositoryChange): void {
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

function compareAssignmentsNewestFirst(
  left: PersistedAssignmentRecord,
  right: PersistedAssignmentRecord,
): number {
  const createdAtOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return createdAtOrder || right.id.localeCompare(left.id);
}

function compareArtifactsNewestFirst(
  left: PersistedAssignmentArtifactRecord,
  right: PersistedAssignmentArtifactRecord,
): number {
  const createdAtOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return createdAtOrder || right.id.localeCompare(left.id);
}

function normalizeArtifactPageLimit(limit: number | undefined): number {
  if (limit === undefined) return ASSIGNMENT_ARTIFACT_PAGE_DEFAULT_LIMIT;
  const isValid =
    Number.isInteger(limit) && limit > 0 && limit <= ASSIGNMENT_ARTIFACT_PAGE_MAX_LIMIT;
  if (!isValid) {
    throw new AssignmentArtifactPageError(
      `Artifact page limit must be between 1 and ${ASSIGNMENT_ARTIFACT_PAGE_MAX_LIMIT}`,
    );
  }
  return limit;
}

function encodeArtifactCursor(artifact: PersistedAssignmentArtifactRecord): string {
  const cursor: AssignmentArtifactCursor = {
    assignmentId: artifact.assignmentId,
    createdAt: artifact.createdAt,
    id: artifact.id,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeArtifactCursor(token: string, assignmentId: string): AssignmentArtifactCursor {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const cursor = AssignmentArtifactCursorSchema.parse(JSON.parse(decoded));
    if (cursor.assignmentId !== assignmentId) {
      throw new AssignmentArtifactPageError("Artifact cursor does not match the Assignment filter");
    }
    return cursor;
  } catch (error) {
    if (error instanceof AssignmentArtifactPageError) throw error;
    throw new AssignmentArtifactPageError("Invalid Artifact cursor");
  }
}

function isArtifactAfterCursor(
  artifact: PersistedAssignmentArtifactRecord,
  cursor: AssignmentArtifactCursor,
): boolean {
  const artifactCreatedAt = Date.parse(artifact.createdAt);
  const cursorCreatedAt = Date.parse(cursor.createdAt);
  if (artifactCreatedAt < cursorCreatedAt) return true;
  if (artifactCreatedAt > cursorCreatedAt) return false;
  return artifact.id < cursor.id;
}

function requireAssignmentId(assignmentId: string): void {
  if (!PersistedAssignmentIdSchema.safeParse(assignmentId).success) {
    throw new AssignmentRepositoryIdError(assignmentId);
  }
}

function requireArtifactId(artifactId: string): void {
  if (!PersistedAssignmentArtifactIdSchema.safeParse(artifactId).success) {
    throw new AssignmentRepositoryIdError(artifactId);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
