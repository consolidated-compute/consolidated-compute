import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { hostPersistenceBoundaryKey } from "../persistence-mutation.js";
import {
  generateAssignmentArtifactId,
  type PersistedAssignmentArtifactRecord,
  type PersistedAssignmentRecord,
} from "./model.js";
import {
  AssignmentArtifactConflictError,
  AssignmentArtifactPageError,
  AssignmentRepository,
  AssignmentRevisionConflictError,
  AssignmentStateConflictError,
  type AssignmentRepositoryOptions,
  type AssignmentRepositoryChange,
  type CreateAssignmentArtifactInput,
  type CreateAssignmentInput,
} from "./repository.js";

const firstTimestamp = "2026-08-27T12:00:00.000Z";
const secondTimestamp = "2026-08-27T12:01:00.000Z";
const thirdTimestamp = "2026-08-27T12:02:00.000Z";

function createRepository(
  options: Omit<AssignmentRepositoryOptions, "activeRunStore">,
): AssignmentRepository {
  return new AssignmentRepository({
    ...options,
    activeRunStore: {
      persistenceBoundaryKey: hostPersistenceBoundaryKey(options.paseoHome),
      async getActiveRunForAssignment() {
        return null;
      },
    },
  });
}

function createAssignmentInput(): CreateAssignmentInput {
  return {
    title: "Implement Assignment persistence",
    objective: "Persist durable intent without mirroring the linked tracker record.",
    workItem: {
      sourceId: "github:consolidated-compute/consolidated-compute",
      sourceLabel: "GitHub",
      resourceType: "issue",
      resourceId: "67",
      identifier: "#67",
      title: "Assignments: persist intent and immutable Artifacts atomically",
      url: "https://github.com/consolidated-compute/consolidated-compute/issues/67",
    },
  };
}

function createArtifactInput(
  assignment: PersistedAssignmentRecord,
  overrides: Partial<CreateAssignmentArtifactInput> = {},
): CreateAssignmentArtifactInput {
  const content = "## Result\n\nAssignment persistence is implemented and verified.";
  return {
    id: generateAssignmentArtifactId(),
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    kind: "implementation",
    title: "Implementation result",
    mediaType: "text/markdown",
    content,
    includedBytes: Buffer.byteLength(content, "utf8"),
    originalBytes: Buffer.byteLength(content, "utf8"),
    truncated: false,
    producer: {
      kind: "team_run_step",
      teamRunId: "trun_0123456789abcdef",
      stepId: "step_implement",
      roleId: "role_builder",
      agentId: "28c954c9-f75c-49d6-8477-900c99a6dc0b",
      turnId: "turn-1",
    },
    ...overrides,
  };
}

describe("AssignmentRepository", () => {
  let paseoHome: string;
  let currentTimestamp: string;
  let repository: AssignmentRepository;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "assignment-repository-test-"));
    currentTimestamp = firstTimestamp;
    repository = createRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
    });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("creates, lists, and reloads one Assignment record per file", async () => {
    const created = await repository.createAssignment(createAssignmentInput());

    expect(created).toMatchObject({
      id: expect.stringMatching(/^asgn_[0-9a-f]{16}$/),
      revision: 1,
      state: { status: "open" },
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    });
    const stored = JSON.parse(
      await readFile(join(paseoHome, "assignments", "records", `${created.id}.json`), "utf8"),
    );
    expect(stored).toEqual(created);

    const reloaded = createRepository({ paseoHome });
    await expect(reloaded.getAssignment(created.id)).resolves.toEqual(created);
    await expect(reloaded.listAssignments()).resolves.toEqual({
      assignments: [created],
      issues: [],
    });
  });

  test("serializes concurrent patches and rejects the stale revision", async () => {
    const created = await repository.createAssignment(createAssignmentInput());
    currentTimestamp = secondTimestamp;
    const peer = createRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
    });

    const outcomes = await Promise.allSettled([
      repository.patchAssignment({
        assignmentId: created.id,
        expectedRevision: 1,
        patch: { title: "First patch" },
      }),
      peer.patchAssignment({
        assignmentId: created.id,
        expectedRevision: 1,
        patch: { objective: "Second patch" },
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "assignment_revision_conflict",
        expectedRevision: 1,
        actualRevision: 2,
      }),
    });
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      AssignmentRevisionConflictError,
    );
  });

  test("uses explicit terminal transitions and keeps terminal records readable", async () => {
    const created = await repository.createAssignment(createAssignmentInput());
    currentTimestamp = secondTimestamp;
    const completed = await repository.completeAssignment({
      assignmentId: created.id,
      expectedRevision: 1,
    });

    expect(completed).toEqual({
      ...created,
      revision: 2,
      state: { status: "completed", completedAt: secondTimestamp },
      updatedAt: secondTimestamp,
    });
    await expect(
      repository.patchAssignment({
        assignmentId: created.id,
        expectedRevision: 2,
        patch: { title: "Cannot edit terminal intent" },
      }),
    ).rejects.toBeInstanceOf(AssignmentStateConflictError);
    await expect(
      repository.cancelAssignment({ assignmentId: created.id, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "assignment_state_conflict", status: "completed" });
    await expect(createRepository({ paseoHome }).getAssignment(created.id)).resolves.toEqual(
      completed,
    );

    const canceledSource = await repository.createAssignment({
      ...createAssignmentInput(),
      title: "Assignment to cancel",
    });
    currentTimestamp = thirdTimestamp;
    await expect(
      repository.cancelAssignment({
        assignmentId: canceledSource.id,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      revision: 2,
      state: { status: "canceled", canceledAt: thirdTimestamp },
      updatedAt: thirdTimestamp,
    });
  });

  test("reports unknown and corrupt Assignment files without hiding healthy records", async () => {
    const healthy = await repository.createAssignment(createAssignmentInput());
    const recordsDir = join(paseoHome, "assignments", "records");
    await writeFile(join(recordsDir, "broken.json"), "{", "utf8");
    await mkdir(join(recordsDir, "unexpected"));

    const listed = await repository.listAssignments();

    expect(listed.assignments).toEqual([healthy]);
    expect(listed.issues).toEqual([
      expect.objectContaining({ fileName: "broken.json", kind: "invalid_record" }),
      expect.objectContaining({ fileName: "unexpected", kind: "unknown_file" }),
    ]);
  });

  test("retains the previous record and event boundary when an atomic update is interrupted", async () => {
    const changes: AssignmentRepositoryChange[] = [];
    let interruptNextWrite = false;
    repository = createRepository({
      paseoHome,
      now: () => new Date(firstTimestamp),
      writeJson: async (filePath, value) => {
        if (interruptNextWrite) {
          await writeFile(`${filePath}.interrupted.tmp`, '{"partial":', "utf8");
          throw new Error("simulated interruption before rename");
        }
        await writeJsonFileAtomic(filePath, value);
      },
    });
    repository.subscribe((change) => changes.push(change));
    const created = await repository.createAssignment(createAssignmentInput());
    interruptNextWrite = true;

    await expect(
      repository.patchAssignment({
        assignmentId: created.id,
        expectedRevision: 1,
        patch: { title: "Incomplete update" },
      }),
    ).rejects.toThrow("simulated interruption before rename");
    await expect(createRepository({ paseoHome }).getAssignment(created.id)).resolves.toEqual(
      created,
    );
    expect(changes).toEqual([{ type: "assignment_created", assignment: created }]);
  });

  test("creates immutable Artifacts without changing the Assignment revision", async () => {
    const assignment = await repository.createAssignment(createAssignmentInput());
    currentTimestamp = secondTimestamp;
    const input = createArtifactInput(assignment);
    const artifact = await repository.createArtifact(input);

    expect(artifact).toEqual({ ...input, createdAt: secondTimestamp });
    await expect(repository.getAssignment(assignment.id)).resolves.toEqual(assignment);
    await expect(createRepository({ paseoHome }).getArtifact(artifact.id)).resolves.toEqual(
      artifact,
    );

    currentTimestamp = thirdTimestamp;
    await repository.completeAssignment({ assignmentId: assignment.id, expectedRevision: 1 });
    await expect(repository.getArtifact(artifact.id)).resolves.toEqual(artifact);
  });

  test("coalesces concurrent identical Artifact creates and publishes once", async () => {
    const assignment = await repository.createAssignment(createAssignmentInput());
    currentTimestamp = secondTimestamp;
    const input = createArtifactInput(assignment);
    const changes: AssignmentRepositoryChange[] = [];
    const peer = createRepository({
      paseoHome,
      now: () => new Date(currentTimestamp),
    });
    repository.subscribe((change) => changes.push(change));
    peer.subscribe((change) => changes.push(change));

    const [first, second] = await Promise.all([
      repository.createArtifact(input),
      peer.createArtifact(input),
    ]);

    expect(first).toEqual(second);
    expect(changes).toEqual([{ type: "artifact_created", artifact: first }]);
    await expect(repository.listArtifacts({ assignmentId: assignment.id })).resolves.toMatchObject({
      artifacts: [first],
      issues: [],
    });
  });

  test("rejects conflicting reuse of an Artifact ID without overwriting it", async () => {
    const assignment = await repository.createAssignment(createAssignmentInput());
    const input = createArtifactInput(assignment);
    const created = await repository.createArtifact(input);

    currentTimestamp = thirdTimestamp;
    await expect(repository.createArtifact(input)).resolves.toEqual(created);
    await expect(
      repository.createArtifact({ ...input, title: "Different immutable content" }),
    ).rejects.toBeInstanceOf(AssignmentArtifactConflictError);
    await expect(repository.getArtifact(created.id)).resolves.toEqual(created);
  });

  test("lists Artifacts newest-first with stable Assignment-scoped cursors", async () => {
    const assignment = await repository.createAssignment(createAssignmentInput());
    const otherAssignment = await repository.createAssignment({
      ...createAssignmentInput(),
      title: "Other Assignment",
    });
    const created: PersistedAssignmentArtifactRecord[] = [];
    for (const timestamp of [firstTimestamp, secondTimestamp, thirdTimestamp]) {
      currentTimestamp = timestamp;
      created.push(await repository.createArtifact(createArtifactInput(assignment)));
    }
    await repository.createArtifact(createArtifactInput(otherAssignment));

    const firstPage = await repository.listArtifacts({ assignmentId: assignment.id, limit: 2 });
    expect(firstPage.artifacts).toEqual([created[2], created[1]]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await repository.listArtifacts({
      assignmentId: assignment.id,
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.artifacts).toEqual([created[0]]);
    expect(secondPage.nextCursor).toBeNull();

    await expect(
      repository.listArtifacts({
        assignmentId: otherAssignment.id,
        cursor: firstPage.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(AssignmentArtifactPageError);
  });

  test("reports corrupt Artifact files while retaining healthy results", async () => {
    const assignment = await repository.createAssignment(createAssignmentInput());
    const healthy = await repository.createArtifact(createArtifactInput(assignment));
    const artifactsDir = join(paseoHome, "assignments", "artifacts");
    await writeFile(join(artifactsDir, "broken.json"), "not-json", "utf8");
    await writeFile(join(artifactsDir, ".interrupted.tmp"), "partial", "utf8");

    const listed = await repository.listArtifacts({ assignmentId: assignment.id });

    expect(listed.artifacts).toEqual([healthy]);
    expect(listed.issues).toEqual([
      expect.objectContaining({ fileName: ".interrupted.tmp", kind: "unknown_file" }),
      expect.objectContaining({ fileName: "broken.json", kind: "invalid_record" }),
    ]);
  });
});
